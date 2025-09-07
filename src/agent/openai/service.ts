/**
 * OpenAI (GPT-5) Service
 * Manages sessions, streams, tools, and approvals for the OpenAI provider.
 */

import OpenAI from 'openai';
import { logger } from '../../shared/logger';
import type { ServerMessage } from '../anthropic/types';
import { loadProjectContext } from '../context/loader';
import { generateConversationTitle } from '../core/title';
import { sessionStoreFs } from '../store/session-store-fs';
import { processOpenAIStream } from './streaming.js';
import { openaiTools } from './tools/index.js';

interface OpenAISessionState {
  id: string;
  workingDir: string;
  maxMode: boolean;
  previousResponseId?: string | null;
  lastActivity: Date;
  title: string;
  titleGenerated?: boolean;
  pendingTools: Record<string, { name: string; input: any; responseId?: string; approved?: boolean; output?: string; isError?: boolean }>;
  projectContext?: {
    source: 'AGENTS.md' | 'CLAUDE.md';
    path: string;
    content: string;
  };
}

class OpenAIServiceImpl {
  private client: OpenAI | null = null;
  private sessions = new Map<string, OpenAISessionState>();
  private abortFlags = new Map<string, boolean>();
  private streamControllers = new Map<string, AbortController | undefined>();

  // Map provider tool names+inputs to canonical UI types used by the mobile app
  private mapUiForTool(providerName: string, input: any): { uiName: string; uiInput: any } {
    switch (providerName) {
      case 'execute_command':
        return { uiName: 'bash', uiInput: { command: input?.command } };
      case 'edit_in_file': {
        return {
          uiName: 'str_replace_based_edit_tool',
          uiInput: { command: 'str_replace', path: input?.path, old_str: input?.old, new_str: input?.new, replace_all: !!input?.replace_all }
        };
      }
      case 'append_to_file':
        // Render as a diff-like UI with only an Added block
        return { uiName: 'str_replace_based_edit_tool', uiInput: { command: 'str_replace', path: input?.path, old_str: '', new_str: input?.text } };
      case 'read_file':
        return { uiName: 'str_replace_based_edit_tool', uiInput: { command: 'view', path: input?.path } };
      case 'write_file':
        return { uiName: 'str_replace_based_edit_tool', uiInput: { command: 'create', path: input?.path } };
      case 'list_files':
      case 'search_files':
        return { uiName: 'str_replace_based_edit_tool', uiInput: { command: 'view', path: input?.path, query: input?.query } };
      case 'search_repo':
        // Render with a dedicated search results component on mobile
        return { uiName: 'repo_search', uiInput: { query: input?.query, path: input?.path || '' } } as any;
      case 'work_plan':
        return { uiName: 'work_plan', uiInput: input };
      default:
        return { uiName: providerName, uiInput: input };
    }
  }

  // Format raw tool outputs into the mobile-friendly text that existing components expect
  private formatOutputForUi(providerName: string, raw: any): string {
    try {
      // read_file: unwrap to plain file content
      if (providerName === 'read_file') {
        if (typeof raw === 'string') return raw;
        if (raw && typeof raw === 'object') {
          // Common shapes: { content: string } or { value: { content } }
          if (typeof (raw as any).content === 'string') return (raw as any).content;
          if ((raw as any).value && typeof (raw as any).value.content === 'string') return (raw as any).value.content;
        }
        return typeof raw === 'undefined' ? '' : String(typeof raw === 'object' ? JSON.stringify(raw) : raw);
      }

      // list_files: format as simple directory listing with [d]/[f] prefixes
      if (providerName === 'list_files') {
        const nodes: any[] = Array.isArray(raw)
          ? raw
          : (raw && typeof raw === 'object' && Array.isArray((raw as any).nodes) ? (raw as any).nodes : []);
        const sorted = [...nodes].sort((a, b) => {
          const ad = (a?.type === 'directory') ? 0 : 1;
          const bd = (b?.type === 'directory') ? 0 : 1;
          if (ad !== bd) return ad - bd;
          const an = (a?.name || '').toLowerCase();
          const bn = (b?.name || '').toLowerCase();
          return an.localeCompare(bn);
        });
        const lines: string[] = ['Directory contents:'];
        for (const n of sorted) {
          const isDir = (n?.type === 'directory');
          const name = n?.name || n?.path || '';
          const prefix = isDir ? '[d]' : '[f]';
          lines.push(`${prefix} ${name}`);
        }
        return lines.join('\n');
      }

      // search_files: present grep-like results
      if (providerName === 'search_files') {
        const arr: any[] = Array.isArray(raw) ? raw : [];
        if (arr.length === 0) return 'No results found';
        const lines: string[] = [`Search results (${arr.length}):`];
        for (const r of arr) {
          const prefix = r?.type === 'directory' ? '[d]' : '[f]';
          const name = r?.name || r?.path || '';
          lines.push(`${prefix} ${name}`);
        }
        return lines.join('\n');
      }

      // search_repo: return structured JSON as-is (stringify for transport)
      if (providerName === 'search_repo') {
        return typeof raw === 'string' ? raw : JSON.stringify(raw);
      }

      // Default: stringify objects; pass through strings
      if (typeof raw === 'string') return raw;
      return JSON.stringify(raw);
    } catch (e) {
      return typeof raw === 'string' ? raw : JSON.stringify(raw);
    }
  }

  private initClient(apiKey: string): OpenAI {
    if (!this.client || (this.client as any)._apiKey !== apiKey) {
      const c = new OpenAI({ apiKey });
      (c as any)._apiKey = apiKey; // cache key for reuse
      this.client = c;
      logger.info('OpenAI', 'Initialized OpenAI client');
    }
    return this.client;
  }

  private async runAutoApproveCycle(
    sessionId: string,
    apiKey: string,
    onMessage: (m: ServerMessage) => void
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || !state.maxMode) return;

    // Group pending tools by responseId (falling back to previousResponseId)
    const groups: Record<string, string[]> = {};
    for (const [id, p] of Object.entries(state.pendingTools)) {
      const rid = p.responseId || state.previousResponseId || 'unknown';
      if (!groups[rid]) groups[rid] = [];
      groups[rid].push(id);
    }
    for (const [rid, ids] of Object.entries(groups)) {
      if (!ids || ids.length === 0) continue;
      // Auto-approve all
      for (const id of ids) {
        const p = state.pendingTools[id];
        if (p) p.approved = true;
      }
      await this.executeAndContinueGroup(sessionId, rid, ids, apiKey, onMessage);
    }
  }

  private async executeAndContinueGroup(
    sessionId: string,
    responseIdForCall: string,
    ids: string[],
    apiKey: string,
    onMessage: (m: ServerMessage) => void
  ): Promise<void> {
    const state = this.sessions.get(sessionId)!;
    const outputs: Array<{ call_id: string; output: string }> = [];
    for (const id of ids) {
      const pending = state.pendingTools[id];
      if (!pending) continue;
      if (pending.approved === true) {
        let toolOutputString = '';
        try {
          const fn = (openaiTools as any)[pending.name];
          if (typeof fn !== 'function') throw new Error(`Unknown tool: ${pending.name}`);
          const output = await fn(pending.input, { workingDir: state.workingDir, sessionId });
          toolOutputString = this.formatOutputForUi(pending.name, output);
          pending.output = toolOutputString;
          pending.isError = false;
          logger.agent('openai:tool_executed', sessionId, { id, name: pending.name, workingDir: state.workingDir });
          const mapped = this.mapUiForTool(pending.name, pending.input);
          // For append_to_file, suppress the status line in the UI by sending empty content
          const displayContent = pending.name === 'append_to_file' ? '' : toolOutputString;
          onMessage({
            type: 'agent:tool_output',
            sessionId,
            content: displayContent,
            message: {
              id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
              type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: displayContent, is_error: false }],
              model: '', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
            } as any,
            toolOutput: { id, tool_use_id: id, name: mapped.uiName, output: toolOutputString, isError: false, input: mapped.uiInput },
          } as any);
        } catch (err: any) {
          toolOutputString = `Error: ${err.message}`;
          pending.output = toolOutputString;
          pending.isError = true;
          logger.error('OpenAI', 'Tool execution failed', { sessionId, id, name: pending.name, error: err.message });
          const mappedErr = this.mapUiForTool(pending.name, pending.input);
          onMessage({
            type: 'agent:tool_output',
            sessionId,
            content: toolOutputString,
            message: {
              id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
              type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: toolOutputString, is_error: true }],
              model: '', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
            } as any,
            toolOutput: { id, tool_use_id: id, name: mappedErr.uiName, output: toolOutputString, isError: true, input: mappedErr.uiInput },
          } as any);
        }
        outputs.push({ call_id: id, output: pending.output! });
      } else {
        const rejection = 'Tool use rejected by user';
        pending.output = rejection;
        pending.isError = true;
        const mappedRej = this.mapUiForTool(pending.name, pending.input);
        onMessage({
          type: 'agent:tool_output',
          sessionId,
          content: rejection,
          message: {
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: rejection, is_error: true }],
            model: '', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
          } as any,
          toolOutput: { id, tool_use_id: id, name: mappedRej.uiName, output: rejection, isError: true, input: mappedRej.uiInput },
        } as any);
        outputs.push({ call_id: id, output: rejection });
      }
    }

    // Remove processed ids
    for (const id of ids) delete state.pendingTools[id];

    if (outputs.length === 0) return;

    const client = this.initClient(apiKey);
    const inputContinuation: any[] = outputs.map(o => ({ type: 'function_call_output', call_id: o.call_id, output: o.output }));
    const sendDuringContinuation = (m: ServerMessage) => {
      if (m.type === 'agent:tool_request' && (m as any).toolRequest) {
        const tr = (m as any).toolRequest as { id: string; name: string; providerName?: string; input: any; responseId?: string };
        (state.pendingTools as any)[tr.id] = { name: (tr.providerName || tr.name), input: tr.input, responseId: tr.responseId };
      }
      onMessage(m);
    };
    onMessage({ type: 'agent:status', sessionId, phase: 'continuing' } as any);
    this.abortFlags.set(sessionId, false);
    const controller2 = new AbortController();
    this.streamControllers.set(sessionId, controller2);
    const contResult = await processOpenAIStream({
      client,
      sessionId,
      content: inputContinuation as any,
      workingDir: state.workingDir,
      maxMode: state.maxMode,
      previousResponseId: responseIdForCall,
      projectContext: state.projectContext
        ? { sourcePath: state.projectContext.path, content: state.projectContext.content }
        : undefined,
      onMessage: sendDuringContinuation,
      abortSignal: controller2.signal,
      shouldAbort: () => !!this.abortFlags.get(sessionId),
    } as any);
    this.streamControllers.delete(sessionId);

    if (contResult?.responseId && contResult.responseId.length > 0) {
      state.previousResponseId = contResult.responseId;
      try { await sessionStoreFs.setPreviousResponseId(sessionId, contResult.responseId); } catch {}
      logger.agent('openai:prev_response_id', sessionId, { previousResponseId: contResult.responseId });
    }

    await this.runAutoApproveCycle(sessionId, apiKey, onMessage);
  }

  private getOrCreateSession(sessionId: string, workingDir: string, maxMode: boolean): OpenAISessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { id: sessionId, workingDir, maxMode, previousResponseId: null, lastActivity: new Date(), title: 'New Chat', pendingTools: {} };
      this.sessions.set(sessionId, s);
    }
    s.workingDir = workingDir;
    s.maxMode = maxMode;
    s.lastActivity = new Date();
    return s;
  }

  async processMessage(message: any, apiKey: string, onMessage: (m: ServerMessage) => void): Promise<void> {
    const { sessionId, content, workingDir = process.cwd(), maxMode = false } = message;
    logger.agent('openai:message_in', sessionId, { hasContent: !!content, workingDir, maxMode });
    if (!content) {
      onMessage({ type: 'agent:error', sessionId, error: 'No message content provided' } as any);
      return;
    }
    const state = this.getOrCreateSession(sessionId, workingDir, maxMode);
    // Title generation on first message using Anthropic-based core generator
    if (!state.titleGenerated) {
      try {
        const title = await generateConversationTitle(typeof content === 'string' ? content : JSON.stringify(content));
        state.title = title || 'New Chat';
        state.titleGenerated = true;
        try { await (await import('../store/session-store-fs.js')).sessionStoreFs.updateTitle(sessionId, state.title); } catch {}
        onMessage({ type: 'agent:title', sessionId, title: state.title } as any);
      } catch {}
    }
    const client = this.initClient(apiKey);

    // Resolve project context once per session (prefer AGENTS.md for OpenAI)
    try {
      if (!state.projectContext) {
        const ctx = await loadProjectContext(workingDir, { preferred: 'agents' });
        if (ctx) {
          state.projectContext = { source: ctx.source, path: ctx.path, content: ctx.content } as any;
        }
      }
    } catch {}

    // Wrap onMessage to capture tool requests for later approvals
    const send = (m: ServerMessage) => {
      if (m.type === 'agent:tool_request' && (m as any).toolRequest) {
        const tr = (m as any).toolRequest as { id: string; name: string; providerName?: string; input: any; responseId?: string };
        // Store provider tool name for execution; UI receives canonical name via STREAM adapter
        state.pendingTools[tr.id] = { name: (tr.providerName || tr.name), input: tr.input, responseId: tr.responseId } as any;
      }
      onMessage(m);
    };

    // Record user message in session snapshot for authoritative conversation state
    try {
      await sessionStoreFs.recordUserMessage(sessionId, typeof content === 'string' ? content : JSON.stringify(content), { workingDir, maxMode });
    } catch {}

    // Build minimal input: only the latest user message
    const userText: string = typeof content === 'string' ? content : JSON.stringify(content);
    const historyInput: Array<{ role: 'user'; content: string }> = [{ role: 'user', content: userText }];

    // Pass previous_response_id when available
    const { previousResponseId } = state;
    const validPrev = previousResponseId || undefined;

    // Stream via Responses API and normalize to our events
    // Reset and attach abort controller for this turn
    this.abortFlags.set(sessionId, false);
    const controller = new AbortController();
    this.streamControllers.set(sessionId, controller);
    const result = await processOpenAIStream({
      client,
      sessionId,
      content: historyInput as any,
      workingDir,
      maxMode,
      previousResponseId: validPrev,
      projectContext: state.projectContext
        ? { sourcePath: state.projectContext.path, content: state.projectContext.content }
        : undefined,
      onMessage: send,
      abortSignal: controller.signal,
      shouldAbort: () => !!this.abortFlags.get(sessionId),
    } as any);
    this.streamControllers.delete(sessionId);

    // Track prev response id for reasoning persistence (accept any non-empty id)
    if (result?.responseId && result.responseId.length > 0) {
      state.previousResponseId = result.responseId;
      try { await sessionStoreFs.setPreviousResponseId(sessionId, result.responseId); } catch {}
      logger.agent('openai:prev_response_id', sessionId, { previousResponseId: result.responseId });
    }

    // Auto-approve and execute any pending tools in Max Mode
    await this.runAutoApproveCycle(sessionId, apiKey, onMessage);
  }

  async processToolResponse(message: any, apiKey: string, onMessage: (m: ServerMessage) => void): Promise<void> {
    const { sessionId, toolResponse } = message;
    logger.agent('openai:tool_response_in', sessionId, { toolResponse });
    if (!toolResponse) {
      onMessage({ type: 'agent:error', sessionId, error: 'No tool response provided' } as any);
      return;
    }
    const state = this.sessions.get(sessionId);
    if (!state) {
      onMessage({ type: 'agent:error', sessionId, error: 'Session not found' } as any);
      return;
    }
    const { id, approved } = toolResponse as { id: string; approved: boolean };
    const pending = state.pendingTools[id] as any;
    if (!pending) {
      onMessage({ type: 'agent:error', sessionId, error: 'Tool request not found' } as any);
      logger.error('OpenAI', 'Pending tool not found', { sessionId, id });
      return;
    }
    // Record approval and check if the whole group is decided
    pending.approved = !!approved;
    const responseIdForCall: string | undefined = pending?.responseId || state.previousResponseId || undefined;
    if (!responseIdForCall) {
      onMessage({ type: 'agent:error', sessionId, error: 'Missing previous_response_id for continuation' } as any);
      logger.error('OpenAI', 'Missing previous_response_id for continuation', { sessionId });
      return;
    }
    const groupIds = Object.entries(state.pendingTools)
      .filter(([_, v]) => (v.responseId || state.previousResponseId) === responseIdForCall)
      .map(([k]) => k);
    const allDecided = groupIds.every((gid) => typeof state.pendingTools[gid].approved === 'boolean');
    if (!allDecided) {
      onMessage({ type: 'agent:status', sessionId, phase: 'awaiting_tool' } as any);
      logger.agent('openai:awaiting_more_approvals', sessionId, { responseIdSuffix: responseIdForCall.slice(-8), decided: groupIds.filter(g => typeof state.pendingTools[g].approved === 'boolean').length, total: groupIds.length });
      return;
    }
    await this.executeAndContinueGroup(sessionId, responseIdForCall, groupIds, apiKey, onMessage);
  }

  stopStream(sessionId: string): void {
    try {
      this.abortFlags.set(sessionId, true);
      const c = this.streamControllers.get(sessionId);
      if (c) {
        try { c.abort(); } catch {}
      }
      // Clear any pending tools for the current (possibly partial) turn
      const s = this.sessions.get(sessionId);
      if (s) {
        s.pendingTools = {} as any;
      }
    } catch {}
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

export const openAIService = new OpenAIServiceImpl();
