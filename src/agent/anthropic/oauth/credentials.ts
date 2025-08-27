import { promises as fs } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';

/**
 * OAuth credentials + refresh helper for Claude Code OAuth.
 * - Reads ~/.claude/.credentials.json (or CLAUDE_CREDENTIALS_PATH)
 * - Proactively refreshes if expiring soon
 * - Refresh on demand (401) and updates file atomically
 */

const TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

export type Credentials = {
  access_token: string;
  refresh_token: string;
  // Either ms timestamp number or ISO string
  expires_at: number | string;
  token_type?: string;
};

// Default betas for OAuth (Claude Code), oauth must come first
export const DEFAULT_OAUTH_BETAS = 'oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';

export function getCredentialsPath(): string {
  const override = process.env.CLAUDE_CREDENTIALS_PATH;
  if (override && override.trim().length > 0) return override;
  return join(os.homedir(), '.claude', '.credentials.json');
}

function toMillis(v: number | string): number {
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

function isExpiringSoon(creds: Credentials, skewMs = 60_000): boolean {
  const now = Date.now();
  const exp = toMillis(creds.expires_at);
  return exp !== 0 && exp - now <= skewMs;
}

let _cachedPath: string | null = null;
let _cachedCreds: Credentials | null = null;

export async function loadCredentials(): Promise<{ path: string; creds: Credentials } | null> {
  const path = getCredentialsPath();
  try {
    const raw = await fs.readFile(path, 'utf8');
    const creds = JSON.parse(raw) as Credentials;
    _cachedPath = path;
    _cachedCreds = creds;
    return { path, creds };
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
    throw err;
  }
}

async function atomicWrite(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fs.rename(tmp, path);
}

export async function getValidAccessToken(): Promise<string> {
  const loaded = await loadCredentials();
  if (!loaded) throw new Error('Claude Code credentials not found');
  const { path, creds } = loaded;
  if (isExpiringSoon(creds)) {
    const refreshed = await refreshWith(creds);
    await atomicWrite(path, refreshed);
    _cachedCreds = refreshed;
    return refreshed.access_token;
  }
  return creds.access_token;
}

export async function refreshAccessTokenIfNeeded(): Promise<void> {
  const loaded = await loadCredentials();
  if (!loaded) return; // nothing to do
  if (isExpiringSoon(loaded.creds)) {
    const updated = await refreshWith(loaded.creds);
    await atomicWrite(loaded.path, updated);
    _cachedCreds = updated;
  }
}

export async function forceRefreshAccessToken(): Promise<string> {
  const loaded = await loadCredentials();
  if (!loaded) throw new Error('Claude Code credentials not found for refresh');
  const updated = await refreshWith(loaded.creds);
  await atomicWrite(loaded.path, updated);
  _cachedCreds = updated;
  return updated.access_token;
}

async function refreshWith(creds: Credentials): Promise<Credentials> {
  const body = {
    grant_type: 'refresh_token',
    refresh_token: creds.refresh_token,
    client_id: CLIENT_ID,
  } as const;
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`OAuth refresh failed (${res.status}): ${redact(text)}`);
  }
  const json = await res.json();
  const now = Date.now();
  const expires_at = json.expires_in ? now + Number(json.expires_in) * 1000 : (json.expires_at ?? creds.expires_at);
  return {
    access_token: json.access_token ?? creds.access_token,
    refresh_token: json.refresh_token ?? creds.refresh_token,
    expires_at,
    token_type: json.token_type ?? creds.token_type,
  };
}

function redact(s: string): string {
  if (!s) return s;
  return s.replace(/sk-ant-(?:oat01|ort01)-[A-Za-z0-9_-]+/g, 'sk-ant-…');
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return `${res.status}`; }
}

export function buildOAuthHeaders(accessToken: string): Record<string, string | null> {
  return {
    'x-api-key': null, // ensure SDK does not send API key header
    authorization: `Bearer ${accessToken}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': DEFAULT_OAUTH_BETAS,
  };
}

export const OAUTH_IDENTITY_LINE = "You are Claude Code, Anthropic's official CLI for Claude.";
