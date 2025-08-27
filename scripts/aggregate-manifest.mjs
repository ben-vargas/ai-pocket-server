#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { put } from '@vercel/blob';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function main() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    console.error('Missing env BLOB_READ_WRITE_TOKEN');
    process.exit(1);
  }

  // Accept explicit META_* or scan META_DIR for meta-*.json
  const explicitPaths = [
    process.env.META_DARWIN_ARM64,
    process.env.META_DARWIN_X64,
    process.env.META_LINUX_X64,
    process.env.META_LINUX_ARM64,
  ].filter(Boolean);

  let metaPaths = explicitPaths;
  const metaDir = process.env.META_DIR;
  if (metaPaths.length === 0 && metaDir) {
    const entries = readdirSync(metaDir).filter((f) => f.startsWith('meta-') && f.endsWith('.json'));
    metaPaths = entries.map((f) => join(metaDir, f)).filter((p) => statSync(p).isFile());
  }

  if (metaPaths.length === 0) {
    console.error('No metadata provided. Set META_DIR to a directory containing meta-*.json.');
    process.exit(1);
  }

  const metas = metaPaths.map(readJson);
  const version = metas[0].version;
  const node = metas[0].node;

  const files = {};
  for (const m of metas) {
    files[`${m.os}-${m.arch}`] = { url: m.url, sha256: m.sha256 };
  }

  const manifest = { version, node, files };

  const { url } = await put('pocket-server/latest.json', Buffer.from(JSON.stringify(manifest, null, 2)), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true, token, contentType: 'application/json', cacheControlMaxAge: 60,
  });

  console.log('Published manifest:', url);
}

main().catch((e) => { console.error(e); process.exit(1); });


