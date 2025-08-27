#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { put } from '@vercel/blob';

function exec(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'inherit', ...opts });
}

function sha256(filePath) {
  const hash = createHash('sha256');
  return new Promise((resolveHash, reject) => {
    const s = createReadStream(filePath);
    s.on('data', d => hash.update(d));
    s.on('end', () => resolveHash(hash.digest('hex')));
    s.on('error', reject);
  });
}

async function main() {
  const repoRoot = resolve(process.cwd());
  const serverDir = repoRoot; // server repo root

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    console.error('Missing env BLOB_READ_WRITE_TOKEN');
    process.exit(1);
  }

  // Target selection (defaults to host platform/arch). Allows CI matrix to override.
  const targetOs = process.env.TARGET_OS || (process.platform === 'darwin' ? 'darwin' : (process.platform === 'linux' ? 'linux' : 'darwin'));
  const targetArch = process.env.TARGET_ARCH || (process.arch === 'arm64' ? 'arm64' : 'x64');
  const publishMode = process.env.PUBLISH_MODE || 'full'; // 'full' | 'artifacts-only'
  const metadataPath = process.env.METADATA_PATH || '';
  const nodeVersion = process.env.NODE_VERSION || '22.18.0';

  // Determine version: explicit env or bump from manifest if available
  let version = process.env.RELEASE_VERSION || null;
  let manifestUrl = process.env.INSTALL_MANIFEST_URL || process.env.NEXT_PUBLIC_INSTALL_MANIFEST_URL || process.env.BLOB_MANIFEST_URL || null;
  if (!version && manifestUrl) {
    try {
      const res = await fetch(manifestUrl, { cache: 'no-store' });
      if (res.ok) {
        const m = await res.json();
        const current = String(m.version || 'v1.0.0');
        const match = current.match(/^v(\d+)\.(\d+)\.(\d+)$/);
        if (match) {
          const next = `v${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
          version = next;
        }
      }
    } catch {}
  }
  if (!version) version = 'v1.0.0';

  const osArchKey = `${targetOs}-${targetArch}`;
  const workRoot = join(tmpdir(), `pocket-server-${version}-${osArchKey}`);
  const outTgz = join(tmpdir(), `pocket-server-${osArchKey}.tar.gz`);
  const buildBinDir = join(workRoot, 'bin');
  const buildAppDir = join(workRoot, 'app');

  // Clean
  try { rmSync(workRoot, { recursive: true, force: true }); } catch {}
  mkdirSync(buildBinDir, { recursive: true });
  mkdirSync(buildAppDir, { recursive: true });

  // Lint critical rules with Biome (fast). Can be skipped in CI if a separate lint job gates the build.
  if (process.env.SKIP_LINT !== '1') {
    try {
      console.log(`[release] Linting with Biome...`);
      exec('npm run lint', { cwd: serverDir });
      console.log(`[release] Lint passed`);
    } catch (e) {
      console.error('\nBiome lint failed. Fix critical issues before releasing.');
      throw e;
    }
  }

  // Build server (clean first to avoid stale outputs)
  try { exec('rm -rf dist', { cwd: serverDir }); } catch {}
  console.log(`[release] Installing dependencies (npm ci)...`);
  exec('npm ci', { cwd: serverDir });
  console.log(`[release] Building server bundle...`);
  exec('npm run build', { cwd: serverDir });
  exec('npm prune --omit=dev', { cwd: serverDir });
  console.log(`[release] Build complete`);

  // Smoke-test ESM imports in the compiled dist without starting the server
  try {
    console.log(`[release] Verifying ESM bundle (quick import test)...`);
    const esmSmoke = `import('file://${serverDir}/dist/index.js').then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });`;
    exec(`POCKET_NO_START=1 node -e "${esmSmoke.replace(/"/g, '\\"')}"`);
    console.log(`[release] ESM verification passed`);
  } catch (e) {
    console.error('\nESM smoke test failed. Inspect bundle and imports.');
    throw e;
  }

  // Download Node runtime and copy node binary
  const nodePkg = `node-v${nodeVersion}-${targetOs}-${targetArch}`;
  const nodeTgz = join(tmpdir(), `${nodePkg}.tar.gz`);
  const progressFlag = process.env.CURL_PROGRESS === '0' ? '' : '--progress-bar';
  const curlFlags = `${progressFlag} -L --fail --retry 3 --retry-delay 2`;
  console.log(`[release] Downloading Node runtime ${nodePkg}...`);
  exec(`curl ${curlFlags} -o ${nodeTgz} https://nodejs.org/dist/v${nodeVersion}/${nodePkg}.tar.gz`);
  exec(`tar -xzf ${nodeTgz} -C ${tmpdir()}`);
  cpSync(join(tmpdir(), nodePkg, 'bin', 'node'), join(buildBinDir, 'node'));
  try {
    const s = statSync(join(tmpdir(), nodePkg, 'bin', 'node'));
    console.log(`[release] Node runtime ready (${(s.size/1024/1024).toFixed(1)} MB)`);
  } catch {}

  // Copy app
  console.log(`[release] Copying app files into staging dir...`);
  cpSync(resolve(serverDir, 'dist'), resolve(buildAppDir, 'dist'), { recursive: true });
  cpSync(resolve(serverDir, 'package.json'), resolve(buildAppDir, 'package.json'));
  cpSync(resolve(serverDir, 'node_modules'), resolve(buildAppDir, 'node_modules'), { recursive: true });
  writeFileSync(join(workRoot, 'VERSION'), version);

  // Pack
  console.log(`[release] Packing tarball...`);
  exec(`tar -czf ${outTgz} -C ${workRoot} .`);
  const digest = await sha256(outTgz);
  const shaPath = `${outTgz}.sha256`;
  writeFileSync(shaPath, `${digest}`);
  try {
    const s = statSync(outTgz);
    console.log(`[release] Packed ${(s.size/1024/1024).toFixed(1)} MB, sha256=${digest.slice(0,8)}...`);
  } catch {}

  // If artifacts-only mode, stop here after writing files; the workflow will upload

  if (publishMode === 'full') {
    // Legacy single-arch publish: upload directly to Blob (kept for local use only)
    const artifactPath = `pocket-server/${version}/pocket-server-${osArchKey}.tar.gz`;
    console.log(`[release] Uploading to Blob: ${artifactPath} ...`);
    const { url: tgzUrl } = await put(artifactPath, readFileSync(outTgz), {
      access: 'public', addRandomSuffix: false, token, contentType: 'application/gzip', cacheControlMaxAge: 31536000,
    });
    await put(`${artifactPath}.sha256`, readFileSync(shaPath), {
      access: 'public', addRandomSuffix: false, token, contentType: 'text/plain', cacheControlMaxAge: 31536000,
    });
    console.log(`[release] Upload complete: ${tgzUrl}`);
    // Build manifest with only this target (legacy single-arch behavior)
    const manifest = {
      version,
      node: nodeVersion,
      files: {
        [osArchKey]: { url: tgzUrl, sha256: digest },
      }
    };

    const { url: uploadedManifestUrl } = await put('pocket-server/latest.json', Buffer.from(JSON.stringify(manifest, null, 2)), {
      access: 'public', addRandomSuffix: false, allowOverwrite: true, token, contentType: 'application/json', cacheControlMaxAge: 60,
    });

    console.log('\nRelease completed');
    console.log('Version:', version);
    console.log('Tarball:', tgzUrl);
    console.log('Manifest:', uploadedManifestUrl);
    console.log('\nSet INSTALL_MANIFEST_URL to the Manifest URL if not already set.');
  } else {
    // Artifacts-only: write metadata JSON for the aggregator
    if (metadataPath) {
      const meta = { version, node: nodeVersion, os: targetOs, arch: targetArch, url: '', sha256: digest };
      writeFileSync(metadataPath, JSON.stringify(meta, null, 2));
      console.log(`[release] Wrote metadata: ${metadataPath}`);
    }
    console.log('\nArtifact upload completed');
    console.log('Version:', version);
    console.log('Tarball:', tgzUrl);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });




