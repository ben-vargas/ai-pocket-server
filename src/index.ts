/**
 * Pocket Server - Node.js Implementation
 * Clean, organized server with Hono and full terminal support
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createNodeWebSocket } from '@hono/node-ws';
import type { WebSocket as WSWebSocket } from 'ws';
import { resolve } from 'path';

import { wsManager } from './server/websocket.js';
import { logger } from './shared/logger.js';
import type { WebSocketMessage } from './shared/types/api.js';
import { SimpleTerminalManager } from './terminal/simple-manager.js';
import { createRouter } from './server/router.js';
import { registerAgentModule, handleAgentMessage } from './agent/index.js';
import { registerFileSystemRoutes } from './file-system/index.js';
import { registerRoutes as registerIDERoutes, handleWebSocketMessage as handleIDEMessage } from './ide/index.js';
import { registerBackgroundAgentCursor } from './background-agent/cursor/index.js';

// Initialize Hono app
const app = new Hono();

// Middleware
app.use('*', cors());

// Register module routes
const agentRouter = createRouter('');
registerAgentModule(agentRouter);
app.route('/agent', agentRouter.getApp());

const fsRouter = createRouter('');
registerFileSystemRoutes(fsRouter);
app.route('/fs', fsRouter.getApp());

const ideRouter = createRouter('');
registerIDERoutes(ideRouter);
app.route('/ide', ideRouter.getApp());

// Cloud background agents (Cursor)
const cloudRouter = createRouter('');
registerBackgroundAgentCursor(cloudRouter);
app.route('/cloud', cloudRouter.getApp());

// Initialize simple terminal manager
const terminalManager = new SimpleTerminalManager();

// Map terminal session id -> clientId to route data to the originating client only
const termClientMap = new Map<string, string>();

// Listen for terminal data events
terminalManager.on('data', ({ id, data }) => {
  const message: WebSocketMessage = {
    v: 1,
    id: crypto.randomUUID(),
    sessionId: 'system',
    ts: new Date().toISOString(),
    type: 'term:data',
    payload: { id, data },
    timestamp: Date.now(),
  };
  const owner = termClientMap.get(id);
  if (owner) {
    wsManager.send(owner, message);
  }
});

// Listen for terminal exit events
terminalManager.on('exit', ({ id, code }) => {
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
});

// HTTP Routes
app.get('/', (c) => c.text('Pocket Server - Node.js'));

app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.get('/stats', (c) => {
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

// Create Node WebSocket adapter
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// WebSocket endpoint
app.get('/ws', 
  upgradeWebSocket((c) => {
    const clientId = crypto.randomUUID();
    
    return {
      onOpen(evt, ws) {
        logger.websocket('client_connected', clientId);
        wsManager.addClient(ws as any, clientId);
        
        // Send welcome message
        const welcome: WebSocketMessage = {
          v: 1,
          id: crypto.randomUUID(),
          sessionId: clientId,
          ts: new Date().toISOString(),
          type: 'connected',
          payload: { clientId },
          timestamp: Date.now(),
        };
        ws.send(JSON.stringify(welcome));
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
          
          if (parsed.type?.startsWith('ide:')) {
            await handleIDEMessage(ws as any, parsed);
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
      
      onClose(evt, ws) {
        logger.websocket('client_disconnected', clientId);
        wsManager.removeClient(clientId);
        // Close any terminals owned by this client
        const toClose: string[] = [];
        for (const [tid, owner] of termClientMap.entries()) {
          if (owner === clientId) toClose.push(tid);
        }
        for (const tid of toClose) {
          try { terminalManager.close(tid); } catch {}
          termClientMap.delete(tid);
        }
      },
      
      onError(evt, ws) {
        logger.error('WebSocket', 'Connection error', evt);
      },
    };
  })
);

// Handle terminal messages
function handleTerminalMessage(ws: WSWebSocket, clientId: string, message: any) {
  const { type, payload } = message;
  
  switch (type) {
    case 'term:open': {
      const { id, cwd, rows, cols } = payload || {};
      const resolved = cwd ? resolve(cwd) : process.cwd();
      
      // Open terminal session
      const session = terminalManager.open(id, resolved, rows, cols);
      termClientMap.set(id, clientId);
      
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
      break;
    }
    
    default:
      logger.warn('Terminal', `Unknown message type: ${type}`);
  }
}

// Start server
const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

const server = serve({
  fetch: app.fetch,
  port,
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
});

// Inject WebSocket support
injectWebSocket(server);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n📛 Shutting down gracefully...');
  
  // Close all terminal sessions
  const sessions = terminalManager.getActiveSessions();
  sessions.forEach(id => terminalManager.close(id));
  
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