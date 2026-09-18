# sync-watch-room

**English** | [简体中文](./README.zh-CN.md)

A lightweight synchronized watch room built with Vue 3, Node.js, WebSocket, and WebRTC. Create a room, load a video from OSS/CDN, and watch it together with synchronized playback, text chat, and real-time voice.

> This project aims to minimize perceived playback drift. It does not claim zero-latency playback across different networks and devices.

![Desktop room](./docs/screenshots/room-desktop.png)

| Mobile player | Microphone controls |
| --- | --- |
| <img src="./docs/screenshots/room-mobile.png" alt="Mobile synchronized player" width="320" /> | <img src="./docs/screenshots/microphone-settings.png" alt="Microphone noise suppression and volume controls" width="640" /> |

## Features

- Scheduled play, pause, and seek commands based on a calibrated server clock
- Smooth drift correction for small playback differences and direct seeking for large differences
- Buffer-aware shared starts that wait for room members to become playable
- Per-member buffer progress, latency, packet loss, voice state, and connection health
- Real-time chat, typing indicators, room events, and member presence
- WebRTC voice chat with mute, RNNoise suppression, and microphone volume control
- Short-lived TURN credentials with automatic relay fallback when direct WebRTC connectivity fails
- WebSocket heartbeat detection, reconnectable room state, and automatic host failover
- MP4 and WebM playback through the browser, plus HLS/M3U8 playback through `hls.js`
- Responsive desktop and mobile interfaces with fullscreen playback controls

## Architecture

```text
                         playback state / chat / signaling
┌──────────────┐        WebSocket        ┌──────────────────┐
│   Browser A  │ ◀────────────────────▶ │  Node.js server  │
└──────┬───────┘                         └──────────────────┘
       │  WebRTC DataChannel + voice              ▲
       ▼                                           │
┌──────────────┐                                   │
│   Browser B  │ ──────────────────────────────────┘
└──────┬───────┘
       │ HTTPS media requests
       ▼
┌──────────────┐
│   OSS / CDN  │
└──────────────┘
```

- **WebSocket** owns recoverable room state, chat, heartbeat, host election, and WebRTC signaling.
- **WebRTC DataChannel** carries low-latency playback control events when peers are connected.
- **WebRTC audio tracks** provide peer-to-peer voice communication.
- **OSS/CDN** stores and distributes video files. Video bytes are not sent through the room server.

## Requirements

- Node.js 20.19 or newer
- A modern browser with WebSocket, WebRTC, Web Audio, and MediaSource support
- HTTPS in production for microphone access and secure WebSocket connections

## Quick Start

```bash
git clone https://github.com/<your-account>/sync-watch-room.git
cd sync-watch-room
npm install
npm run dev
```

Open [http://localhost:4173](http://localhost:4173).

During development:

- Vite runs the frontend on port `4173`.
- The Node.js WebSocket server runs on port `4174`.
- Vite proxies `/ws` to the WebSocket server.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the frontend and WebSocket server in development mode |
| `npm run dev:web` | Start only the Vite frontend |
| `npm run dev:server` | Start only the Node.js server with file watching |
| `npm run build` | Build the Vue application into `dist/` |
| `npm run preview` | Preview the production frontend build |
| `npm start` | Serve `dist/` and WebSocket connections from Node.js |
| `npm test` | Run the Node.js server tests |
| `npm run check` | Run server tests and the production frontend build |

## Media Sources

The room host can load:

- MP4, WebM, or other browser-supported direct media URLs
- HLS/M3U8 playlists supported by `hls.js` or native Safari HLS
- Private OSS/CDN assets exposed through short-lived signed URLs

For reliable seeking and startup:

- Enable HTTPS and CORS on the media origin.
- Return the correct `Content-Type` and `Content-Length` headers.
- Enable HTTP Range requests for MP4/WebM assets.
- Keep every room member on the exact same media version.

Magnet links and ordinary BitTorrent peers are not played directly. A production integration should import authorized content through a separate download/transcode worker and publish the result to OSS/CDN.

## Playback Synchronization

Host actions carry an `executeAt` timestamp and are sent before their execution time. Clients execute against a calibrated server clock instead of reacting immediately when a message arrives.

- Drift below 80ms: keep the current playback rate
- Drift from 80ms to 300ms: briefly use `0.98x` or `1.02x` playback
- Drift above 300ms: seek to the authoritative room position
- Insufficient peer buffer: pause the shared start and schedule a new start after members recover

## Voice Processing

Voice uses WebRTC audio tracks. The microphone settings include:

- RNNoise-based real-time noise suppression
- A true noise-suppression on/off switch
- Microphone volume from `0%` (silent) to `250%` (amplified)
- Microphone mute and per-member voice state

Direct peer connections do not send voice through the room server. When direct connectivity fails, the backend issues short-lived credentials for the included coturn service and WebRTC automatically tries TURN relay. Member network status shows `P2P` or `TURN` for the selected path. TURN traffic consumes server bandwidth and must be capacity-planned.

## Production Deployment

The repository includes separate production services for the Vue frontend, Node.js signaling backend, and coturn relay, plus an Nginx WebSocket reverse proxy, health checks, graceful shutdown, and a Docker Compose definition.

```bash
npm run setup:env
# Review the generated domain, public IP, and TURN settings before exposing the service.
docker compose up --build -d
```

Open `http://localhost:8088`. Put an HTTPS load balancer or reverse proxy in front of this endpoint in production. See the [deployment guide](./docs/deployment.md) for environment variables, standalone deployment, health endpoints, upgrades, and scaling limits.

The server keeps rooms and chat history in process memory. Run one backend replica unless room state is moved to shared storage and WebSocket routing is made room-aware.

## Production Backlog

For an internet-facing service, the next application-level controls should include:

- Persistent room and message storage
- Authentication and room authorization
- TURN capacity limits and usage monitoring
- Per-user request throttling and stronger authorization-aware validation
- Shared room state and room-aware multi-instance routing
- Observability for WebSocket, WebRTC, media, and host-failover events

## Project Status

This repository is an early-stage reference implementation. Synchronization, chat, voice, buffering, heartbeat, host failover, health checks, graceful shutdown, and container deployment are implemented. Persistence, authentication, and horizontal scaling remain future work.

## Contributing

Issues and pull requests are welcome. Keep changes focused, follow the existing Vue and Node.js style, and include verification steps for behavior that affects room synchronization or media playback.

## License

[MIT](./LICENSE)
