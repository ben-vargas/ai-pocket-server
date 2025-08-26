/**
 * Pocket Server - Node.js Implementation
 * Clean, organized server with Hono and full terminal support
 */

import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { readFileSync } from 'fs';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import os from 'os';
import { resolve } from 'path';
import type { WebSocket as WSWebSocket } from 'ws';
import { handleAgentMessage, registerAgentModule } from './agent/index';
import { verifyAuthFromRequest } from './auth/middleware';
import { registerAuthRoutes } from './auth/routes';
import { registerBackgroundAgentCursor } from './background-agent/cursor/index';
import { registerFileSystemRoutes } from './file-system/index';
import { registerNotificationRoutes } from './notifications/index';
import { createRouter } from './server/router';
import { wsManager } from './server/websocket';
import { logger } from './shared/logger';
import { getPublicBaseUrl, setPublicBaseUrl } from './shared/public-url';
import type { TerminalFramePayload, WebSocketMessage } from './shared/types/api';
import { TerminalManager } from './terminal/terminal-manager';

// Initialize Hono app
const app = new Hono();

// Reset stale public tunnel URL on server boot to avoid returning
// an outdated value in dev runs that don't start cloudflared.
// Safe: when cloudflared starts, it will set a fresh URL again.
try { setPublicBaseUrl(null); } catch {}

// Middleware
app.use('*', cors());

// Register module routes
const agentRouter = createRouter('');
registerAgentModule(agentRouter);
app.route('/agent', agentRouter.getApp());

const fsRouter = createRouter('');
registerFileSystemRoutes(fsRouter);
app.route('/fs', fsRouter.getApp());


// Cloud background agents (Cursor)
const cloudRouter = createRouter('');
registerBackgroundAgentCursor(cloudRouter);
app.route('/cloud', cloudRouter.getApp());

// Notifications
const notificationsRouter = createRouter('');
registerNotificationRoutes(notificationsRouter);
app.route('/notifications', notificationsRouter.getApp());

// Auth routes
const authRouter = createRouter('');
registerAuthRoutes(authRouter);
app.route('/auth', authRouter.getApp());

// Initialize simple terminal manager
const terminalManager = new TerminalManager();

// Map terminal session id -> clientId to route data to the originating client only
const termClientMap = new Map<string, string>();

// Aggregated frame streaming per terminal session
type FrameBuffer = {
  chunks: string[];
  bytes: number;
  timer: NodeJS.Timeout | null;
  seq: number;
};

const frameBuffers = new Map<string, FrameBuffer>();
const FLUSH_INTERVAL_MS = 8; // target ~120Hz
const MAX_FRAME_BYTES = 32 * 1024; // smaller frames to reduce latency for input echo

function flushFrame(id: string) {
  const buf = frameBuffers.get(id);
  if (!buf || (buf.bytes === 0 && buf.chunks.length === 0)) return;
  if (buf.timer) {
    clearTimeout(buf.timer);
    buf.timer = null;
  }

  const data = buf.chunks.join('');
  buf.chunks = [];
  buf.bytes = 0;
  const owner = termClientMap.get(id);
  if (!owner || data.length === 0) return;

  const payload: TerminalFramePayload = { id, seq: ++buf.seq, ts: Date.now(), data };
  const message: WebSocketMessage<TerminalFramePayload> = {
    v: 1,
    id: crypto.randomUUID(),
    sessionId: 'system',
    ts: new Date().toISOString(),
    type: 'term:frame',
    payload,
    timestamp: Date.now(),
  };
  wsManager.send(owner, message);
}

// Per-session backlog buffer for resumability
type Backlog = { chunks: string[]; totalBytes: number; exited?: { code: number; ts: number } };
const MAX_BACKLOG_BYTES = 1024 * 1024; // ~1MB
const backlogMap = new Map<string, Backlog>();

function appendBacklog(id: string, data: string) {
  if (!data) return;
  let entry = backlogMap.get(id);
  if (!entry) {
    entry = { chunks: [], totalBytes: 0 };
    backlogMap.set(id, entry);
  }
  entry.chunks.push(data);
  entry.totalBytes += data.length;
  while (entry.totalBytes > MAX_BACKLOG_BYTES && entry.chunks.length > 0) {
    const removed = entry.chunks.shift();
    if (!removed) break;
    entry.totalBytes -= removed.length;
  }
}

function getBacklogJoined(id: string): string | null {
  const entry = backlogMap.get(id);
  if (!entry || entry.chunks.length === 0) return null;
  return entry.chunks.join('');
}

function sendBacklogToClient(clientId: string, id: string) {
  const joined = getBacklogJoined(id);
  if (!joined) return;
  let offset = 0;
  while (offset < joined.length) {
    const end = Math.min(offset + MAX_FRAME_BYTES, joined.length);
    const slice = joined.slice(offset, end);
    const payload: TerminalFramePayload = { id, seq: 0, ts: Date.now(), data: slice };
    const message: WebSocketMessage<TerminalFramePayload> = {
      v: 1,
      id: crypto.randomUUID(),
      sessionId: 'system',
      ts: new Date().toISOString(),
      type: 'term:frame',
      payload,
      timestamp: Date.now(),
    };
    wsManager.send(clientId, message);
    offset = end;
  }
}

// Listen for terminal data events and aggregate
terminalManager.on('data', ({ id, data }) => {
  let buf = frameBuffers.get(id);
  if (!buf) {
    buf = { chunks: [], bytes: 0, timer: null, seq: 0 };
    frameBuffers.set(id, buf);
  }
  buf.chunks.push(data);
  buf.bytes += data.length;
  try { appendBacklog(id, data); } catch {}

  // Flush immediately if frame grows large
  if (buf.bytes >= MAX_FRAME_BYTES) {
    flushFrame(id);
    return;
  }

  // Schedule a near-frame-rate flush if not already scheduled
  if (!buf.timer) {
    buf.timer = setTimeout(() => flushFrame(id), FLUSH_INTERVAL_MS);
  }
});

// Listen for terminal exit events
terminalManager.on('exit', ({ id, code }) => {
  // Flush any buffered output for this session first
  flushFrame(id);

  const message: WebSocketMessage = {
    v: 1,
    id: crypto.randomUUID(),
    sessionId: 'system',
    ts: new Date().toISOString(),
    type: 'term:exit',
    payload: { id, code },
    timestamp: Date.now(),
  };
  const owner = termClientMap.get(id);
  if (owner) {
    wsManager.send(owner, message);
  }
  termClientMap.delete(id);
  frameBuffers.delete(id);
  try {
    appendBacklog(id, `\r\n[process exited with code ${code}]\r\n`);
    const entry = backlogMap.get(id);
    if (entry) entry.exited = { code, ts: Date.now() };
  } catch {}
});

// HTTP Routes
app.get('/', (c) => c.text('Pocket Server - Node.js'));

app.get('/health', (c) => {
  let version = 'dev';
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    if (pkg?.version) version = pkg.version;
  } catch {}
  return c.json({
    status: 'healthy',
    version,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.get('/stats', async (c) => {
  const auth = await verifyAuthFromRequest(c.req.raw);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.reason }), {
      status: auth.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const memUsage = process.memoryUsage();
  return c.json({
    uptime: process.uptime(),
    memory: {
      used: memUsage.heapUsed,
      total: memUsage.heapTotal,
    },
    connections: wsManager.getClientCount(),
    terminals: terminalManager.getSessionCount(),
  });
});

app.get('/cloud/public-base-url', (c) => {
  return c.json({ url: getPublicBaseUrl() });
});

// Create Node WebSocket adapter
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// WebSocket endpoint
app.get('/ws', 
  upgradeWebSocket((c) => {
    const clientId = crypto.randomUUID();
    // Verify token from query before accepting upgrade
    const url = new URL(c.req.url);
    const token = url.searchParams.get('token') || '';
    const fakeReq = new Request(c.req.url, { headers: { Authorization: token ? `Pocket ${token}` : '' } });
    // Note: upgradeWebSocket hook doesn't allow async gating directly; we validate in onOpen and close if invalid.
    return {
      onOpen(_evt, ws) {
        (async () => {
          const res = await verifyAuthFromRequest(fakeReq);
          if (!res.ok) {
            try { (ws as any).close(4401, res.reason); } catch {}
            return;
          }
          logger.websocket('client_connected', clientId);
          wsManager.addClient(ws as any, clientId);
          
          // Send welcome message
          const welcome: WebSocketMessage = {
            v: 1,
            id: crypto.randomUUID(),
            sessionId: clientId,
            ts: new Date().toISOString(),
            type: 'connected',
            payload: { clientId, publicBaseUrl: getPublicBaseUrl() },
            timestamp: Date.now(),
          };
          ws.send(JSON.stringify(welcome));
        })();
      },
      
      async onMessage(evt, ws) {
        const message = evt.data?.toString();
        if (!message) return;
        
        logger.websocket('message_received', clientId, { length: message.length });
        
        try {
          const parsed = JSON.parse(message);
          
          // Log ping messages specifically for debugging
          if (parsed.type === 'ping') {
            logger.info('WebSocket', 'Ping received from client', clientId);
          }
          
          // Route messages based on type prefix
          if (parsed.type?.startsWith('term:')) {
            handleTerminalMessage(ws as any, clientId, parsed);
            return;
          }
          
          if (parsed.type?.startsWith('agent:')) {
            await handleAgentMessage(ws as any, clientId, parsed);
            return;
          }
          
          
          
          if (parsed.type?.startsWith('fs:')) {
            // File system messages are handled via HTTP routes for now
            // Could add WebSocket handlers here if needed
            logger.debug('File system message received via WebSocket', parsed.type);
            return;
          }
          
          // Heartbeat handling - CRITICAL for keeping connection alive
          if (parsed.type === 'ping') {
            const pong: WebSocketMessage = {
              v: 1,
              id: crypto.randomUUID(),
              sessionId: clientId,
              ts: new Date().toISOString(),
              type: 'pong',
              payload: null,
              timestamp: Date.now(),
            };
            ws.send(JSON.stringify(pong));
            return;
          }
          
          // Echo unknown messages
          const response: WebSocketMessage = {
            v: 1,
            id: crypto.randomUUID(),
            sessionId: clientId,
            ts: new Date().toISOString(),
            type: 'echo',
            payload: parsed,
            timestamp: Date.now(),
          };
          ws.send(JSON.stringify(response));
          
        } catch (error) {
          logger.error('WebSocket', 'Failed to parse message', error);
        }
      },
      
      onClose(_evt, _ws) {
        logger.websocket('client_disconnected', clientId);
        wsManager.removeClient(clientId);
        // Detach any terminals owned by this client but do not close them
        const toDetach: string[] = [];
        for (const [tid, owner] of termClientMap.entries()) {
          if (owner === clientId) toDetach.push(tid);
        }
        for (const tid of toDetach) {
          termClientMap.delete(tid);
        }
      },
      
      onError(evt, _ws) {
        logger.error('WebSocket', 'Connection error', evt);
      },
    };
  })
);

// Handle terminal messages
function handleTerminalMessage(ws: WSWebSocket, clientId: string, message: { type?: string; payload?: any }) {
  const { type, payload } = message;
  
  switch (type) {
    case 'term:attach': {
      const { id } = payload || {};
      if (typeof id !== 'string' || !id) break;
      const session = terminalManager.get(id);
      termClientMap.set(id, clientId);
      try { sendBacklogToClient(clientId, id); } catch {}
      if (session) {
        const opened: WebSocketMessage = {
          v: 1,
          id: crypto.randomUUID(),
          sessionId: clientId,
          ts: new Date().toISOString(),
          type: 'term:opened',
          payload: { id, cols: session.cols, rows: session.rows },
          timestamp: Date.now(),
        };
        ws.send(JSON.stringify(opened));
      } else {
        const entry = backlogMap.get(id);
        if (entry?.exited) {
          const exitMsg: WebSocketMessage = {
            v: 1,
            id: crypto.randomUUID(),
            sessionId: clientId,
            ts: new Date().toISOString(),
            type: 'term:exit',
            payload: { id, code: entry.exited.code },
            timestamp: Date.now(),
          };
          ws.send(JSON.stringify(exitMsg));
        }
      }
      break;
    }

    case 'term:open_or_attach': {
      const { id, cwd, rows, cols } = payload || {};
      if (typeof id !== 'string' || !id) break;
      const existing = terminalManager.get(id);
      if (existing) {
        termClientMap.set(id, clientId);
        try { sendBacklogToClient(clientId, id); } catch {}
        const opened: WebSocketMessage = {
          v: 1,
          id: crypto.randomUUID(),
          sessionId: clientId,
          ts: new Date().toISOString(),
          type: 'term:opened',
          payload: { id, cols: existing.cols, rows: existing.rows },
          timestamp: Date.now(),
        };
        ws.send(JSON.stringify(opened));
      } else {
        const resolved = cwd ? resolve(cwd) : process.cwd();
        const session = terminalManager.open(id, resolved, rows, cols);
        termClientMap.set(id, clientId);
        backlogMap.set(id, { chunks: [], totalBytes: 0 });
        const opened: WebSocketMessage = {
          v: 1,
          id: crypto.randomUUID(),
          sessionId: clientId,
          ts: new Date().toISOString(),
          type: 'term:opened',
          payload: { id, cols: session.cols, rows: session.rows },
          timestamp: Date.now(),
        };
        ws.send(JSON.stringify(opened));
      }
      break;
    }
    case 'term:open': {
      const { id, cwd, rows, cols } = payload || {};
      const resolved = cwd ? resolve(cwd) : process.cwd();
      
      // Open terminal session
      const session = terminalManager.open(id, resolved, rows, cols);
      termClientMap.set(id, clientId);
      backlogMap.set(id, { chunks: [], totalBytes: 0 });
      
      // Send opened confirmation
      const opened: WebSocketMessage = {
        v: 1,
        id: crypto.randomUUID(),
        sessionId: clientId,
        ts: new Date().toISOString(),
        type: 'term:opened',
        payload: { id, cols: session.cols, rows: session.rows },
        timestamp: Date.now(),
      };
      ws.send(JSON.stringify(opened));
      break;
    }
    
    case 'term:input': {
      const { id, data } = payload || {};
      terminalManager.write(id, data);
      // Flush any buffered output immediately to keep echo snappy while typing
      try {
        if (typeof id === 'string') {
          flushFrame(id);
        }
      } catch {}
      break;
    }
    
    case 'term:resize': {
      const { id, cols, rows, seq } = payload || {};
      if (typeof id === 'string' && Number.isFinite(cols) && Number.isFinite(rows)) {
        terminalManager.resize(id, Number(cols), Number(rows));
        
        // Send resize confirmation
        const resized: WebSocketMessage = {
          v: 1,
          id: crypto.randomUUID(),
          sessionId: clientId,
          ts: new Date().toISOString(),
          type: 'term:resized',
          payload: { id, cols: Number(cols), rows: Number(rows), seq },
          timestamp: Date.now(),
        };
        ws.send(JSON.stringify(resized));
      }
      break;
    }
    
    case 'term:close': {
      const { id } = payload || {};
      terminalManager.close(id);
      termClientMap.delete(id);
      backlogMap.delete(id);
      break;
    }
    
    default:
      logger.warn('Terminal', `Unknown message type: ${type}`);
  }
}

// Start server
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

const server = serve({
  fetch: app.fetch,
  port,
  hostname: '0.0.0.0',
}, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║                                                      ║
║            Pocket Server - Node.js Edition          ║
║                                                      ║
║   🚀 Server running on port ${port}                    ║
║   📡 WebSocket endpoint: ws://localhost:${port}/ws     ║
║   💚 Health check: http://localhost:${port}/health     ║
║                                                      ║
╚══════════════════════════════════════════════════════╝
  `);
  // Print local LAN URLs for convenience
  try {
    const nets = os.networkInterfaces();
    const urls: string[] = [];
    Object.values(nets).forEach(ifaces => {
      ifaces?.forEach(addr => {
        if (addr.family === 'IPv4' && !addr.internal) {
          urls.push(`http://${addr.address}:${port}`);
        }
      });
    });
    if (urls.length) {
      console.log('🔗 Local network URL(s):');
      urls.forEach(u => {
        console.log(`   • ${u}`);
      });
    }
  } catch {}
});

// Inject WebSocket support
injectWebSocket(server);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n📛 Shutting down gracefully...');
  
  // Close all terminal sessions
  const sessions = terminalManager.getActiveSessions();
  sessions.forEach(id => {
    terminalManager.close(id);
  });
  
  // Close server
  server.close(() => {
    console.log('👋 Server closed');
    process.exit(0);
  });
  
  // Force exit after 5 seconds
  setTimeout(() => {
    console.log('⚠️  Forcing exit');
    process.exit(1);
  }, 5000);
});

export { app };