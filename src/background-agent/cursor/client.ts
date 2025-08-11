import type {
  CursorAgentMinimal,
  CursorConversationResponse,
  CursorListAgentsResponse,
  CreateAgentInput,
} from './types.js';

const CURSOR_BASE = 'https://api.cursor.com/v0';

function headers(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

export async function createAgent(apiKey: string, input: CreateAgentInput & { webhook?: { url: string } }): Promise<CursorAgentMinimal> {
  const res = await fetch(`${CURSOR_BASE}/agents`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ ...input }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as CursorAgentMinimal;
}

export async function addFollowup(apiKey: string, id: string, text: string, images?: { data: string; dimension?: { width: number; height: number } }[]): Promise<{ id: string }> {
  const res = await fetch(`${CURSOR_BASE}/agents/${id}/followup`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ prompt: { text, ...(images?.length ? { images } : {}) } }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as { id: string };
}

export async function getAgent(apiKey: string, id: string): Promise<CursorAgentMinimal> {
  const res = await fetch(`${CURSOR_BASE}/agents/${id}`, { headers: headers(apiKey) });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as CursorAgentMinimal;
}

export async function listAgents(apiKey: string, limit = 20, cursor?: string): Promise<CursorListAgentsResponse> {
  const url = new URL(`${CURSOR_BASE}/agents`);
  url.searchParams.set('limit', String(limit));
  if (cursor) url.searchParams.set('cursor', cursor);
  const res = await fetch(url, { headers: headers(apiKey) });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as CursorListAgentsResponse;
}

export async function getConversation(apiKey: string, id: string): Promise<CursorConversationResponse> {
  const res = await fetch(`${CURSOR_BASE}/agents/${id}/conversation`, { headers: headers(apiKey) });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as CursorConversationResponse;
}

export async function deleteAgent(apiKey: string, id: string): Promise<{ id: string }> {
  const res = await fetch(`${CURSOR_BASE}/agents/${id}`, { method: 'DELETE', headers: headers(apiKey) });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as { id: string };
}

export async function getMe(apiKey: string): Promise<{ apiKeyName: string; createdAt: string; userEmail?: string }> {
  const res = await fetch(`${CURSOR_BASE}/me`, { headers: headers(apiKey) });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as { apiKeyName: string; createdAt: string; userEmail?: string };
}

export async function listModels(apiKey: string): Promise<{ models: string[] }> {
  const res = await fetch(`${CURSOR_BASE}/models`, { headers: headers(apiKey) });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as { models: string[] };
}


