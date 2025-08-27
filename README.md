Pocket Server (open source)
===========================

Pocket Server is the server component of Pocket Agent — a Claude Code‑style local/remote coding agent you control from your phone. The server runs on your machine and exposes HTTP + WebSocket APIs; the mobile app pairs with it to stream terminal, edit files, search the web, and run tools.

- **Local coding agent** you can approve or auto‑run, with bash, editor, and web‑search tools
- **Best‑in‑class mobile terminal**: fast, touch‑optimized, multi‑tab sessions with smooth streaming
- **File explorer & editor**: browse, view, edit, and diff files from the phone
- **Quick search** across your repo and telescopic fuzzy search
- **Cloud background agents**: launch autonomous coding jobs on VMs from GitHub repos; monitor, review diffs, and approve PRs
- **Notifications**: opt‑in device notifications for task updates
- **Secure pairing + tokens**: device PIN pairing (local‑only), short‑lived access tokens for HTTP/WS
- **Remote access** via optional Cloudflare tunnel (`pocket-server start --remote`)
- **Multi‑platform releases**: macOS (arm64), Linux and Mac Intel support coming soon — with bundled Node v22.18.0

What you get
------------

- Server‑authoritative conversations and sessions (no state in the app)
- Event‑driven protocol over WebSocket (`/ws`) and REST endpoints (Hono)
- Bundled Node.js runtime (v22.18.0) in releases — no system Node required
- Multi‑architecture releases: macOS (arm64) available now, Linux and Mac Intel support in development

Install (recommended)
---------------------

Use the one‑liner installer (adds a `pocket-server` CLI to `~/.pocket-server/bin`):

```bash
curl -fsSL https://www.pocket-agent.xyz/install | bash
```

Quick start from your terminal
------------------------------

```bash
# 1) Pair your phone to this machine (PIN shows in the terminal)
pocket-server pair

# 2) Start locally (default port 3000)
pocket-server start

# 3) Optional: expose a temporary remote URL via Cloudflare
pocket-server start --remote

> Remote access notes
> - macOS (arm64): `--remote` works out‑of‑the‑box. The CLI auto‑downloads `cloudflared` on first run (no account/config needed) and prints a public HTTPS URL.
> - Linux and Mac Intel: Remote access support coming soon
```

Use it with the Pocket mobile app
---------------------------------

1. Install Pocket Server (above)
2. Open the app → Pair this device → Enter the 6‑digit PIN from `pocket-server pair`
3. Start the server (`pocket-server start`), then connect from the app
4. For remote access, run `pocket-server start --remote` and paste the public URL in the app

CLI reference
-------------

```
pocket-server <command> [flags]

Commands
  start        Start the server
  pair         Start the server and open pairing window
  stop         Stop a running server
  update       Update to the latest release via installer
  help         Show help

Flags
  --port, -p <n>        Port to listen on (default: 3000 or $PORT)
  --remote, -r          Start Cloudflare tunnel for remote access
  --duration <ms>       Pairing window duration (pair only; default: 60000)
  --pin <code>          Override generated PIN (pair only)
```

How Pocket works (high level)
-----------------------------

- Pairing (local‑only): your phone pairs over LAN to obtain a device secret
- Auth tokens: short‑lived access tokens are derived from the device secret; HTTP uses `Authorization: Pocket <token>`, WS connects with `?token=...` (invalid tokens close with 4401)
- Server‑authoritative: sessions and messages live on the server under `~/.pocket-server/data/`
- Event stream: UI subscribes to events; no client‑side shared state

Troubleshooting
---------------

- Can’t connect from phone on local network
  - Ensure both phone and server machine are on the same Wi‑Fi/LAN
  - Check firewall allows inbound connections to your chosen port (default 3000)
  - Try `pocket-server start --port 3010` and connect to that port

- Pairing fails
  - Pairing only works on local network for security; remote pairing is disabled
  - Keep the terminal with `pocket-server pair` open until you finish pairing

- Remote URL stops working
  - Cloudflare quick tunnel URLs change after restart; run `pocket-server start --remote` again and update the URL in the app

- Update to the latest version
  - Run `pocket-server update` (re‑runs the installer and switches `latest.json` version)

Advanced: run from source (development)
---------------------------------------

```bash
cd pocket-server
npm install
npm run dev     # watch mode (tsx)

# build & run from the compiled bundle (for development/testing)
npm run build
npm start
```

Environment
-----------

- `PORT` (default `3000`)
- `ANTHROPIC_API_KEY` (optional; enables Anthropic‑powered agents)
- Cloudflare tunnel (optional): `CF_TUNNEL_TOKEN`, `CF_TUNNEL_CONFIG`, `CF_TUNNEL_LOGLEVEL`

Key endpoints (reference)
-------------------------

- `GET /health` – basic health
- `GET /ws` – WebSocket endpoint
- `/auth/*` – pairing, token
- `/agent/*` – session lifecycle
- `/fs/*` – file system operations
- `/notifications/*` – device notifications
- `/cloud/*` – background agents (Cursor)

Security notes
--------------

- Pairing is local‑only; tokens are short‑lived and required for HTTP/WS
- The mobile app never stores server conversations; the server is authoritative
- Releases bundle Node v22.18.0 for consistency across platforms

Uninstall
---------

Remove the install directory (this also removes your local sessions):

```bash
rm -rf ~/.pocket-server
```

License
-------

Apache‑2.0. See `LICENSE`.
