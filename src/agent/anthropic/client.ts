import Anthropic, { type RequestOptions as SDKRequestOptions } from '@anthropic-ai/sdk';
import { buildOAuthHeaders, forceRefreshAccessToken, getValidAccessToken, refreshAccessTokenIfNeeded } from './oauth/credentials';

export type AuthMode = 'oauth' | 'api_key' | 'oauth_then_api_key' | 'api_key_then_oauth';

function getMode(): AuthMode {
  const raw = (process.env.ANTHROPIC_AUTH_MODE || 'api_key').toLowerCase();
  if (raw === 'oauth' || raw === 'api_key' || raw === 'oauth_then_api_key' || raw === 'api_key_then_oauth') return raw;
  return 'api_key';
}

export interface RequestOptionsWithRetry extends SDKRequestOptions { __refreshAndRetry?: () => Promise<void> }

export interface AuthContext {
  anthropic: Anthropic;
  requestOptions?: RequestOptionsWithRetry;
  isOauth: boolean;
  mode: AuthMode;
}

/**
 * Resolves authentication context based on ANTHROPIC_AUTH_MODE and optional per-message API key.
 * Minimal invasive: still uses the @anthropic-ai/sdk; for OAuth we inject per-request headers.
 */
export async function getAuthContext(input: { messageApiKey?: string | null }): Promise<AuthContext> {
  const mode = getMode();
  const envKey = process.env.ANTHROPIC_API_KEY || undefined;
  const msgKey = (input.messageApiKey || undefined) as string | undefined;

  // Helpers
  const buildApiKeyCtx = (key: string): AuthContext => ({ anthropic: new Anthropic({ apiKey: key }), isOauth: false, mode });

  const buildOAuthCtx = async (): Promise<AuthContext> => {
    // Proactive refresh if near expiry
    await refreshAccessTokenIfNeeded().catch(() => { /* ignore here; will fail when fetching token */ });
    const token = await getValidAccessToken();
    const headers = buildOAuthHeaders(token);
    const requestOptions: RequestOptionsWithRetry = {
      headers,
      __refreshAndRetry: async () => {
        const newToken = await forceRefreshAccessToken();
        requestOptions.headers = buildOAuthHeaders(newToken);
      },
    };
    // For OAuth, SDK apiKey is unused; we still instantiate the client
    // Passing undefined avoids sending x-api-key by default; we also null it explicitly in headers.
    const anthropic = new Anthropic({ apiKey: null });
    return { anthropic, requestOptions, isOauth: true, mode };
  };

  // Decide per mode
  switch (mode) {
    case 'oauth': {
      return await buildOAuthCtx();
    }
    case 'api_key': {
      const key = msgKey || envKey;
      if (!key) throw new Error('No API key provided');
      return buildApiKeyCtx(key);
    }
    case 'oauth_then_api_key': {
      try {
        return await buildOAuthCtx();
      } catch {
        const key = msgKey || envKey;
        if (!key) throw new Error('OAuth credentials unavailable and no API key provided');
        return buildApiKeyCtx(key);
      }
    }
    case 'api_key_then_oauth': {
      const key = msgKey || envKey;
      if (key) return buildApiKeyCtx(key);
      return await buildOAuthCtx();
    }
    default: {
      const key = msgKey || envKey;
      if (!key) throw new Error('No API key provided');
      return buildApiKeyCtx(key);
    }
  }
}
