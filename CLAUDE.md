# CLAUDE.md - Pocket Server

This file provides guidance to Claude Code when working with the Pocket Server codebase.

## Overview

Node.js + Hono HTTP/WebSocket server providing:
- Anthropic Claude API integration with streaming & tool use
- WebSocket real-time communication
- File system operations with telescope search
- Terminal PTY sessions via node-pty
- IDE/LSP support

## Architecture

```
src/
├── agent/          # Anthropic API & streaming
├── file-system/    # File ops & telescope search
├── ide/            # LSP manager
├── terminal/       # PTY session management
├── server/         # HTTP/WS infrastructure
└── shared/         # Types & utilities
```

### Event Flow
```
WebSocket Message → Route by prefix → Module Handler → Response
```
- Prefixes: `agent:*`, `fs:*`, `term:*`, `ide:*`
- Each module owns its namespace
- No direct module communication

## Development

```bash
npm install       # Install dependencies
npm run dev       # Dev with hot reload (tsx watch)
npm run build     # Build TypeScript → dist/
npm start         # Production (node dist/index.js)
npm test          # Run tests
```

## Critical Rules

### TypeScript & ESM
- Pure ESM (`"type": "module"`)
- Always use `.js` extensions in imports
- No `any` types without justification
- Full type safety required

### WebSocket Protocol

```typescript
interface WebSocketMessage {
  v: number;          // Protocol version
  id: string;         // UUID
  sessionId: string;  // Session identifier
  ts: string;         // ISO timestamp
  type: string;       // Namespaced type
  payload: any;       // Type-specific
  timestamp: number;  // Unix timestamp
}
```

## Module Specifics

### Agent Module (`src/agent/`)

**Streaming Flow:**
1. Client sends `agent:message`
2. Server streams from Anthropic API
3. Forward events as `agent:stream_event`
4. Tool requests trigger `agent:tool_request`
5. Execute tools on approval
6. Complete with `agent:stream_complete`

**Safe Tools (Auto-Approvable in Max Mode):**
- `view` command in text editor
- Read-only file operations
- Web search queries

### File System Module

**Safety Rules:**
- Never access outside HOME_DIR
- Respect .gitignore patterns
- Truncate large outputs
- Always resolve absolute paths

**Telescope Search:**
- Fuzzy file finding with scoring
- Respects ignore patterns
- Returns scored results

### Terminal Module

**PTY Management:**
- Multiple sessions via node-pty
- Headless xterm processing
- Client-specific streaming
- Auto-cleanup on disconnect

### Server Infrastructure

**Router:** Exact path matching only
**WebSocket Manager:** Client tracking, heartbeat, broadcast

## Error Handling

```typescript
type Result<T> = 
  | { success: true; data: T }
  | { success: false; error: string };
```

- Catch errors at module boundaries
- Return user-friendly messages
- Never expose internal paths

## Security

- Never log API keys or sensitive data
- Prevent path traversal attacks
- Sanitize all tool inputs
- Require approval for dangerous operations
- Enforce file system boundaries

## Performance

- Coalesce high-frequency events (10-20ms)
- Truncate large outputs
- Cancel streams on disconnect
- Use targeted sends over broadcasts
- Implement backpressure for slow clients

## Common Patterns

### Module Registration
```typescript
// In module index.ts
export function registerRoutes(router: Router) {
  router.get('/path', handler);
}

// In src/index.ts
const router = createRouter('');
registerRoutes(router);
app.route('/module', router.getApp());
```

### WebSocket Handler
```typescript
export async function handleMessage(
  ws: WebSocket,
  clientId: string,
  message: WebSocketMessage
) {
  try {
    switch (message.type) {
      case 'module:action':
        await handleAction(ws, message);
        break;
    }
  } catch (error) {
    sendError(ws, clientId, error.message);
  }
}
```

## Environment Variables

```bash
PORT=3000                  # Server port
ANTHROPIC_API_KEY=sk-...  # Optional API key
HOME_DIR=/home/user        # FS boundary
MAX_SESSIONS=10            # Session limit
TOOL_TIMEOUT=30000         # Tool timeout ms
```

## Quick Reference

### Add New Tool
1. Create in `src/agent/anthropic/tools/`
2. Add types to `types.ts`
3. Register in `anthropic.ts`
4. Update safety checks

### Add WebSocket Message
1. Define in `src/shared/types/api.ts`
2. Add handler in module
3. Register in `src/index.ts`
4. Mirror in mobile client

### Debug Issues
- Check `/health` and `/stats`
- Review structured logs
- Monitor WebSocket connections
- Verify API limits
- Check memory usage

## Key Files

- `src/index.ts` - Main entry, route registration
- `src/agent/anthropic/anthropic.ts` - Core AI client
- `src/agent/anthropic/types.ts` - Anthropic type definitions
- `src/server/websocket.ts` - WS connection manager
- `src/file-system/telescope-search.ts` - Fuzzy file search
- `src/terminal/simple-manager.ts` - PTY session management