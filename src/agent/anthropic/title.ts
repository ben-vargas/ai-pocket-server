/**
 * Title Generator for Conversations
 * Generates concise, contextual titles from first user message
 */

import type Anthropic from '@anthropic-ai/sdk';
import AnthropicSdk from '@anthropic-ai/sdk';
import type { RequestOptionsWithRetry } from './client';
import { OAUTH_IDENTITY_LINE } from './oauth/credentials';

/**
 * Generate a title for a conversation based on the first message
 */
export async function generateTitle(
  anthropic: Anthropic,
  userMessage: string,
  requestOptions?: RequestOptionsWithRetry
): Promise<string> {
  try {
    const isOauth = Boolean(requestOptions);
    const req: any = {
      model: isOauth ? 'claude-sonnet-4-0' : 'claude-sonnet-4-20250514', // Match OAuth default model when using OAuth
      max_tokens: 20,
      temperature: 0.7,
      messages: [{
        role: 'user',
        content: `Generate a short title (max 3 words) for a conversation that starts with: "${userMessage}". Return only the title, no quotes or punctuation.`
      }]
    };
    if (isOauth) req.system = OAUTH_IDENTITY_LINE;
    const response = await anthropic.messages.create(req, requestOptions);
    
    const content = response.content[0];
    if (content.type === 'text') {
      const title = content.text.trim();
      // Ensure title isn't too long
      const words = title.split(' ').filter(Boolean);
      if (words.length > 3) {
        return words.slice(0, 3).join(' ');
      }
      return title;
    }
    
    return 'New Chat';
  } catch (error: unknown) {
    // Handle OAuth 401 once by refreshing and retrying
    const status = (error as { status?: number; code?: number; response?: { status?: number } }).status
      ?? (error as { status?: number; code?: number; response?: { status?: number } }).code
      ?? (error as { status?: number; code?: number; response?: { status?: number } }).response?.status;
    const errMsg = (error as any)?.message || (error as any)?.error?.message || '';
    if ((status === 401 || status === 403) && requestOptions?.__refreshAndRetry) {
      try {
        await requestOptions.__refreshAndRetry();
        const req2: any = {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 20,
          temperature: 0.7,
          messages: [{
            role: 'user',
            content: `Generate a short title (max 3 words) for a conversation that starts with: "${userMessage}". Return only the title, no quotes or punctuation.`
          }]
        };
        req2.system = OAUTH_IDENTITY_LINE;
        const response = await anthropic.messages.create(req2, requestOptions);
        const content = response.content[0];
        if (content.type === 'text') {
          const title = content.text.trim();
          const words = title.split(' ').filter(Boolean);
          if (words.length > 3) return words.slice(0, 3).join(' ');
          return title;
        }
        return 'New Chat';
      } catch (_e2) {
        // fall through to fallback title
      }
    }
    // If OAuth credential is not usable for non-Claude-Code requests, try API key fallback when available
    if (
      status === 400 &&
      requestOptions &&
      typeof errMsg === 'string' &&
      errMsg.includes('only authorized for use with Claude Code')
    ) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        try {
          const apiClient = new (AnthropicSdk as any)({ apiKey });
          const response = await apiClient.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 20,
            temperature: 0.7,
            messages: [{
              role: 'user',
              content: `Generate a short title (max 3 words) for a conversation that starts with: "${userMessage}". Return only the title, no quotes or punctuation.`
            }]
          });
          const content = response.content[0];
          if (content.type === 'text') {
            const title = content.text.trim();
            const words = title.split(' ').filter(Boolean);
            if (words.length > 3) return words.slice(0, 3).join(' ');
            return title;
          }
        } catch {
          // continue to fallback
        }
      }
    }
    console.error('[TitleGenerator] Error generating title:', (error as any).message);
    // Fallback to a simple title based on content
    return generateFallbackTitle(userMessage);
  }
}

/**
 * Generate a fallback title without API call
 */
function generateFallbackTitle(message: string): string {
  const lower = message.toLowerCase();
  
  // Common patterns
  if (lower.includes('fix') || lower.includes('debug')) return 'Debug Issue';
  if (lower.includes('create') || lower.includes('build')) return 'Create Project';
  if (lower.includes('help') || lower.includes('how to')) return 'Help Request';
  if (lower.includes('error')) return 'Error Resolution';
  if (lower.includes('install')) return 'Installation';
  if (lower.includes('test')) return 'Testing';
  if (lower.includes('deploy')) return 'Deployment';
  if (lower.includes('update') || lower.includes('upgrade')) return 'Update Code';
  if (lower.includes('refactor')) return 'Refactoring';
  if (lower.includes('optimize')) return 'Optimization';
  
  // Extract first few words
  const words = message.split(' ').filter(Boolean).slice(0, 3);
  if (words.length > 0) {
    return words.join(' ');
  }
  
  return 'New Chat';
}
