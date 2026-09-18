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

Browser ── STUN / TURN ──────────▶ coturn :3478
Browser ── HTTPS media requests ─▶ OSS / CDN
Browser ◀──── WebRTC voice ──────▶ Browser
```

The frontend, backend, and coturn relay run as separate services. Nginx serves the built Vue application and forwards `/ws` to Node.js. The backend signs temporary TURN REST credentials, while coturn handles STUN and relay traffic. Video remains on OSS/CDN and does not pass through the application containers.

## Docker Compose

1. Create the deployment environment file:

   ```bash
   cp .env.example .env
   ```

2. Generate a secret and set the public TURN URLs:

   ```bash
   openssl rand -hex 32
   ```

   Put the result in `TURN_SHARED_SECRET`. Set `ALLOWED_ORIGINS`, `STUN_URLS`, `TURN_URLS`, and `TURN_REALM` for the public domains. The backend and coturn must use the same shared secret.

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
| `VITE_ICE_SERVERS` | default Google STUN | Optional build-time fallback used only when the backend does not provide ICE servers |

Vite variables are embedded at image build time. The normal deployment receives short-lived ICE credentials from the backend, so TURN secrets are never included in frontend assets.

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
| `STUN_URLS` | Google STUN | Comma-separated STUN URLs returned to clients |
| `TURN_URLS` | empty | Comma-separated TURN URLs returned to clients |
| `TURN_SHARED_SECRET` | empty | Secret shared only by Node.js and coturn for temporary credentials |
| `TURN_CREDENTIAL_TTL_SECONDS` | `3600` | Lifetime of issued TURN credentials |

Set `ALLOWED_ORIGINS` in production, for example `https://watch.example.com`. Origin validation is not authentication; private rooms still need an authorization layer.

## TURN Network Requirements

The Compose service publishes TCP/UDP `3478` and UDP `49160-49200`. Open the same ports in the cloud firewall and host firewall. Set `STUN_URLS` and `TURN_URLS` to a hostname that browsers can resolve publicly; Docker service names such as `turn` are not valid browser endpoints.

The default relay range is intentionally small for a low-volume deployment. Each relayed call consumes server ingress and egress bandwidth. Increase the range and monitor traffic before increasing concurrency. For restrictive networks that only allow TLS, terminate TURN/TLS directly in coturn on a public port such as `5349` or `443`; an HTTP Nginx location cannot proxy TURN traffic.

`TURN_DETECT_EXTERNAL_IP=yes` asks the TURN container to discover the advertised external IPv4 address. Prefer an explicit `TURN_EXTERNAL_IP` on multi-NAT or manually routed hosts. The container automatically maps it to its private relay address; `TURN_RELAY_IP` is available only when that address must be overridden. `TURN_MAX_BPS` limits each relay session in bytes per second and defaults to 1 MiB/s.

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
