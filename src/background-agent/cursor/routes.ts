import type { Router } from '../../server/router.js';
import { logger } from '../../shared/logger.js';
import { wsManager } from '../../server/websocket.js';
import { addFollowup, createAgent, deleteAgent, getAgent, getConversation, getMe, listAgents, listModels } from './client.js';
import { upsertRecord, listRecords, getRecord } from './store.js';
import type { CreateAgentInput } from './types.js';
import { createWebhookApp } from './webhook.js';
import { Hono } from 'hono';

function getApiKey(req: Request): string | null {
  // API key passed by mobile; never log it
  return req.headers.get('X-Cursor-Api-Key');
}

function getClientId(req: Request): string | undefined {
  return req.headers.get('X-Client-Id') || undefined;
}

export function registerCursorCloudRoutes(router: Router) {
  // expose webhook under /cloud/cursor/webhook
  const app = new Hono();
  app.route('/cursor', createWebhookApp());

  // Attach Hono app to router root under /cloud
  router.getApp().route('/', app);

  router.post('/cursor/agent', async (req) => {
    try {
      const apiKey = getApiKey(req);
      if (!apiKey) return new Response('Missing X-Cursor-Api-Key', { status: 401 });
      const clientId = getClientId(req);
      const body = (await req.json()) as CreateAgentInput & { webhook?: { url?: string } };

      const webhookUrl = body.webhook?.url || `${new URL(req.url).origin}/cloud/cursor/webhook`;
      const created = await createAgent(apiKey, { ...body, webhook: { url: webhookUrl } });

      // Record and emit event
      const now = new Date().toISOString();
      upsertRecord({
        id: created.id,
        name: created.name,
        status: created.status,
        source: created.source,
        target: created.target,
        summary: created.summary,
        createdAt: created.createdAt,
        updatedAt: now,
        ownerClientId: clientId,
      });

      if (clientId) {
        wsManager.send(clientId, {
          v: 1,
          id: crypto.randomUUID(),
          sessionId: 'cloud',
          ts: now,
          type: 'cloud:cursor:agent_created',
          payload: created,
          timestamp: Date.now(),
        });
      }

      return new Response(JSON.stringify(created), { headers: { 'Content-Type': 'application/json' } });
    } catch (e: any) {
      logger.error('CloudCursor', 'create_agent_failed', e);
      return new Response(e?.message || 'create_failed', { status: 500 });
    }
  });

  router.get('/cursor/agents', async (req) => {
    const apiKey = getApiKey(req);
    if (!apiKey) return new Response('Missing X-Cursor-Api-Key', { status: 401 });
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get('limit') || 20);
    const cursor = url.searchParams.get('cursor') || undefined;
    try {
      // Prefer live list from Cursor; fallback to local index if needed
      const remote = await listAgents(apiKey, limit, cursor);
      return new Response(JSON.stringify(remote), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      const local = listRecords(limit, cursor || undefined);
      return new Response(JSON.stringify({ agents: local.items, nextCursor: local.nextCursor }), { headers: { 'Content-Type': 'application/json' } });
    }
  });

  router.get('/cursor/agent', async (req) => {
    const apiKey = getApiKey(req);
    if (!apiKey) return new Response('Missing X-Cursor-Api-Key', { status: 401 });
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return new Response('missing id', { status: 400 });
    try {
      const agent = await getAgent(apiKey, id);
      upsertRecord({
        id: agent.id,
        name: agent.name,
        status: agent.status,
        source: agent.source,
        target: agent.target,
        summary: agent.summary,
        createdAt: agent.createdAt,
        updatedAt: new Date().toISOString(),
      });
      return new Response(JSON.stringify(agent), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      const local = getRecord(id);
      if (local) return new Response(JSON.stringify(local), { headers: { 'Content-Type': 'application/json' } });
      return new Response('not_found', { status: 404 });
    }
  });

  router.get('/cursor/agent/conversation', async (req) => {
    const apiKey = getApiKey(req);
    if (!apiKey) return new Response('Missing X-Cursor-Api-Key', { status: 401 });
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return new Response('missing id', { status: 400 });
    const conv = await getConversation(apiKey, id);
    return new Response(JSON.stringify(conv), { headers: { 'Content-Type': 'application/json' } });
  });

  router.post('/cursor/agent/followup', async (req) => {
    const apiKey = getApiKey(req);
    if (!apiKey) return new Response('Missing X-Cursor-Api-Key', { status: 401 });
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return new Response('missing id', { status: 400 });
    const body = (await req.json()) as { text: string; images?: { data: string; dimension?: { width: number; height: number } }[] };
    const result = await addFollowup(apiKey, id, body.text, body.images);
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  });

  router.delete('/cursor/agent', async (req) => {
    const apiKey = getApiKey(req);
    if (!apiKey) return new Response('Missing X-Cursor-Api-Key', { status: 401 });
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return new Response('missing id', { status: 400 });
    const result = await deleteAgent(apiKey, id);
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  });

  router.get('/cursor/me', async (req) => {
    const apiKey = getApiKey(req);
    if (!apiKey) return new Response('Missing X-Cursor-Api-Key', { status: 401 });
    const me = await getMe(apiKey);
    return new Response(JSON.stringify(me), { headers: { 'Content-Type': 'application/json' } });
  });

  router.get('/cursor/models', async (req) => {
    const apiKey = getApiKey(req);
    if (!apiKey) return new Response('Missing X-Cursor-Api-Key', { status: 401 });
    const models = await listModels(apiKey);
    return new Response(JSON.stringify(models), { headers: { 'Content-Type': 'application/json' } });
  });
}


