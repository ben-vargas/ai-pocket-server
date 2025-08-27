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
    let currentToken = await getValidAccessToken();

    // Match cctest: use SDK without apiKey and pass headers per-request
    const anthropic = new Anthropic({ apiKey: null as any } as any);

    const buildHeaders = () => ({
      ...buildOAuthHeaders(currentToken),
      // Explicitly omit API key header so SDK doesn't include it from env
      'x-api-key': null as any,
      // Spoof Claude Code UA (optional)
      'user-agent': process.env.CLAUDE_CODE_UA || 'Claude Code/0.26.7',
    });

    const requestOptions: RequestOptionsWithRetry = {
      headers: buildHeaders(),
      __refreshAndRetry: async () => {
        currentToken = await forceRefreshAccessToken();
        (requestOptions.headers as any) = buildHeaders();
      },
    };

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
