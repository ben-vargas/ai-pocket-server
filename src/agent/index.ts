/**
 * Agent Module
 * Main entry point for all AI agent providers
 */

import { verifyAuthFromRequest } from '../auth/middleware';
import type { Router } from '../server/router';
import { handleAgentWebSocket, registerAgentRoutes } from './anthropic/index';
import { sessionStoreFs } from './store/session-store-fs';

/**
 * Register all agent modules with the router
 */
export function registerAgentModule(router: Router): void {
  // Protect all agent routes
  router.usePre(async (req) => {
    const auth = await verifyAuthFromRequest(req);
    if (!auth.ok) {
      return new Response(JSON.stringify({ error: auth.reason }), { status: auth.status, headers: { 'Content-Type': 'application/json' } });
    }
    return null;
  });
  // Register Anthropic routes
  registerAgentRoutes(router);
  // Initialize file-based session store
  void sessionStoreFs.init();
  
  // Future: Add other providers here
  // registerOpenAIRoutes(router);
  // registerGeminiRoutes(router);
}

/**
 * Handle agent-related WebSocket messages
 * Routes to appropriate provider based on message type
 */
export async function handleAgentMessage(
  ws: WebSocket,
  clientId: string,
  message: any
): Promise<void> {
  // Route based on message type prefix
  if (message.type?.startsWith('agent:')) {
    // Default to Anthropic for now
    await handleAgentWebSocket(ws, clientId, message);
  }
  
  // Future: Route to other providers
  // if (message.type?.startsWith('openai:')) {
  //   await handleOpenAIWebSocket(ws, clientId, message);
  // }
}

// Re-export types
export type { 
  AgentSession,
  ClientMessage,
  Conversation,
  ServerMessage,
  ToolOutput, 
  ToolRequest
} from './anthropic/types';