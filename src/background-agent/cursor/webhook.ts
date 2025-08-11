import { Hono } from 'hono';
import { createHmac } from 'crypto';
import { upsertRecord, getRecord } from './store.js';
import type { CloudAgentRecord } from './types.js';
import { wsManager } from '../../server/websocket.js';

// We keep one secret for all Cursor webhooks in this server instance.
// In production, prefer loading from env: CURSOR_WEBHOOK_SECRET
const WEBHOOK_SECRET = process.env.CURSOR_WEBHOOK_SECRET || 'change-me-dev-secret';

function verifySignature(rawBody: string, signature: string | null): boolean {
  if (!signature) return false;
  const expected = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  return expected === signature;
}

// Hono sub-app for webhook
export function createWebhookApp() {
  const app = new Hono();

  app.post('/webhook', async (c) => {
    const signature = c.req.header('X-Webhook-Signature') || c.req.header('x-webhook-signature') || null;
    const raw = await c.req.text();

    if (!verifySignature(raw, signature)) {
      return c.json({ error: 'invalid_signature' }, 401);
    }

    try {
      const payload = JSON.parse(raw) as any;
      if (payload?.event !== 'statusChange') {
        return c.json({ ok: true }); // ignore others for now
      }

      // Map payload into our record update
      const now = new Date().toISOString();
      const update: Partial<CloudAgentRecord> = {
        id: payload.id,
        name: payload.name || payload.id,
        status: payload.status,
        target: payload.target,
        summary: payload.summary,
        updatedAt: now,
      } as any;

      // Upsert into store (requires at least id and status)
      const rec = {
        id: update.id!,
        name: update.name || update.id!,
        status: update.status as any,
        source: { repository: payload?.source?.repository || 'unknown' },
        target: update.target,
        summary: update.summary,
        createdAt: payload.createdAt || now,
        updatedAt: now,
      } as CloudAgentRecord;
      upsertRecord(rec);

      // Emit WS event broadly (owner targeting requires `ownerClientId` stored during create)
      const ownerId = getRecord(payload.id)?.ownerClientId;
      const msg = {
        v: 1,
        id: crypto.randomUUID(),
        sessionId: 'cloud',
        ts: now,
        type: 'cloud:cursor:status',
        payload: {
          id: payload.id,
          status: payload.status,
          summary: payload.summary,
          target: payload.target,
        },
        timestamp: Date.now(),
      } as any;
      if (ownerId) wsManager.send(ownerId, msg); else wsManager.broadcast(msg);

      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: 'bad_payload' }, 400);
    }
  });

  return app;
}


