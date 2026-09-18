# Deployment Guide

[简体中文](./deployment.zh-CN.md)

## Recommended Topology

```text
Browser
  │ HTTPS / WSS
  ▼
TLS load balancer or reverse proxy
  │
  ▼
Nginx frontend :8080 ── /ws ──▶ Node.js backend :4174
  │
  └── static Vue assets

Browser ── HTTPS media requests ──▶ OSS / CDN
Browser ◀──── WebRTC voice ───────▶ Browser
```

The frontend and backend are separate containers. Nginx serves the built Vue application and forwards `/ws` to the Node.js service. Video remains on OSS/CDN and does not pass through either application container.

## Docker Compose

1. Create the deployment environment file:

   ```bash
   cp .env.example .env
   ```

2. Set at least `ALLOWED_ORIGINS` to the public HTTPS origin. Configure `VITE_ICE_SERVERS` with production STUN/TURN credentials when voice must work across restrictive networks.

3. Build and start both services:

   ```bash
   docker compose up --build -d
   docker compose ps
   ```

4. Check readiness:

   ```bash
   curl --fail http://localhost:8088/healthz
   curl --fail http://localhost:8088/api/readyz
   ```

5. Apply an update without removing persistent infrastructure around the app:

   ```bash
   git pull --ff-only
   docker compose build --pull
   docker compose up -d
   ```

Run TLS at the platform ingress, load balancer, Caddy, Traefik, or another edge proxy. Microphone access and secure WebSockets require HTTPS/WSS outside localhost.

## Environment Variables

### Frontend build variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_WS_URL` | empty | Full WebSocket URL for a separate signaling domain. Empty uses same-origin `/ws`. |
| `VITE_ICE_SERVERS` | default Google STUN | JSON array passed to `RTCPeerConnection`. Add an authenticated TURN service for production voice reliability. |

Vite variables are embedded at image build time. Rebuild the frontend image after changing them. Never commit long-lived TURN credentials; prefer short-lived credentials issued by a trusted service.

### Backend runtime variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Listen address |
| `PORT` | `4173` | Listen port; Compose sets `4174` |
| `WS_PATH` | `/ws` | WebSocket endpoint |
| `SERVE_STATIC` | `true` | Serve `dist/` from Node.js; Compose disables it |
| `ALLOWED_ORIGINS` | empty | Comma-separated WebSocket browser origins; empty accepts all origins |
| `HEARTBEAT_INTERVAL_MS` | `5000` | Dead WebSocket detection interval |
| `WS_MAX_PAYLOAD_BYTES` | `65536` | Maximum WebSocket message size |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Maximum graceful shutdown duration |
| `DIST_DIR` | project `dist/` | Static build path for combined deployments |

Set `ALLOWED_ORIGINS` in production, for example `https://watch.example.com`. Origin validation is not authentication; private rooms still need an authorization layer.

## Standalone Deployment

For a small single-host deployment, Node.js can serve both the built frontend and WebSocket endpoint:

```bash
npm ci
npm run check
NODE_ENV=production HOST=127.0.0.1 PORT=4173 SERVE_STATIC=true npm start
```

Place a TLS reverse proxy in front of port `4173` and forward WebSocket upgrades on `/ws`. Keep the Node.js process under systemd, Docker, or another supervisor that sends `SIGTERM` and respects the shutdown timeout.

## Health and Logs

- `GET /healthz` is a liveness probe.
- `GET /readyz` checks process readiness and, when Node.js serves the frontend, verifies that `dist/index.html` exists.
- Production server logs are newline-delimited JSON on stdout. Collect stdout/stderr with the container platform rather than writing log files inside the container.

## Scaling Boundary

Room state, host ownership, and recent messages currently live in one Node.js process. Keep the backend at one replica. Horizontal scaling requires shared room state, cross-instance event delivery, and routing all members of a room to the same state owner. Plain round-robin replicas will split rooms and break synchronization.
