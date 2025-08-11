/**
 * IDE HTTP Handlers
 * 
 * HTTP endpoints for IDE functionality.
 */

import type { Router } from '../server/router.js';
import { lspManager } from './lsp-manager.js';
import { detectLanguages } from './language-detection.js';

export function registerIDERoutes(router: Router): void {
  // Start LSP server for a language
  router.post('/lsp/start', handleStartLSP);

  // Auto-detect and start multiple LSPs for a root
  router.post('/lsp/autostart', handleAutoStartLSP);
  
  // Stop LSP server
  router.post('/lsp/stop', handleStopLSP);
  
  // Get LSP status
  router.get('/lsp/status', handleGetLSPStatus);
  
  // Get completions
  router.post('/lsp/completions', handleGetCompletions);
  
  // Get hover info
  router.post('/lsp/hover', handleGetHover);
  
  // Get diagnostics
  router.post('/lsp/diagnostics', handleGetDiagnostics);
}

async function handleStartLSP(req: Request): Promise<Response> {
  try {
    const body = await req.json() as { language: string; rootPath: string };
    const { language, rootPath } = body;
    
    if (!language || !rootPath) {
      return new Response(JSON.stringify({ error: 'Missing language or rootPath' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    await lspManager.getOrStartServer(language, rootPath);
    
    return new Response(JSON.stringify({ 
      status: 'ready',
      language,
      rootPath,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : 'Failed to start language server',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handleStopLSP(req: Request): Promise<Response> {
  try {
    const body = await req.json() as { language: string; rootPath: string };
    const { language, rootPath } = body;
    
    if (!language || !rootPath) {
      return new Response(JSON.stringify({ error: 'Missing language or rootPath' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    await lspManager.stopServer(language, rootPath);
    
    return new Response(JSON.stringify({ status: 'stopped' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : 'Failed to stop language server',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handleGetLSPStatus(req: Request): Promise<Response> {
  // TODO: Return real status when we track instances per root
  return new Response(JSON.stringify({ servers: [] }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleAutoStartLSP(req: Request): Promise<Response> {
  try {
    const body = await req.json() as { rootPath: string };
    const { rootPath } = body;
    if (!rootPath) {
      return new Response(JSON.stringify({ error: 'Missing rootPath' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const languages = await detectLanguages(rootPath);
    const started: string[] = [];
    await Promise.all(languages.map(async (lang) => {
      try {
        await lspManager.getOrStartServer(lang, rootPath);
        started.push(lang);
      } catch {}
    }));

    return new Response(JSON.stringify({ rootPath, started }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : 'Failed to autostart language servers',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handleGetCompletions(req: Request): Promise<Response> {
  try {
    const body = await req.json() as {
      language: string;
      uri: string;
      position: { line: number; character: number };
      rootPath: string;
    };
    
    const server = await lspManager.getOrStartServer(body.language, body.rootPath);
    const completions = await server.getCompletions(body.uri, body.position);
    
    return new Response(JSON.stringify({ completions }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : 'Failed to get completions',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handleGetHover(req: Request): Promise<Response> {
  try {
    const body = await req.json() as {
      language: string;
      uri: string;
      position: { line: number; character: number };
      rootPath: string;
    };
    
    const server = await lspManager.getOrStartServer(body.language, body.rootPath);
    const hover = await server.getHover(body.uri, body.position);
    
    return new Response(JSON.stringify({ hover }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : 'Failed to get hover info',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handleGetDiagnostics(req: Request): Promise<Response> {
  try {
    const body = await req.json() as {
      language: string;
      uri: string;
      rootPath: string;
    };
    
    const server = await lspManager.getOrStartServer(body.language, body.rootPath);
    const diagnostics = await server.getDiagnostics(body.uri);
    
    return new Response(JSON.stringify({ diagnostics }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : 'Failed to get diagnostics',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}