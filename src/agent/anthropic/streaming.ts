/**
 * Streaming Handler for Anthropic API
 * Uses async iteration pattern - the only pattern that works with Bun
 */

import Anthropic from '@anthropic-ai/sdk';
import type { RequestOptionsWithRetry } from './client';
import { executeBash, isBashCommandDangerous } from './tools/bash';
import { executeEditor, isEditorCommandDangerous } from './tools/editor';
import { executeWebSearch } from './tools/web-search';
import type { 
  ContentBlock, 
  ServerMessage, 
  StreamingState, 
  ToolOutput,
  ToolRequest,
  WebSearchResult 
} from './types';

export interface StreamHandlerOptions {
  sessionId: string;
  workingDir: string;
  maxMode: boolean;
  chatMode: boolean;
  onMessage: (message: ServerMessage) => void;
  onToolRequest: (request: ToolRequest) => Promise<void>;
  onToolResultProcessed: (toolId: string, output: string, isError: boolean) => Promise<void>;
  onStateUpdated?: (partial: Partial<StreamingState>) => void;
}

/**
 * Process streaming response using async iteration - the only working pattern
 */
export async function processStream(
  sessionId: string,
  workingDir: string,
  maxMode: boolean,
  chatMode: boolean,
  onMessage: (message: ServerMessage) => void,
  onToolRequest: (request: ToolRequest) => Promise<void>,
  onToolResultProcessed: (toolId: string, output: string, isError: boolean) => Promise<void>,
  onStateUpdated: ((state: StreamingState) => void) | undefined,
  anthropic: Anthropic,
  streamConfig: any,
  requestOptions?: RequestOptionsWithRetry
): Promise<StreamingState> {
  type MinimalStream = AsyncIterable<unknown> & { finalMessage: () => Promise<any> };
  // Initialize streaming state
  const state: StreamingState = {
    currentMessage: null,
    contentBlocks: [],
    activeBlockIndex: null,
    activeBlockContent: '',
    isStreaming: true,
    error: null,
    autoToolRequests: []
  };

  // Track accumulated content for text blocks
  let allAccumulatedContent = '';
  let currentBlockContent = '';
  let messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  let lastStopReason: string | null = null;
  
  // Track tool use blocks being built
  let currentToolUse: any = null;
  let toolInputJsonBuffer = '';
  
  // Track current block index
  let currentBlockIndex = -1;

  try {
    console.log(`[Streaming] Starting async iteration for session: ${sessionId}`);
    
    // Create the stream (with optional OAuth headers)
    let stream: MinimalStream;
    try {
      // Use messages.create with stream: true to match known-good patterns
      const body = { ...streamConfig, stream: true } as any;
      stream = (await anthropic.messages.create(body, requestOptions)) as unknown as MinimalStream;
    } catch (e) {
      const status = (e as { status?: number; code?: number; response?: { status?: number } }).status
        ?? (e as { status?: number; code?: number; response?: { status?: number } }).code
        ?? (e as { status?: number; code?: number; response?: { status?: number } }).response?.status;
      const msg = (e as any)?.message || (e as any)?.error?.message || '';
      if ((status === 401 || status === 403) && requestOptions?.__refreshAndRetry) {
        await requestOptions.__refreshAndRetry();
        const body = { ...streamConfig, stream: true } as any;
        stream = (await anthropic.messages.create(body, requestOptions)) as unknown as MinimalStream;
      } else if (
        status === 400 &&
        typeof msg === 'string' &&
        msg.includes('only authorized for use with Claude Code') &&
        process.env.ANTHROPIC_API_KEY
      ) {
        // Fallback to API key for this request only
        console.warn('[Streaming] OAuth credential rejected for this request; falling back to API key for streaming');
        const fallbackClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const body = { ...streamConfig, stream: true } as any;
        stream = (await fallbackClient.messages.create(body)) as unknown as MinimalStream;
      } else {
        throw e;
      }
    }
    
    // Process events using async iteration - THE ONLY PATTERN THAT WORKS
    for await (const event of stream) {
      console.log(`[Streaming] Event type: ${event.type}`);
      
      // Send raw event to client for real-time updates
      onMessage({
        type: 'agent:stream_event',
        sessionId,
        streamEvent: event as any
      });
      
      switch (event.type) {
        case 'message_start':
          console.log(`[Streaming] Message started: ${event.message.id}`);
          state.currentMessage = event.message as any; // Cast to our Message type
          messageId = event.message.id;
          // Phase: streaming
          onMessage({ type: 'agent:status', sessionId, phase: 'streaming' } as any);
          onStateUpdated?.(state);
          
          // Send thinking indicator
          onMessage({
            type: 'agent:thinking',
            sessionId,
            content: ''
          });
          break;
          
        case 'content_block_start': {
          currentBlockIndex = event.index;
          const block = event.content_block as ContentBlock; // Cast to our ContentBlock type
          state.contentBlocks.push(block);
          state.activeBlockIndex = event.index;
          
          console.log(`[Streaming] Content block started: index=${event.index}, type=${block.type}`);
          
          if (block.type === 'text') {
            currentBlockContent = '';
          } else if (block.type === 'tool_use') {
            currentToolUse = block;
            toolInputJsonBuffer = '';
          }
          onStateUpdated?.(state);
          break;
        }
          
        case 'content_block_delta':
          if (event.index !== currentBlockIndex) {
            console.warn(`[Streaming] Block index mismatch: ${event.index} vs ${currentBlockIndex}`);
          }
          
          if (event.delta.type === 'text_delta') {
            const deltaText = event.delta.text;
            console.log(`[Streaming] Text delta: "${deltaText}"`);
            
            // Accumulate text
            currentBlockContent += deltaText;
            allAccumulatedContent += deltaText;
            state.activeBlockContent = currentBlockContent;
            onStateUpdated?.(state);
            
            // Text delta is already sent via agent:stream_event above
            // No need for duplicate agent:assistant message
            
          } else if (event.delta.type === 'input_json_delta' && currentToolUse) {
            // Accumulate JSON for tool input
            toolInputJsonBuffer += event.delta.partial_json || '';
            console.log(`[Streaming] Tool input JSON delta: ${event.delta.partial_json}`);
            onStateUpdated?.(state);
            
          } else if (event.delta.type === 'thinking_delta') {
            // Accumulate thinking text into the active thinking block
            const idx = event.index;
            const blocks = state.contentBlocks;
            const blk = blocks[idx];
            if (blk && (blk as any).type === 'thinking') {
              (blk as any).thinking = ((blk as any).thinking || '') + (event.delta as any).thinking;
            }
            onStateUpdated?.(state);
          } else if ((event.delta as any).type === 'signature_delta') {
            // Attach encrypted signature to thinking block
            const idx = event.index;
            const blk = state.contentBlocks[idx];
            if (blk && (blk as any).type === 'thinking') {
              (blk as any).signature = (event.delta as any).signature;
            }
            onStateUpdated?.(state);
          }
          break;
          
        case 'content_block_stop':
          console.log(`[Streaming] Content block stopped: index=${event.index}`);
          
          if (state.activeBlockIndex !== null && state.activeBlockIndex < state.contentBlocks.length) {
            const block = state.contentBlocks[state.activeBlockIndex];
            
            if (block.type === 'text') {
              // Update text block with final content
              (block as any).text = currentBlockContent;
              currentBlockContent = '';
              onStateUpdated?.(state);
              
            } else if (block.type === 'tool_use' && currentToolUse) {
              // Parse and handle tool use
              try {
                if (toolInputJsonBuffer) {
                  currentToolUse.input = JSON.parse(toolInputJsonBuffer);
                }
                
                // Create tool request
                const toolRequest: ToolRequest = {
                  id: currentToolUse.id,
                  name: currentToolUse.name,
                  input: currentToolUse.input || {},
                  description: generateToolDescription(currentToolUse.name, currentToolUse.input)
                };
                
                console.log(`[Streaming] Tool request: ${toolRequest.name} - ${toolRequest.description}`);
                
                // For Max (chatMode === false) auto-approval: queue tool requests to execute AFTER this stream completes,
                // so we can send them back to the API in the required "user tool_result" message format.
                if (!chatMode && isToolSafe(toolRequest)) {
                  state.autoToolRequests?.push(toolRequest);
                } else {
                  // Chat mode: send to client for manual approval
                  await onToolRequest(toolRequest);
                  onMessage({ type: 'agent:status', sessionId, phase: 'awaiting_tool' } as any);
                }
                
              } catch (error) {
                console.error('[Streaming] Failed to parse tool input:', error);
              }
              
              // Reset tool tracking
              currentToolUse = null;
              toolInputJsonBuffer = '';
            }
          }
          
          state.activeBlockIndex = null;
          break;
          
        case 'message_delta':
          console.log(`[Streaming] Message delta: stop_reason=${event.delta.stop_reason}`);
          lastStopReason = event.delta.stop_reason ?? lastStopReason ?? null;
          break;
          
        case 'message_stop':
          console.log(`[Streaming] Message stopped`);
          state.isStreaming = false;
          // Phase transition will finalize after finalMessage fetch, but emit tentative ready
          onMessage({ type: 'agent:status', sessionId, phase: 'ready' } as any);
          onStateUpdated?.(state);
          
          // Message completion is already sent via agent:stream_event
          // Final complete message will be sent via agent:stream_complete after the loop
          break;
          
        default:
          // Handle error events that might not be in the type union
          if ('error' in event && (event as any).type === 'error') {
            console.error(`[Streaming] Error event:`, (event as any).error);
            state.error = {
              type: 'error',
              error: (event as any).error
            };
            state.isStreaming = false;
            onMessage({ type: 'agent:status', sessionId, phase: 'error' } as any);
            onStateUpdated?.(state);
            
            onMessage({
              type: 'agent:error',
              sessionId,
              error: (event as any).error.message
            });
          }
          break;
      }
    }
    
    // Get the final message after stream completes (SDK stream or build from state)
    let finalMessage: any;
    const maybeFinal = (stream as any)?.finalMessage;
    if (typeof maybeFinal === 'function') {
      finalMessage = await maybeFinal.call(stream);
    } else {
      // Build a minimal final message from accumulated state
      finalMessage = {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: state.contentBlocks as any,
        model: (state.currentMessage as any)?.model || '',
        stop_reason: lastStopReason ?? 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    }
    console.log(`[Streaming] Got final message with ${finalMessage.content.length} content blocks`);
    
    // Send the complete final message (keep the same id as the message_start for dedupe on client)
    const normalizedFinal = { ...(finalMessage as any) };
    if (state.currentMessage?.id && normalizedFinal.id !== state.currentMessage.id) {
      normalizedFinal.id = state.currentMessage.id;
    }
    onMessage({
      type: 'agent:stream_complete',
      sessionId,
      finalMessage: normalizedFinal as any
    });
    // Ensure state reflects the complete final message blocks, including thinking + signature
    try {
      state.contentBlocks = (finalMessage as any).content as any;
    } catch {
      // ignore
    }
    // Final stop_reason determines terminal phase
    const stop = (finalMessage as any).stop_reason as string | null;
    if (stop === 'pause_turn') {
      onMessage({ type: 'agent:status', sessionId, phase: 'paused' } as any);
    } else if (stop === 'end_turn' || stop === 'stop_sequence' || stop === 'max_tokens' || stop === null) {
      onMessage({ type: 'agent:status', sessionId, phase: 'completed' } as any);
    }
    onStateUpdated?.(state);
    
    console.log(`[Streaming] Stream processing completed for session: ${sessionId}`);
    
  } catch (error: any) {
    console.error(`[Streaming] Stream processing error:`, error);
    state.error = {
      type: 'error',
      error: {
        type: 'stream_processing_error',
        message: error.message
      }
    };
    state.isStreaming = false;
    
    onMessage({
      type: 'agent:error',
      sessionId,
      error: error.message
    });
  }

  return state;
}

/**
 * Execute tool locally (for auto-approved tools)
 */
async function executeToolLocally(request: ToolRequest, workingDir: string): Promise<string> {
  try {
    // Use tool name directly
    if (request.name === 'bash') {
      return await executeBash(request.input, workingDir);
    }
    if (request.name === 'str_replace_editor' || request.name === 'str_replace_based_edit_tool') {
      return await executeEditor(request.input, workingDir);
    }
    if (request.name === 'web_search') {
      return await executeWebSearch(request.input, workingDir);
    }
    return `Error: Unknown tool: ${request.name}`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

/**
 * Check if tool is safe for auto-approval
 */
function isToolSafe(request: ToolRequest): boolean {
  // ToolRequest carries the Anthropic tool name in `name`
  switch (request.name) {
    case 'bash':
      return !isBashCommandDangerous(request.input?.command || '');
    case 'str_replace_editor':
    case 'str_replace_based_edit_tool':
      return !isEditorCommandDangerous(request.input);
    case 'web_search':
      return true; // Web search is always safe
    default:
      return false;
  }
}


/**
 * Generate human-readable tool description
 */
function generateToolDescription(toolName: string, input: any): string {
  if (toolName === 'bash' && input?.command) {
    return `Execute: ${input.command}`;
  } else if (toolName === 'str_replace_based_edit_tool') {
    const { command, path } = input || {};
    const filename = path ? path.split('/').pop() : 'file';
    
    switch (command) {
      case 'view':
        return `View ${filename}`;
      case 'str_replace':
        return `Edit ${filename}`;
      case 'create':
        return `Create ${filename}`;
      case 'insert':
        return `Insert text in ${filename}`;
      default:
        return `File operation on ${filename}`;
    }
  } else if (toolName === 'web_search' && input?.query) {
    return `Search: ${input.query}`;
  }
  
  return 'Execute tool';
}
