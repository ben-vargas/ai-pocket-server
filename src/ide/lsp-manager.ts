/**
 * LSP Manager
 *
 * Real Language Server Protocol manager using vscode-jsonrpc &
 * vscode-languageserver-protocol over stdio transports.
 */

import { URI } from 'vscode-uri';
import {
  InitializeRequest,
  InitializedNotification,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidSaveTextDocumentNotification,
  DidCloseTextDocumentNotification,
  PublishDiagnosticsNotification,
  type InitializeParams,
  type PublishDiagnosticsParams,
} from 'vscode-languageserver-protocol';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import { Readable, Writable } from 'node:stream';
import { resolve } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { LSPConfig, LSPStatus } from './types.js';
import { wsManager } from '../server/websocket.js';
import { logger } from '../shared/logger.js';

/** Compose a stable key for server instances */
function keyOf(language: string, rootPath: string): string {
  return `${language}::${resolve(rootPath)}`;
}

// Workspace-level diagnostic summaries removed; keep per-file only

class LanguageServer {
  readonly config: LSPConfig;
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: MessageConnection | null = null;
  private diagnosticsByUri = new Map<string, PublishDiagnosticsParams>();
  status: LSPStatus['status'] = 'stopped';

  constructor(config: LSPConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    this.status = 'starting';

    // Spawn LS with stdio
    const child = spawn(this.config.command, this.config.args || [], {
      cwd: this.config.rootPath,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    console.log(`[LSP] Spawned ${this.config.language} server:`, this.config.command, (this.config.args || []).join(' '), 'cwd=', this.config.rootPath);
    this.child = child;

    // Use Node.js streams directly
    const nodeStdout = child.stdout;
    const nodeStdin = child.stdin;

    const reader = new StreamMessageReader(nodeStdout as any);
    const writer = new StreamMessageWriter(nodeStdin as any);
    const connection = createMessageConnection(reader, writer);
    this.connection = connection;

    // Log LS stderr for debugging
    child.stderr.on('data', (chunk) => {
      const text = chunk?.toString?.() ?? '';
      if (text && text.trim().length) {
        console.error(`[LSP:${this.config.language} stderr]`, text.trim());
      }
    });


    // Diagnostics
    connection.onNotification('textDocument/publishDiagnostics', (params: PublishDiagnosticsParams) => {
      this.diagnosticsByUri.set(params.uri, params);
      const count = params.diagnostics?.length ?? 0;
      try {
        const sev = { e: 0, w: 0, i: 0, h: 0 };
        for (const d of params.diagnostics) {
          switch (d.severity) {
            case 1: sev.e++; break;
            case 2: sev.w++; break;
            case 3: sev.i++; break;
            case 4: sev.h++; break;
          }
        }
        logger.debug('LSP diagnostics', `${this.config.language}`, { uri: params.uri, total: count, sev });
      } catch {}
      this.broadcastFileDiagnostics(params);
    });

    connection.listen();

    // Initialize
    const rootUri = URI.file(this.config.rootPath).toString();
    const initializeParams: InitializeParams = {
      processId: process.pid,
      rootUri,
      capabilities: {},
      workspaceFolders: [{ name: this.config.rootPath, uri: rootUri }],
      initializationOptions: this.config.initializationOptions,
    } as any;

    try {
      await connection.sendRequest('initialize', initializeParams as any);
      connection.sendNotification('initialized', {});
      this.status = 'ready';
      logger.debug('LSP initialized', `${this.config.language}`, { rootPath: this.config.rootPath });
    } catch (e) {
      console.error('[LSP] initialize failed', this.config.language, e);
      throw e;
    }
  }

  async stop(): Promise<void> {
    try {
      this.connection?.dispose();
    } catch {}
    try {
      this.child?.kill();
    } catch {}
    this.connection = null;
    this.child = null;
    this.status = 'stopped';
    this.diagnosticsByUri.clear();
  }

  notifyDidOpen(uri: string, languageId: string, text: string, version: number): void {
    if (!this.connection) return;
    this.connection.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId, version, text },
    });
  }

  notifyDidChange(uri: string, text: string, version: number): void {
    if (!this.connection) return;
    this.connection.sendNotification('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    } as any);
  }

  notifyDidSave(uri: string): void {
    if (!this.connection) return;
    this.connection.sendNotification('textDocument/didSave', {
      textDocument: { uri },
    } as any);
  }

  notifyDidClose(uri: string): void {
    if (!this.connection) return;
    this.connection.sendNotification('textDocument/didClose', {
      textDocument: { uri },
    } as any);
  }

  async getCompletions(uri: string, position: { line: number; character: number }): Promise<any> {
    if (!this.connection) return null;
    try {
      const result = await this.connection.sendRequest('textDocument/completion', {
        textDocument: { uri },
        position,
      });
      return result;
    } catch (error) {
      console.error('[LSP] Completion request failed:', error);
      return null;
    }
  }

  async getHover(uri: string, position: { line: number; character: number }): Promise<any> {
    if (!this.connection) return null;
    try {
      const result = await this.connection.sendRequest('textDocument/hover', {
        textDocument: { uri },
        position,
      });
      return result;
    } catch (error) {
      console.error('[LSP] Hover request failed:', error);
      return null;
    }
  }

  getDiagnostics(uri: string): any {
    // Return cached diagnostics for this URI
    return this.diagnosticsByUri.get(uri)?.diagnostics || [];
  }

  // Workspace summary disabled: no-op stubs kept intentionally
  private broadcastSummary(): void { /* no-op */ }

  private broadcastFileDiagnostics(params: PublishDiagnosticsParams): void {
    wsManager.broadcast({
      v: 1,
      id: crypto.randomUUID(),
      sessionId: 'system',
      ts: new Date().toISOString(),
      type: 'ide:file_diagnostics',
      payload: {
        rootPath: this.config.rootPath,
        language: this.config.language,
        uri: params.uri,
        diagnostics: params.diagnostics,
      },
      timestamp: Date.now(),
    });
  }
}

export class LSPManager {
  private servers = new Map<string, LanguageServer>();

  async getOrStartServer(language: string, rootPath: string): Promise<LanguageServer> {
    const k = keyOf(language, rootPath);
    const existing = this.servers.get(k);
    if (existing && existing.status === 'ready') return existing;

    const config = this.getLanguageConfig(language, rootPath);
    if (!config) throw new Error(`No language server configuration for ${language}`);

    const server = new LanguageServer(config);
    await server.start();
    this.servers.set(k, server);

    return server;
  }

  async stopServer(language: string, rootPath: string): Promise<void> {
    const k = keyOf(language, rootPath);
    const server = this.servers.get(k);
    if (server) {
      await server.stop();
      this.servers.delete(k);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.servers.values()).map(s => s.stop()));
    this.servers.clear();
  }

  notifyDidSave(absPath: string): void {
    const uri = URI.file(absPath).toString();
    // Fan out to all servers for the same root that might care
    for (const server of this.servers.values()) {
      if (uri.startsWith(URI.file(server.config.rootPath).toString())) {
        server.notifyDidSave(uri);
      }
    }
  }

  notifyDidOpen(rootPath: string, absPath: string, languageId: string, text: string, version: number): void {
    const uri = URI.file(absPath).toString();
    let routed = 0;
    for (const server of this.servers.values()) {
      const rootUri = URI.file(server.config.rootPath).toString();
      if (uri.startsWith(rootUri)) {
        server.notifyDidOpen(uri, languageId, text, version);
        routed++;
      }
    }
    if (routed === 0) logger.warn('No LSP server matched for didOpen', 'route_miss', { uri, rootPath });
    else logger.debug('Routed didOpen to LSP servers', 'route', { uri, routed });
  }

  notifyDidChange(rootPath: string, absPath: string, text: string, version: number): void {
    const uri = URI.file(absPath).toString();
    let routed = 0;
    for (const server of this.servers.values()) {
      const rootUri = URI.file(server.config.rootPath).toString();
      if (uri.startsWith(rootUri)) {
        server.notifyDidChange(uri, text, version);
        routed++;
      }
    }
    if (routed === 0) logger.warn('No LSP server matched for didChange', 'route_miss', { uri, rootPath });
    else logger.debug('Routed didChange to LSP servers', 'route', { uri, routed, version });
  }

  notifyDidClose(rootPath: string, absPath: string): void {
    const uri = URI.file(absPath).toString();
    let routed = 0;
    for (const server of this.servers.values()) {
      const rootUri = URI.file(server.config.rootPath).toString();
      if (uri.startsWith(rootUri)) {
        server.notifyDidClose(uri);
        routed++;
      }
    }
    if (routed === 0) logger.warn('No LSP server matched for didClose', 'route_miss', { uri, rootPath });
    else logger.debug('Routed didClose to LSP servers', 'route', { uri, routed });
  }

  private getLanguageConfig(language: string, rootPath: string): LSPConfig | null {
    const configs: Record<string, Omit<LSPConfig, 'rootPath'>> = {
      typescript: { language: 'typescript', command: 'typescript-language-server', args: ['--stdio'] },
      javascript: { language: 'javascript', command: 'typescript-language-server', args: ['--stdio'] },
      eslint: { language: 'eslint', command: 'vscode-eslint-language-server', args: ['--stdio'] },
      python: { language: 'python', command: 'pylsp', args: [] },
      rust: { language: 'rust', command: 'rust-analyzer', args: [] },
      go: { language: 'go', command: 'gopls', args: [] },
      java: { language: 'java', command: 'jdtls', args: [] },
      cpp: { language: 'cpp', command: 'clangd', args: [] },
      c: { language: 'c', command: 'clangd', args: [] },
    };
    const base = configs[language];
    if (!base) return null;
    return { ...base, rootPath };
  }

  // Workspace priming removed
}

export const lspManager = new LSPManager();
