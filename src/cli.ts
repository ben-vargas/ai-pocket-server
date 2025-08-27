#!/usr/bin/env node
import { spawn } from 'child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import os from 'os';
import { startPairingWindow } from './auth/pairing';
import { logger } from './shared/logger';
import { resolveDataPath } from './shared/paths';
import { getPublicBaseUrl, setPublicBaseUrl } from './shared/public-url';
import { createHelpDisplay, createPairingDisplay, status } from './shared/terminal-ui';
import { startQuickTunnel } from './tunnel/cloudflare';

const DEFAULT_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

function printHelp(): void {
  console.log(createHelpDisplay());
}

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string | boolean>; } {
  const out: Record<string, string | boolean> = {};
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'start';
  const rest = argv[0] === cmd ? argv.slice(1) : argv.slice(0);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') break;
    if (a.startsWith('--')) {
      const [rawK, rawV] = a.slice(2).split('=');
      const k = rawK.trim();
      if (rawV !== undefined) {
        out[k] = rawV;
      } else {
        // support space-separated values: --port 3010
        const next = rest[i + 1];
        if (k === 'port' || k === 'duration' || k === 'pin') {
          if (next && !next.startsWith('-')) {
            out[k] = next;
            i++;
          } else {
            // missing value -> ignore, will fallback later
          }
        } else {
          out[k] = true;
        }
      }
      continue;
    }
    if (a.startsWith('-')) {
      if (a === '-r') {
        out.remote = true;
        continue;
      }
      if (a === '-h') {
        out.help = true;
        continue;
      }
      if (a.startsWith('-p=')) {
        out.port = a.split('=')[1];
        continue;
      }
      if (a === '-p') {
        const next = rest[i + 1];
        if (next && !next.startsWith('-')) {
          out.port = next;
          i++;
        }
      }
    }
  }
  return { cmd, flags: out };
}

async function startServer(port: number, enableTunnel: boolean): Promise<void> {
  // Clear any stale cached public URL before starting a new tunnel
  setPublicBaseUrl(null);
  // Ensure server reads the desired port
  process.env.PORT = String(port);
  console.log(status.starting(port, enableTunnel));
  // Start server by importing index (side-effect)
  await import('./index.js');
  // Write PID
  try {
    const pidPath = resolveDataPath('runtime', 'server.pid');
    writeFileSync(pidPath, String(process.pid), 'utf8');
    process.on('exit', () => { try { unlinkSync(pidPath); } catch {} });
    process.on('SIGINT', () => { try { unlinkSync(pidPath); } catch {}; process.exit(0); });
  } catch {}
  // Optionally start Cloudflare quick tunnel
  if (enableTunnel) {
    try {
      const t = await startQuickTunnel(port);
      let printed = false;
      const maybePrint = () => {
        const found = getPublicBaseUrl();
        if (found && !printed) {
          logger.info('Tunnel', 'public_url_ready', { url: found });
          console.log(status.tunnelReady(found));
          printed = true;
          clearInterval(timer);
        }
      };
      const timer = setInterval(maybePrint, 1000);
      t.urlPromise.then((u) => { setPublicBaseUrl(u); maybePrint(); }).catch(() => {});
    } catch (e) {
      console.log(status.tunnelFailed((e as Error).message));
      setPublicBaseUrl(null);
    }
  }
}

async function cmdStart(flags: Record<string, string | boolean>): Promise<void> {
  const port = flags.port ? Number(flags.port) : DEFAULT_PORT;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${flags.port}`);
    process.exit(2);
  }
  const enableTunnel = Boolean(flags.remote);
  await startServer(port, enableTunnel);
}

async function cmdPair(flags: Record<string, string | boolean>): Promise<void> {
  const port = flags.port ? Number(flags.port) : DEFAULT_PORT;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${flags.port}`);
    process.exit(2);
  }
  await startServer(port, false);
  const pinArg = typeof flags.pin === 'string' ? String(flags.pin) : undefined;
  const durationMs = typeof flags.duration === 'string' ? Math.max(10_000, Number(flags.duration)) : 60_000;
  const { pin, expiresAt } = startPairingWindow(durationMs, pinArg);
  const nets = os.networkInterfaces();
  const urls: string[] = [];
  Object.values(nets).forEach(ifaces => {
    ifaces?.forEach(addr => {
      if ((addr as any).family === 'IPv4' && !(addr as any).internal) {
        urls.push(`http://${(addr as any).address}:${port}`);
      }
    });
  });
  const expiresInSec = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  const pub = getPublicBaseUrl();
  
  console.log(`\n${createPairingDisplay(pin, expiresInSec, urls, !!pub)}\n`);
}

async function cmdStop(): Promise<void> {
  const pidPath = resolveDataPath('runtime', 'server.pid');
  if (!existsSync(pidPath)) {
    console.log(status.notRunning());
    return;
  }
  try {
    const pid = Number(readFileSync(pidPath, 'utf8'));
    process.kill(pid, 'SIGINT');
    console.log(status.stopping());
    try { unlinkSync(pidPath); } catch {}
  } catch (e) {
    console.error('Failed to stop server:', (e as Error).message);
  }
}

async function cmdUpdate(): Promise<void> {
  // Delegate to installer script hosted on the website
  const installerUrl = process.env.POCKET_INSTALL_URL || 'https://www.pocket-agent.xyz/install';
  console.log(status.updating());
  const sh = spawn('/bin/bash', ['-lc', `curl -fsSL ${installerUrl} | bash`], { stdio: 'inherit' });
  await new Promise<void>((resolve, reject) => {
    sh.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Installer exited with code ${code}`)));
    sh.on('error', reject);
  });
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || cmd === 'help') {
    printHelp();
    return;
  }
  switch (cmd) {
    case 'start':
      return cmdStart(flags);
    case 'pair':
      return cmdPair(flags);
    case 'stop':
      return cmdStop();
    case 'update':
      return cmdUpdate();
    default:
      console.log(status.unknownCommand(cmd));
      printHelp();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});


