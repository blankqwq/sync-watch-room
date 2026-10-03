<img src="./public/couple-tv-icon.png" alt="sync-watch-room project icon: a couple watching television" width="96" />

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

## Project Icon

The project icon shows a couple leaning together while watching television. Its simple blue and coral shapes represent shared viewing and companionship. The icon was generated with imagegen and is stored as a 256 × 256 PNG with a transparent background at [`public/couple-tv-icon.png`](./public/couple-tv-icon.png).

This image is the default project identity, used in the application header, browser favicon, and documentation. **Admin → Application settings** lets each deployment customize the application name and icon by uploading a PNG, JPEG, or WebP up to 512 KB, or providing an image URL. Settings persist in PostgreSQL and update the header, browser title, and favicon. **Restore default icon** selects this project icon.

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
- **WebRTC DataChannel** carries typing events and peer latency measurements. Playback commands use the authoritative WebSocket channel.
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
npm run setup:env -- --domain localhost --turn-domain localhost
# Set DATABASE_URL in .env and start the local PostgreSQL service:
docker compose up -d --wait postgres
npm run dev
```

Open [http://localhost:4173](http://localhost:4173).

During development:

- Vite runs the frontend on port `4173`.
- The Node.js WebSocket server runs on port `4174`.
- Vite proxies `/ws` and `/api` to the backend.
- The development backend accepts `localhost:4173` and `127.0.0.1:4173`, overriding production origins from `.env` for local development.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the frontend and WebSocket server in development mode |
| `npm run dev:web` | Start only the Vite frontend |
| `npm run dev:server` | Start only the Node.js server with file watching |
| `npm run build` | Build the Vue application into `dist/` |
| `npm run preview` | Preview the production frontend build |
| `npm start` | Serve `dist/` and WebSocket connections from Node.js |
| `npm test` | Run server and HLS availability tests |
| `npm run check` | Run server tests and the production frontend build |

## Media Sources

The home page groups episodes into film/series cards with posters and grid/list views. Visitors can browse without login; accounts are required to create/join rooms and save personal progress. The **Admin** panel uses `ADMIN_TOKEN` for rooms, resources, provider presets, and OSS files.

A recommendation banner above search shows up to five library resources, falling back to the latest public provider results when the library is empty. It rotates every six seconds with pause, previous/next, and episode selection controls. Rotation pauses on hover, keyboard focus, or a hidden page and respects reduced motion. The layout adapts to mobile screens. Banners, resource cards, and list rows have fixed heights; long titles, descriptions, and metadata truncate with ellipses and expose their full text through native hover tooltips.

Native backend startup reads the project-root `.env`; inherited environment variables take precedence. Set `DATABASE_URL` for PostgreSQL. On first startup, legacy JSON files from `DATA_DIR` are imported as seeds; existing database records take precedence. New writes go to PostgreSQL.

To enable Alibaba OSS browser uploads, set `OSS_REGION`, `OSS_BUCKET`, `OSS_ACCESS_KEY_ID`, `OSS_ACCESS_KEY_SECRET`, and the public HTTPS `OSS_PUBLIC_URL` in `.env`. The server signs a short-lived PUT URL; the browser uploads MP4/WebM directly and the server verifies the object before publishing it. Configure bucket CORS for PUT from your site and make the published video readable through `OSS_PUBLIC_URL`. The UI supports files up to 1 GiB.

In **Admin → Resources**, use **Choose from OSS** beside the video URL when adding or editing a resource. Filter objects by prefix (clear it to browse all), load more pages, and select an MP4, WebM, or M3U8 file. Its public URL is filled automatically; an empty title defaults to the filename. Save the resource to publish it.

HLS selections are checked in the current browser for readable manifests, the first fragment, and associated initialization files/keys, including CORS. Episode details check the first episode of each line. Confirmed 404/410 or invalid manifests are hidden for ten minutes in the current page session. Probe timeouts, 403, CORS and network errors defer to the actual player. All members can use **Retry loading** to immediately clear a local failure and reload; working alternatives remain available, and library selections try alternate lines. Confirmed player failures also temporarily hide the URL and can be retried immediately. Cross-origin failures show a dedicated loading hint; explicit CORS errors, HTTP errors, timeouts, and offline state have distinct messages. Fatal HLS network failures stop loading; media decoding gets at most one recovery attempt. Viewers can switch lines. Passing this check does not establish that every fragment or codec will play.

You can also **Upload file** directly from this form. MP4/WebM uploads show progress and can be cancelled. After the server verifies the uploaded file, its URL fills the current form while existing title, poster, and description stay intact. **Save resource** publishes or updates it. Closing the form does not delete an uploaded OSS object; you can select it later.

MacCMS V10 sources can be added, edited, published, disabled, or deleted in the admin panel. Settings persist in PostgreSQL. Clients search a unified catalog without provider identities; equivalent titles are merged using movie identifiers or normalized title/year metadata. Signed-in viewers choose episodes and playback lines. Admins can also import episodes into the curated catalog and edit their title, poster, and description.

`MACCMS_SOURCES=Label|https://example.com/api.php/provide/vod/` supplies initial sources (comma-separated for multiple entries). Once database settings exist, saved admin settings take precedence. XML provider paths ending in `/at/xml/` are normalized to JSON. [Feifan's provider documentation](https://ffzy.tv/help/) publishes a compatible M3U8 endpoint at `https://api.ffzyapi.com/api.php/provide/vod/from/ffm3u8/`. Playback URLs must allow browser cross-origin access.

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

- The server distributes authoritative playback state every 50ms; playback control does not depend on a P2P connection.
- Small drift is corrected with brief playback-rate changes. Drift above 150ms pauses the room to align positions; starts require every member to acknowledge the same sequence and align within 80ms.
- Buffer loss, stale progress reports, or signaling latency above 150ms pause the room. A browser stops locally when its 300ms synchronization lease expires, rather than continuing alone.
- Every member needs at least 1.5 seconds of playable buffer before a shared start. Returning from a disconnected or hidden page requires synchronization again. [Background browser timers can be throttled](https://developer.chrome.com/blog/timer-throttling-in-chrome-88/), so hidden pages pause shared playback.
- A member connection closing pauses the room and requires host confirmation to continue; remaining clients do not automatically resume alone.

The target is playback drift below one second; poor connectivity is handled by pausing and waiting. A fully disconnected or suspended device cannot receive new frames or seek commands, so continuous playback is not promised in that state.

After this synchronization update, refresh every room client before rejoining. The server rejects clients using the previous synchronization protocol.

The controls below the player offer the actual quality variants provided by an HLS source, including an automatic mode. Each viewer chooses independently without changing the shared film or timeline. Buffer loss during a switch still pauses the room under the synchronization policy. Single-variant sources and direct MP4/WebM files display their original quality; browsers limited to native HLS use automatic quality.

## Voice Processing

Voice uses WebRTC audio tracks. The microphone settings include:

- RNNoise-based real-time noise suppression
- A true noise-suppression on/off switch
- Microphone volume from `0%` (silent) to `250%` (amplified)
- Microphone mute and per-member voice state

Direct peer connections do not send voice through the room server. When direct connectivity fails, the backend issues short-lived credentials for the included coturn service and WebRTC automatically tries TURN relay. Member network status shows `P2P` or `TURN` for the selected path. TURN traffic consumes server bandwidth and must be capacity-planned.

## Production Deployment

The repository includes separate production services for the Vue frontend, Node.js signaling backend, PostgreSQL database, and coturn relay, plus an Nginx WebSocket reverse proxy, health checks, graceful shutdown, and a Docker Compose definition.

```bash
npm run setup:env
# Review the generated domain, public IP, and TURN settings before exposing the service.
docker compose up --build -d
```

Open `http://localhost:8088`. Put an HTTPS load balancer or reverse proxy in front of this endpoint in production. See the [deployment guide](./docs/deployment.md) for environment variables, standalone deployment, health endpoints, upgrades, and scaling limits.

PostgreSQL stores resources, sources, users, sessions, watch history, and room checkpoints. Active members and WebRTC connections remain owned by one backend process; recent rooms can recover after reconnect/restart. Keep one backend replica until cross-instance event routing is implemented.

Viewing history supports deleting individual entries and clearing unavailable entries. Removed library resources, unavailable series, and disabled providers are marked unavailable. Network entries with an enabled public provider remain available even when they have not been imported into the library. Series are grouped automatically in the library. The standalone collection feature has been removed; admins can import an entire series directly into the library.

## Production Backlog

For an internet-facing service, the next application-level controls should include:

- Private-room authorization and configurable retention
- TURN capacity limits and usage monitoring
- Per-user request throttling and stronger authorization-aware validation
- Shared room state and room-aware multi-instance routing
- Observability for WebSocket, WebRTC, media, and host-failover events

## Project Status

This is a runnable single-instance version with user accounts, private resume history, merged provider search, ordered playlists, and PostgreSQL persistence. Active signaling and WebRTC routing require a single backend replica.

## Contributing

Issues and pull requests are welcome. Keep changes focused, follow the existing Vue and Node.js style, and include verification steps for behavior that affects room synchronization or media playback.

## License

[MIT](./LICENSE)
