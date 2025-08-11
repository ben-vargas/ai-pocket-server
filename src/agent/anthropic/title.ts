/**
 * Title Generator for Conversations
 * Generates concise, contextual titles from first user message
 */

import Anthropic from '@anthropic-ai/sdk';

/**
 * Generate a title for a conversation based on the first message
 */
export async function generateTitle(
  anthropic: Anthropic,
  userMessage: string
): Promise<string> {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514', // Use Sonnet 4 for title generation to align with agent model
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
      // Ensure title isn't too long
      const words = title.split(' ').filter(Boolean);
      if (words.length > 3) {
        return words.slice(0, 3).join(' ');
      }
      return title;
    }
    
    return 'New Chat';
  } catch (error: any) {
    console.error('[TitleGenerator] Error generating title:', error.message);
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