Pocket Server (Node.js)
=======================

Server-authoritative HTTP + WebSocket server for Pocket Agent.

Quick start
-----------

```
npm install
npm run dev
open http://localhost:3000
```

Scripts
-------

- `npm run dev`: start in watch mode (tsx)
- `npm run build`: bundle with esbuild to `dist/`
- `npm start`: run built server from `dist/`
- `npm run lint`: check with Biome
- `npm test`: run tests

Environment
-----------

- `PORT` (default `3000`)
- `ANTHROPIC_API_KEY` (optional, for Anthropic agents)
- Cloudflare tunnel (optional): `CF_TUNNEL_TOKEN`, `CF_TUNNEL_CONFIG`, `CF_TUNNEL_LOGLEVEL`

Auth overview
-------------

Local pairing to obtain a device secret; short‑lived access tokens derived by challenge/signature. HTTP uses `Authorization: Pocket <token>`. WebSocket connects with `?token=...` and is closed with 4401 if invalid.

Key endpoints
-------------

- `GET /health` – basic health
- `GET /ws` – WebSocket endpoint
- `/auth/*` – pairing, token
- `/agent/*` – session lifecycle
- `/fs/*` – file system operations
- `/notifications/*` – device notifications
- `/cloud/*` – background agents (Cursor)

License
-------

Apache‑2.0. See `LICENSE`.
