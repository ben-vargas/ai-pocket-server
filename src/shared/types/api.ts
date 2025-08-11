/**
 * Shared API types for WebSocket and HTTP communication
 */

export interface WebSocketMessage<T = any> {
  v: number;
  id: string;
  correlationId?: string;
  sessionId: string;
  ts: string;
  type: string;
  payload: T;
  timestamp: number;
}

export interface WebSocketClient {
  id: string;
  socket: any; // Support both browser WebSocket and ws library WebSocket
  metadata?: Record<string, unknown>;
}

export type Result<T> = 
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: Error;
    };

export interface FileInfo {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size?: number;
  lastModified?: Date;
  permissions?: string;
}

export interface DirectoryListing {
  path: string;
  entries: FileInfo[];
}

export interface FileContent {
  path: string;
  content: string;
  encoding: string;
  size: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
}

export interface SearchResult {
  path: string;
  line: number;
  column: number;
  match: string;
  preview: string;
}

export interface ServerStats {
  uptime: number;
  memory: {
    used: number;
    total: number;
  };
  connections: number;
  requests: {
    total: number;
    perMinute: number;
  };
}