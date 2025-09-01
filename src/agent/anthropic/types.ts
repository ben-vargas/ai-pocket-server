/**
 * Anthropic API Types
 * Direct mirror of Anthropic API - no abstraction layers
 * These types are the single source of truth shared between server and mobile
 */



// ============================================
// Core Message Types
// ============================================

export interface Message {
  id: string;
  type: 'message';
  role: 'user' | 'assistant';
  content: ContentBlock[];
  model: string;
  stop_reason: StopReason | null;
  stop_sequence: string | null;
  usage: Usage;
}

export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn';

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  server_tool_use?: {
    web_search_requests?: number;
  };
}

// ============================================
// Content Blocks
// ============================================

export type ContentBlock = 
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ServerToolUseBlock
  | WebSearchToolResultBlock
  | ThinkingBlock;

export interface TextBlock {
  type: 'text';
  text: string;
  citations?: Citation[];
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export interface ServerToolUseBlock {
  type: 'server_tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface WebSearchToolResultBlock {
  type: 'web_search_tool_result';
  tool_use_id: string;
  content: WebSearchResult[] | WebSearchError;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

// ============================================
// Streaming Events
// ============================================

export type StreamEvent = 
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | PingEvent
  | ErrorEvent;

export interface MessageStartEvent {
  type: 'message_start';
  message: Message;
}

export interface ContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block: ContentBlock;
}

export interface ContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: Delta;
}

export interface ContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

export interface MessageDeltaEvent {
  type: 'message_delta';
  delta: {
    stop_reason?: StopReason;
    stop_sequence?: string | null;
  };
  usage?: Usage;
}

export interface MessageStopEvent {
  type: 'message_stop';
}

export interface PingEvent {
  type: 'ping';
}

export interface ErrorEvent {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
}

// ============================================
// Delta Types for Streaming
// ============================================

export type Delta = 
  | TextDelta
  | InputJSONDelta
  | ThinkingDelta
  | SignatureDelta;

export interface TextDelta {
  type: 'text_delta';
  text: string;
}

export interface InputJSONDelta {
  type: 'input_json_delta';
  partial_json: string;
}

export interface ThinkingDelta {
  type: 'thinking_delta';
  thinking: string;
}

export interface SignatureDelta {
  type: 'signature_delta';
  signature: string;
}

// ============================================
// Tool Definitions
// ============================================

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

export interface SpecialTool {
  type: string;
  name: string;
}

// Bash Tool
export interface BashTool extends SpecialTool {
  type: 'bash_20250124' | 'bash_20241022';
  name: 'bash';
}

export interface BashToolInput {
  command?: string;
  restart?: boolean;
}

// Web Search Tool
export interface WebSearchTool extends SpecialTool {
  type: 'web_search_20250305';
  name: 'web_search';
  max_uses?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
  user_location?: UserLocation;
}

export interface WebSearchToolInput {
  query: string;
}

export interface UserLocation {
  type: 'approximate';
  city: string;
  region: string;
  country: string;
  timezone: string;
}

// Text Editor Tool
export interface TextEditorTool extends SpecialTool {
  type: 'text_editor_20250429' | 'text_editor_20250124' | 'text_editor_20241022';
  name: 'str_replace_based_edit_tool';
}

// Work Plan Tool
export interface WorkPlanTool extends SpecialTool {
  type: 'work_plan_20250828';
  name: 'work_plan';
}

export type WorkPlanCommand =
  | WorkPlanCreateCommand
  | WorkPlanCompleteCommand
  | WorkPlanReviseCommand;

export interface WorkPlanCreateCommand {
  command: 'create';
  items: Array<{
    id: string;
    title: string;
    order: number;
    estimated_seconds?: number;
  }>;
}

export interface WorkPlanCompleteCommand {
  command: 'complete';
  id: string;
}

export interface WorkPlanReviseCommand {
  command: 'revise';
  items: Array<{
    id: string;
    title?: string;
    order?: number;
    estimated_seconds?: number;
    remove?: boolean;
  }>;
}

export type TextEditorCommand = 
  | ViewCommand
  | StrReplaceCommand
  | CreateCommand
  | InsertCommand
  | UndoEditCommand;

export interface ViewCommand {
  command: 'view';
  path: string;
  view_range?: [number, number];
}

export interface StrReplaceCommand {
  command: 'str_replace';
  path: string;
  old_str: string;
  new_str: string;
}

export interface CreateCommand {
  command: 'create';
  path: string;
  file_text: string;
}

export interface InsertCommand {
  command: 'insert';
  path: string;
  insert_line: number;
  new_str: string;
}

export interface UndoEditCommand {
  command: 'undo_edit';
  path: string;
}

// ============================================
// Web Search Specific Models
// ============================================

export interface WebSearchResult {
  type: 'web_search_result';
  url: string;
  title: string;
  encrypted_content: string;
  page_age: string | null;
}

export interface WebSearchError {
  type: 'web_search_tool_result_error';
  error_code: 'too_many_requests' | 'invalid_input' | 'max_uses_exceeded' | 'query_too_long' | 'unavailable';
}

export interface Citation {
  type: 'web_search_result_location';
  url: string;
  title: string;
  encrypted_index: string;
  cited_text: string;
}

// ============================================
// API Request/Response Models
// ============================================

export interface CreateMessageRequest {
  model: string;
  messages: MessageParam[];
  max_tokens: number;
  tools?: (Tool | SpecialTool)[];
  tool_choice?: ToolChoice;
  stream?: boolean;
  system?: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  metadata?: Record<string, any>;
  stop_sequences?: string[];
  thinking?: ThinkingConfig;
}

export interface MessageParam {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  cache_control?: CacheControl;
}

export interface ToolChoice {
  type: 'auto' | 'any' | 'tool' | 'none';
  name?: string;
  disable_parallel_tool_use?: boolean;
}

export interface ThinkingConfig {
  type: 'enabled';
  budget_tokens: number;
}

export interface CacheControl {
  type: 'ephemeral';
}

// ============================================
// Conversation Wrapper Model
// ============================================

export interface Conversation {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messages: MessageParam[];
  metadata: ConversationMetadata;
  settings: ConversationSettings;
}

export interface ConversationMetadata {
  model: string;
  totalTokens: number;
  tags?: string[];
  description?: string;
}

export interface ConversationSettings {
  maxTokens: number;
  temperature?: number;
  tools?: (Tool | SpecialTool)[];
  toolChoice?: ToolChoice;
  systemPrompt?: string;
  thinking?: ThinkingConfig;
}

// ============================================
// Session & Streaming State
// ============================================

export type AgentPhase =
  | 'created'
  | 'starting'
  | 'ready'
  | 'streaming'
  | 'awaiting_tool'
  | 'tool_running'
  | 'paused'
  | 'completed'
  | 'error'
  | 'stopped';

export interface AgentSession {
  id: string;
  conversation: Conversation;
  streamingState: StreamingState;
  workingDir: string;
  maxMode: boolean;
  createdAt: Date;
  lastActivity: Date;
  currentStreamController?: AbortController;
  phase?: AgentPhase;
  pendingTools?: ToolRequest[];
}

export interface StreamingState {
  currentMessage: Partial<Message> | null;
  contentBlocks: ContentBlock[];
  activeBlockIndex: number | null;
  activeBlockContent: string;
  isStreaming: boolean;
  error: ErrorEvent | null;
  // Auto-approval: tool requests collected during streaming to be executed after finalMessage
  autoToolRequests?: ToolRequest[];
}

// Snapshot types for mobile to rebuild running sessions
export interface SessionSnapshot {
  id: string;
  title: string;
  createdAt: Date;
  lastActivity: Date;
  messageCount: number;
  workingDir: string;
  maxMode: boolean;
  phase: AgentPhase;
  pendingTools: ToolRequest[];
  conversation: { messages: MessageParam[] };
  streamingState: StreamingState;
}

// ============================================
// Client-Server Communication
// ============================================

export interface ClientMessage {
  type: 'agent:message' | 'agent:tool_response' | 'agent:generate_title' | 'agent:stop';
  sessionId: string;
  content?: string;
  workingDir?: string;
  maxMode?: boolean;
  chatMode?: boolean; // New field: true = require approval, false = auto-execute safe tools
  toolResponse?: {
    id: string;
    approved: boolean;
  };
}

export interface ServerMessage {
  type:
    | 'agent:assistant'
    | 'agent:tool_request'
    | 'agent:tool_output'
    | 'agent:tool_result_processed'
    | 'agent:error'
    | 'agent:thinking'
    | 'agent:title'
    | 'agent:session_started'
    | 'agent:stream_event'
    | 'agent:stream_complete'
    | 'agent:status';
  sessionId: string;
  content?: string;
  toolRequest?: ToolRequest;
  toolOutput?: ToolOutput;
  message?: Message; // Complete message with tool_result block
  toolResult?: {
    id: string;
    output: string;
    isError: boolean;
  };
  title?: string;
  error?: string;
  messageId?: string;
  searchResults?: WebSearchResult[];
  streamEvent?: StreamEvent;  // Direct Anthropic SDK event
  finalMessage?: Message;      // Final complete message from stream
  phase?: AgentPhase;          // For agent:status updates
  isComplete?: boolean;  // For agent:assistant messages
}

export interface ToolRequest {
  id: string;
  name: string;  // Anthropic tool name (e.g., 'bash', 'str_replace_based_edit_tool', 'web_search')
  input: any;
  description?: string;
}

export interface ToolOutput {
  id: string;
  tool_use_id: string;  // Links back to the request
  name: string;  // The tool that generated this output
  output: string;
  isError: boolean;
  input?: any;  // Optional, for context
}
