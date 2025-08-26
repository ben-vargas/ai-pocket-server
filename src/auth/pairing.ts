import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { resolveDataPath } from '../shared/paths';

type PairingState = {
  active: boolean;
  pinHash?: string; // sha256 of pin
  startedAt?: string;
  expiresAt?: string;
};

const PAIRING_PATH = resolveDataPath('runtime', 'pairing.json');

function ensureStateFile(): void {
  const dir = dirname(PAIRING_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(PAIRING_PATH)) writeFileSync(PAIRING_PATH, JSON.stringify({ active: false }, null, 2), 'utf8');
}

export function getPairingState(): PairingState {
  try {
    ensureStateFile();
    const raw = readFileSync(PAIRING_PATH, 'utf8');
    const data = JSON.parse(raw) as PairingState;
    return data;
  } catch {
    return { active: false };
  }
}

function savePairingState(state: PairingState): void {
  ensureStateFile();
  writeFileSync(PAIRING_PATH, JSON.stringify(state, null, 2), 'utf8');
}

export function startPairingWindow(durationMs = 60_000, pin?: string): { pin: string; expiresAt: string } {
  const generated = typeof pin === 'string' && pin.length === 6 ? pin : String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const pinHash = crypto.createHash('sha256').update(generated).digest('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + durationMs);
  const state: PairingState = {
    active: true,
    pinHash,
    startedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  };
  savePairingState(state);
  return { pin: generated, expiresAt: state.expiresAt! };
}

export function stopPairingWindow(): void {
  savePairingState({ active: false });
}

export function isPairingActive(): boolean {
  const s = getPairingState();
  if (!s.active) return false;
  if (!s.expiresAt) return false;
  return Date.now() < new Date(s.expiresAt).getTime();
}

export function verifyPin(pin: string): boolean {
  const s = getPairingState();
  if (!s.active || !s.pinHash || !s.expiresAt) return false;
  if (Date.now() >= new Date(s.expiresAt).getTime()) return false;
  const hash = crypto.createHash('sha256').update(pin).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(s.pinHash, 'hex'));
}


