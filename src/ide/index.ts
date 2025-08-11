/**
 * IDE Module
 * 
 * Provides IDE-related functionality including LSP support, code completion, and diagnostics.
 * Currently implements file operations and prepares for future LSP integration.
 */

import type { Router } from '../server/router.js';
import { registerIDERoutes } from './handlers.js';
import type { ServerWebSocket } from '../server/websocket.js';

// Register HTTP routes
export function registerRoutes(router: Router): void {
  registerIDERoutes(router);
}

// WebSocket message handlers
export async function handleWebSocketMessage(
  ws: ServerWebSocket,
  message: any
): Promise<void> {
  const { type, payload } = message;

  switch (type) {
    case 'ide:lsp_init':
      ws.send(JSON.stringify({
        type: 'ide:lsp_initialized',
        payload: { language: payload.language, status: 'ready' }
      }));
      break;

    case 'ide:lsp:auto_start': {
      const { rootPath } = payload || {};
      if (!rootPath) return;
      const { detectLanguages } = await import('./language-detection.js');
      const { lspManager } = await import('./lsp-manager.js');
      const langs = await detectLanguages(rootPath);
      console.log(`[IDE] Auto-start LSP for`, rootPath, 'languages=', langs.join(',') || '(none)');
      await Promise.all(langs.map(lang => lspManager.getOrStartServer(lang, rootPath).catch((e) => {
        console.error(`[LSP] Failed to start ${lang} for`, rootPath, e);
        return undefined;
      })));
      ws.send(JSON.stringify({
        type: 'ide:lsp:auto_started',
        payload: { rootPath, languages: langs },
      }));
      break;
    }

    case 'ide:lsp_completion':
      // Request code completion
      // TODO: Forward to LSP and return completions
      ws.send(JSON.stringify({
        type: 'ide:completions',
        payload: {
          items: [
            // Mock completions for now
            { label: 'console', kind: 'method', detail: 'console.log' },
            { label: 'function', kind: 'keyword', detail: 'function declaration' },
            { label: 'const', kind: 'keyword', detail: 'const declaration' },
          ]
        }
      }));
      break;

    case 'ide:lsp_hover':
      // Request hover information
      // TODO: Forward to LSP
      ws.send(JSON.stringify({
        type: 'ide:hover_info',
        payload: {
          contents: 'Hover information would appear here',
          range: payload.position
        }
      }));
      break;

    case 'ide:lsp_diagnostics':
      // Request diagnostics for a file
      // TODO: Get from LSP
      ws.send(JSON.stringify({
        type: 'ide:diagnostics',
        payload: {
          diagnostics: []
        }
      }));
      break;

    case 'ide:lsp:did_open': {
      try {
        const { rootPath, uri, languageId, text, version } = payload || {};
        if (!rootPath || !uri) break;
        const { URI } = await import('vscode-uri');
        const absPath: string = URI.parse(uri).fsPath;
        const { lspManager } = await import('./lsp-manager.js');
        lspManager.notifyDidOpen(rootPath, absPath, languageId || 'plaintext', text || '', typeof version === 'number' ? version : 1);
      } catch (e) {
        console.error('[IDE] did_open handler failed', e);
      }
      break;
    }

    case 'ide:lsp:did_change': {
      try {
        const { rootPath, uri, text, version } = payload || {};
        if (!rootPath || !uri) break;
        const { URI } = await import('vscode-uri');
        const absPath: string = URI.parse(uri).fsPath;
        const { lspManager } = await import('./lsp-manager.js');
        lspManager.notifyDidChange(rootPath, absPath, text || '', typeof version === 'number' ? version : 1);
      } catch (e) {
        console.error('[IDE] did_change handler failed', e);
      }
      break;
    }

    case 'ide:lsp:did_save': {
      try {
        const { uri } = payload || {};
        if (!uri) break;
        const { URI } = await import('vscode-uri');
        const absPath: string = URI.parse(uri).fsPath;
        const { lspManager } = await import('./lsp-manager.js');
        lspManager.notifyDidSave(absPath);
      } catch (e) {
        console.error('[IDE] did_save handler failed', e);
      }
      break;
    }

    case 'ide:lsp:did_close': {
      try {
        const { rootPath, uri } = payload || {};
        if (!rootPath || !uri) break;
        const { URI } = await import('vscode-uri');
        const absPath: string = URI.parse(uri).fsPath;
        const { lspManager } = await import('./lsp-manager.js');
        lspManager.notifyDidClose(rootPath, absPath);
      } catch (e) {
        console.error('[IDE] did_close handler failed', e);
      }
      break;
    }

    case 'ide:lsp_definition':
      // Go to definition
      // TODO: Forward to LSP
      ws.send(JSON.stringify({
        type: 'ide:definition',
        payload: {
          uri: payload.path,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
        }
      }));
      break;
  }
}

export * from './types.js';
export * from './lsp-manager.js';