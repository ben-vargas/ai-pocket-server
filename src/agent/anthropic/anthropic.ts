/**
 * Anthropic Service
 * Main service for managing Claude agent sessions and conversations
 */

import Anthropic from '@anthropic-ai/sdk';
import { loadProjectContext } from '../context/loader';
import { generateConversationTitle } from '../core/title';
import { generateSystemPrompt } from './prompt';
import { processStream } from './streaming';
import { bashToolDefinition, executeBash } from './tools/bash';
import { editorToolDefinition, executeEditor } from './tools/editor';
import { executeWebSearch, webSearchToolDefinition } from './tools/web-search';
import { executeWorkPlan, workPlanToolDefinition } from './tools/work-plan';
import type {
  AgentSession,
  ClientMessage,
  ServerMessage,
  ToolResultBlock,
} from './types';

export class AnthropicService {
  private anthropic: Anthropic | null = null;
  private sessions = new Map<string, AgentSession>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start cleanup interval (every minute)
    this.cleanupInterval = setInterval(() => this.cleanupSessions(), 60000);
  }

  /**
   * Initialize Anthropic client with API key
   */
  private initClient(apiKey: string): Anthropic {
    if (!this.anthropic || this.anthropic.apiKey !== apiKey) {
      this.anthropic = new Anthropic({ apiKey });
    }
    return this.anthropic;
  }

  /**
   * Create or get session
   */
  private getOrCreateSession(sessionId: string, workingDir: string): AgentSession {
    let session = this.sessions.get(sessionId);
    
    if (!session) {
      const now = new Date();
      session = {
        id: sessionId,
        conversation: {
          id: sessionId,
          title: 'New Chat',
          createdAt: now,
          updatedAt: now,
          messages: [],
          metadata: {
            model: 'claude-sonnet-4-20250514',
            totalTokens: 0
          },
          settings: {
            maxTokens: 4096,
            tools: [bashToolDefinition, editorToolDefinition, webSearchToolDefinition, workPlanToolDefinition]
          }
        },
        streamingState: {
          currentMessage: null,
          contentBlocks: [],
          activeBlockIndex: null,
          activeBlockContent: '',
          isStreaming: false,
          error: null
        },
        workingDir,
        maxMode: false, // Default to chat mode (require approval)
        createdAt: now,
        lastActivity: now,
        phase: 'created',
        pendingTools: []
      };
      this.sessions.set(sessionId, session);
    }
    
    session.lastActivity = new Date();
    return session;
  }

  /**
   * Process a user message
   */
  async processMessage(
    message: ClientMessage,
    apiKey: string,
    onMessage: (msg: ServerMessage) => void
  ): Promise<void> {
    const { sessionId, content, workingDir = process.cwd(), maxMode = false, chatMode = !maxMode } = message;
    
    if (!content) {
      onMessage({
        type: 'agent:error',
        sessionId,
        error: 'No message content provided'
      });
      return;
    }

    const session = this.getOrCreateSession(sessionId, workingDir);
    // Reflect latest request settings on the session
    session.maxMode = maxMode;
    session.workingDir = workingDir;
    session.phase = 'starting';
    onMessage({ type: 'agent:status', sessionId, phase: 'starting' } as any);
    
    // Generate title for first message and persist
    if (session.conversation.messages.length === 0) {
      const title = await generateConversationTitle(content, apiKey);
      session.conversation.title = title;
      try { await (await import('../store/session-store-fs.js')).sessionStoreFs.updateTitle(sessionId, title); } catch {}
      onMessage({ type: 'agent:title', sessionId, title });
    }

    // Add user message to conversation
    session.conversation.messages.push({
      role: 'user',
      content
    });
    session.conversation.updatedAt = new Date();
    try { await (await import('../store/session-store-fs.js')).sessionStoreFs.recordUserMessage(sessionId, content, { workingDir, maxMode }); } catch {}
    session.phase = 'ready';
    onMessage({ type: 'agent:status', sessionId, phase: 'ready' } as any);

    // Resolve project context once on first user message
    if (session.conversation.messages.length === 1 && !session.projectContext) {
      try {
        const ctx = await loadProjectContext(workingDir);
        if (ctx) {
          session.projectContext = { source: ctx.source, path: ctx.path, content: ctx.content };
        }
      } catch {}
    }

    // Create system prompt
    const systemPrompt = generateSystemPrompt({
      workingDirectory: workingDir,
      projectContext: session.projectContext
        ? { sourcePath: session.projectContext.path, content: session.projectContext.content }
        : undefined,
    });

    // Prepare tools
    const tools = [bashToolDefinition, editorToolDefinition, webSearchToolDefinition, workPlanToolDefinition];

    try {
      // Store reference to current stream for potential cancellation
      if (session.currentStreamController) {
        session.currentStreamController.abort();
      }
      session.currentStreamController = new AbortController();

      // Use Anthropic SDK's natural streaming pattern
      console.log(`[AnthropicService] Starting SDK stream for session: ${sessionId}`);
      const anthropic = this.initClient(apiKey);
      
      // Prepare stream configuration
      const streamConfig = {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        messages: session.conversation.messages as any,
        tools: tools as any,
        // Enable extended thinking with a minimal budget first
        thinking: { type: 'enabled', budget_tokens: 1024 },
      };
      
      console.log(`[AnthropicService] Stream config prepared, starting SDK stream...`);

      // Process stream using SDK's natural event chaining
      const streamingState = await processStream(
        sessionId,
        workingDir,
        maxMode,
        !maxMode, // chatMode = !maxMode
        onMessage,
        async (request) => {
          // Send tool request to client
          onMessage({
            type: 'agent:tool_request',
            sessionId,
            content: `Tool request: ${request.description}`,
            toolRequest: request
          });
          // Track pending tool for snapshot/status
          const s = this.sessions.get(sessionId);
          if (s) {
            s.pendingTools = [...(s.pendingTools || []), request];
            s.phase = 'awaiting_tool';
          }
        },
        async (toolId, output, isError) => {
          // Process tool result by adding to conversation and continuing
          await this.addToolResultToConversation(session, toolId, output, isError, apiKey, onMessage);
        },
        (state) => {
          const s = this.sessions.get(sessionId);
          if (s) {
            s.streamingState = state;
            s.lastActivity = new Date();
            s.phase = state.isStreaming ? 'streaming' : (state.error ? 'error' : 'ready');
          }
        },
        anthropic,
        streamConfig,
        undefined,
        session.currentStreamController.signal
      );
      
      console.log(`[AnthropicService] SDK stream processing completed for session: ${sessionId}`);

      // Update session streaming state
      session.streamingState = streamingState;

      // Add assistant message to conversation if we have content blocks and not aborted
      if (!streamingState.aborted && streamingState.contentBlocks.length > 0) {
        session.conversation.messages.push({
          role: 'assistant',
          content: streamingState.contentBlocks as any
        });
        session.conversation.updatedAt = new Date();
      }

      // If in Max mode (auto-approval), we must continue the conversation for each queued tool request
      // by sending a single user message containing all tool_result blocks, then stream the assistant's continuation.
      if (maxMode && (streamingState.autoToolRequests && streamingState.autoToolRequests.length > 0)) {
        const anthropic = this.initClient(apiKey);

        // Execute all queued tools and build tool_result blocks (aggregate into a single user message)
        const toolResultBlocks: any[] = [];
        for (const req of streamingState.autoToolRequests) {
          let output = '';
          let isError = false;
          try {
            switch (req.name) {
              case 'bash':
                output = await executeBash(req.input, workingDir);
                isError = output.includes('Error:');
                break;
              case 'str_replace_based_edit_tool':
                output = await executeEditor(req.input, workingDir);
                isError = output.startsWith('Error:');
                break;
              case 'web_search':
                output = await executeWebSearch(req.input, workingDir);
                isError = false;
                break;
              case 'work_plan':
                output = await executeWorkPlan(sessionId, req.input);
                isError = false;
                break;
              default:
                output = `Unknown tool: ${req.name}`;
                isError = true;
            }
          } catch (err: any) {
            output = `Error: ${err.message}`;
            isError = true;
          }

          // Build tool_result block (do NOT push separate user messages for each)
          const toolResultBlock = {
            type: 'tool_result',
            tool_use_id: req.id,
            content: output,
            is_error: isError,
          };
          toolResultBlocks.push(toolResultBlock);

          // Notify client for UI context (optional)
          onMessage({
            type: 'agent:tool_output',
            sessionId,
            content: output,
            message: {
              id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
              type: 'message',
              role: 'user',
              content: [toolResultBlock],
              model: '',
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            } as any,
            toolOutput: {
              id: req.id,
              tool_use_id: req.id,
              name: req.name,
              output,
              isError,
              input: req.input,
            },
          });
        }

        // Push a single user message containing ALL tool_result blocks per Anthropic spec
        session.conversation.messages.push({ role: 'user', content: toolResultBlocks as any });

        // Continue conversation after all tool results (stream again)
        await this.continueConversation(session, apiKey, onMessage);
      }

    } catch (error: any) {
      if (error.name === 'AbortError') {
        onMessage({
          type: 'agent:assistant',
          sessionId,
          content: session.streamingState.activeBlockContent || '',
          isComplete: true
        });
      } else {
        console.error(`[AnthropicService] Error processing message:`, error);
        onMessage({
          type: 'agent:error',
          sessionId,
          error: error.message
        });
      }
    } finally {
      session.currentStreamController = undefined;
    }
  }

  /**
   * Process tool response from client
   */
  async processToolResponse(
    message: ClientMessage,
    apiKey: string,
    onMessage: (msg: ServerMessage) => void
  ): Promise<void> {
    const { sessionId, toolResponse } = message;
    
    if (!toolResponse) {
      onMessage({
        type: 'agent:error',
        sessionId,
        error: 'No tool response provided'
      });
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      onMessage({
        type: 'agent:error',
        sessionId,
        error: 'Session not found'
      });
      return;
    }

    const { id: toolId, approved } = toolResponse;

    // Find the tool use in the last assistant message
    const lastMessage = session.conversation.messages[session.conversation.messages.length - 1];
    if (!lastMessage || lastMessage.role !== 'assistant') {
      onMessage({
        type: 'agent:error',
        sessionId,
        error: 'No assistant message found'
      });
      return;
    }

    const toolUse = (lastMessage.content as any[])?.find(
      (block: any) => block.type === 'tool_use' && block.id === toolId
    );

    if (!toolUse) {
      onMessage({
        type: 'agent:error',
        sessionId,
        error: 'Tool use not found'
      });
      return;
    }

    // Mark decision in pendingTools for this assistant turn
    const pendingList = session.pendingTools || [];
    const idx = pendingList.findIndex((t) => t.id === toolId);
    if (idx >= 0) {
      (pendingList[idx] as any).approved = approved;
      session.pendingTools = pendingList;
    }

    // If not all tools have been decided yet, wait for more approvals
    const allDecided = (session.pendingTools || []).length > 0
      ? (session.pendingTools || []).every((t: any) => typeof t.approved === 'boolean')
      : true;
    if (!allDecided) {
      onMessage({ type: 'agent:status', sessionId, phase: 'awaiting_tool' } as any);
      return;
    }

    // All decisions are in: execute approved tools, aggregate tool_result blocks, send a single user message
    const toolResultBlocks: ToolResultBlock[] = [];
    for (const req of session.pendingTools || []) {
      let output = '';
      let isError = false;
      const approvedFlag = !!(req as any).approved;
      if (!approvedFlag) {
        output = 'Tool use rejected by user';
        isError = true;
      } else {
        try {
          switch (req.name) {
            case 'bash':
              output = await executeBash(req.input, session.workingDir);
              isError = output.includes('Error:');
              break;
            case 'str_replace_based_edit_tool':
              output = await executeEditor(req.input, session.workingDir);
              isError = output.startsWith('Error:');
              break;
            case 'web_search':
              output = await executeWebSearch(req.input, session.workingDir);
              isError = false;
              break;
            case 'work_plan':
              output = await executeWorkPlan(session.id, req.input);
              isError = false;
              break;
            default:
              output = `Unknown tool: ${req.name}`;
              isError = true;
          }
        } catch (error: any) {
          output = `Error executing tool: ${error.message}`;
          isError = true;
        }
      }

      // Build tool_result and notify UI (per-tool)
      const toolResult: ToolResultBlock = {
        type: 'tool_result',
        tool_use_id: req.id,
        content: output,
        is_error: isError
      };
      toolResultBlocks.push(toolResult);
      onMessage({
        type: 'agent:tool_output',
        sessionId,
        content: output,
        message: {
          id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          type: 'message', role: 'user', content: [toolResult],
          model: '', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
        } as any,
        toolOutput: {
          id: req.id,
          tool_use_id: req.id,
          name: req.name,
          output,
          isError,
          input: req.input
        }
      });
    }

    // Push a single user message with ALL tool_result blocks per Anthropic spec
    session.conversation.messages.push({ role: 'user', content: toolResultBlocks as any });
    // Clear pending for this assistant turn
    session.pendingTools = [];

    // Continue conversation exactly once
    await this.continueConversation(session, apiKey, onMessage);
  }

  /**
   * Add tool result to conversation and continue (for auto-executed tools)
   */
  private async addToolResultToConversation(
    session: AgentSession,
    toolId: string,
    output: string,
    isError: boolean,
    apiKey: string,
    onMessage: (msg: ServerMessage) => void
  ): Promise<void> {
    console.log(`[AnthropicService] Adding tool result to conversation: ${toolId}`);
    
    // Add tool result to conversation
    const toolResult: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: toolId,
      content: output,
      is_error: isError
    };

    session.conversation.messages.push({
      role: 'user',
      content: [toolResult] as any
    });
    session.conversation.updatedAt = new Date();
    // Remove from pending tools if present
    session.pendingTools = (session.pendingTools || []).filter(t => t.id !== toolId);

    // Continue conversation with the tool result
    await this.continueConversation(session, apiKey, onMessage);
  }

  /**
   * Continue conversation after tool result
   */
  private async continueConversation(
    session: AgentSession,
    apiKey: string,
    onMessage: (msg: ServerMessage) => void
  ): Promise<void> {
    const systemPrompt = generateSystemPrompt({
      workingDirectory: session.workingDir,
      projectContext: session.projectContext
        ? { sourcePath: session.projectContext.path, content: session.projectContext.content }
        : undefined,
    });
    const tools = [bashToolDefinition, editorToolDefinition, webSearchToolDefinition, workPlanToolDefinition];

    try {
      // Store reference to current stream for potential cancellation  
      if (session.currentStreamController) {
        session.currentStreamController.abort();
      }
      session.currentStreamController = new AbortController();

      // Continue with Anthropic SDK's natural streaming pattern
      const anthropic = this.initClient(apiKey);
      const streamConfig = {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        messages: session.conversation.messages as any,
        tools: tools as any,
        // Enable extended thinking for continuations as well
        thinking: { type: 'enabled', budget_tokens: 1024 },
      };

      // Process continuation stream using SDK's natural event chaining
      const streamingState = await processStream(
        session.id,
        session.workingDir,
        session.maxMode,
        !session.maxMode, // chatMode = !maxMode
        onMessage,
        async (request) => {
          onMessage({
            type: 'agent:tool_request',
            sessionId: session.id,
            content: `Tool request: ${request.description}`,
            toolRequest: request
          });
          session.pendingTools = [...(session.pendingTools || []), request];
          session.phase = 'awaiting_tool';
        },
        async (toolId, output, isError) => {
          // Process tool result by adding to conversation and continuing
          await this.addToolResultToConversation(session, toolId, output, isError, apiKey, onMessage);
        },
        (state) => {
          session.streamingState = state;
          session.lastActivity = new Date();
          session.phase = state.isStreaming ? 'streaming' : (state.error ? 'error' : 'ready');
        },
        anthropic,
        streamConfig
      );

      // Update session
      session.streamingState = streamingState;

      // Add assistant message if we have content
      if (streamingState.contentBlocks.length > 0) {
        session.conversation.messages.push({
          role: 'assistant',
          content: streamingState.contentBlocks as any
        });
        session.conversation.updatedAt = new Date();
      }

      // If in Max mode with queued auto tool requests, handle them and continue
      if (session.maxMode && (streamingState.autoToolRequests && streamingState.autoToolRequests.length > 0)) {
        // Anthropic invariant: for a given assistant turn with tool_use blocks,
        // the NEXT single user message must include tool_result blocks for ALL ids.
        const aggregatedResults: any[] = [];
        for (const req of streamingState.autoToolRequests) {
          let output = '';
          let isError = false;
          try {
            switch (req.name) {
              case 'bash':
                output = await executeBash(req.input, session.workingDir);
                isError = output.includes('Error:');
                break;
              case 'str_replace_based_edit_tool':
                output = await executeEditor(req.input, session.workingDir);
                isError = output.startsWith('Error:');
                break;
              case 'web_search':
                output = await executeWebSearch(req.input, session.workingDir);
                isError = false;
                break;
              case 'work_plan':
                output = await executeWorkPlan(session.id, req.input);
                isError = false;
                break;
              default:
                output = `Unknown tool: ${req.name}`;
                isError = true;
            }
          } catch (err: any) {
            output = `Error: ${err.message}`;
            isError = true;
          }

          const toolResultBlock = {
            type: 'tool_result',
            tool_use_id: req.id,
            content: output,
            is_error: isError,
          };
          aggregatedResults.push(toolResultBlock);

          // Emit UI event per tool for visibility
          onMessage({
            type: 'agent:tool_output',
            sessionId: session.id,
            content: output,
            message: {
              id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
              type: 'message', role: 'user', content: [toolResultBlock],
              model: '', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
            } as any,
            toolOutput: { id: req.id, tool_use_id: req.id, name: req.name, output, isError, input: req.input },
          });
        }

        // Push a single user message containing ALL tool_result blocks
        session.conversation.messages.push({ role: 'user', content: aggregatedResults as any });
        await this.continueConversation(session, apiKey, onMessage);
      }

    } catch (error: any) {
      console.error(`[AnthropicService] Error continuing conversation:`, error);
      
      // Don't send error for token limit - it's already handled
      if (!error.message?.includes('prompt is too long')) {
        onMessage({
          type: 'agent:error',
          sessionId: session.id,
          error: error.message
        });
      }
    } finally {
      session.currentStreamController = undefined;
    }
  }

  /**
   * Generate title for a message
   */
  async generateTitle(
    message: string,
    apiKey: string
  ): Promise<string> {
    return generateConversationTitle(message, apiKey);
  }

  /**
   * Stop streaming for a session
   */
  stopStream(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.currentStreamController) {
      session.currentStreamController.abort();
      session.currentStreamController = undefined;
      // Clear any pending tools from the aborted assistant turn and emit stopped status
      session.pendingTools = [];
      session.phase = 'stopped';
    }
  }

  /**
   * Get session
   */
  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * List sessions (lightweight meta)
   */
  listSessions(): Array<{
    id: string;
    title: string;
    createdAt: Date;
    lastActivity: Date;
    messageCount: number;
    workingDir: string;
    maxMode: boolean;
    phase: AgentSession['phase'];
  }> {
    const result: Array<any> = [];
    for (const s of this.sessions.values()) {
      result.push({
        id: s.id,
        title: s.conversation.title,
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
        messageCount: s.conversation.messages.length,
        workingDir: s.workingDir,
        maxMode: s.maxMode,
        phase: s.phase || 'ready'
      });
    }
    return result;
  }

  /**
   * Get snapshot for a session
   */
  getSnapshot(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    return {
      id: s.id,
      title: s.conversation.title,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      messageCount: s.conversation.messages.length,
      workingDir: s.workingDir,
      maxMode: s.maxMode,
      phase: s.phase || 'ready',
      pendingTools: s.pendingTools || [],
      conversation: { messages: s.conversation.messages },
      streamingState: s.streamingState,
    };
  }

  /**
   * Clear session
   */
  clearSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.currentStreamController) {
        session.currentStreamController.abort();
      }
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Cleanup old sessions (runs every minute)
   */
  private cleanupSessions(): void {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;

    for (const [sessionId, session] of this.sessions) {
      const lastActivity = session.lastActivity.getTime();
      if (now - lastActivity > oneHour) {
        console.log(`[AnthropicService] Cleaning up inactive session: ${sessionId}`);
        this.clearSession(sessionId);
      }
    }
  }

  /**
   * Dispose service
   */
  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Clear all sessions
    for (const sessionId of this.sessions.keys()) {
      this.clearSession(sessionId);
    }
  }
}

// Export singleton instance
export const anthropicService = new AnthropicService();
