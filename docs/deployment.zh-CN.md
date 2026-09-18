# 部署指南

[English](./deployment.md)

## 推荐拓扑

```text
浏览器
  │ HTTPS / WSS
  ▼
TLS 负载均衡或反向代理
  │
  ▼
Nginx 前端 :8080 ── /ws ──▶ Node.js 后端 :4174
  │
  └── Vue 静态资源

浏览器 ── HTTPS 视频请求 ──▶ OSS / CDN
浏览器 ◀──── WebRTC 语音 ───▶ 浏览器
```

前端与后端使用独立容器。Nginx 托管构建后的 Vue 应用，并将 `/ws` 转发到 Node.js 服务。视频继续存放在 OSS/CDN，不经过前后端应用容器。

## Docker Compose

1. 创建部署环境文件：

   ```bash
   cp .env.example .env
   ```

2. 至少将 `ALLOWED_ORIGINS` 设置为公网 HTTPS 域名。如果语音需要穿透受限网络，请通过 `VITE_ICE_SERVERS` 配置生产 STUN/TURN 凭证。

3. 构建并启动服务：

   ```bash
   docker compose up --build -d
   docker compose ps
   ```

4. 检查服务状态：

   ```bash
   curl --fail http://localhost:8088/healthz
   curl --fail http://localhost:8088/api/readyz
   ```

5. 更新版本：

   ```bash
   git pull --ff-only
   docker compose build --pull
   docker compose up -d
   ```

TLS 应部署在平台入口、负载均衡、Caddy、Traefik 或其他边缘代理。除 localhost 外，麦克风权限与安全 WebSocket 都需要 HTTPS/WSS。

## 环境变量

### 前端构建变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `VITE_WS_URL` | 空 | 信令服务使用独立域名时填写完整 WebSocket 地址；留空使用同域 `/ws` |
| `VITE_ICE_SERVERS` | 默认 Google STUN | 传给 `RTCPeerConnection` 的 JSON 数组；生产语音建议加入带认证的 TURN |

Vite 变量会在镜像构建时写入前端资源，修改后必须重新构建前端镜像。不要提交长期有效的 TURN 凭证，建议由可信服务签发短期凭证。

### 后端运行变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `4173` | 监听端口；Compose 使用 `4174` |
| `WS_PATH` | `/ws` | WebSocket 路径 |
| `SERVE_STATIC` | `true` | 是否由 Node.js 托管 `dist/`；Compose 中关闭 |
| `ALLOWED_ORIGINS` | 空 | 逗号分隔的 WebSocket 浏览器来源；空值允许所有来源 |
| `HEARTBEAT_INTERVAL_MS` | `5000` | 无效 WebSocket 检测周期 |
| `WS_MAX_PAYLOAD_BYTES` | `65536` | 单条 WebSocket 消息大小上限 |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | 优雅退出最长等待时间 |
| `DIST_DIR` | 项目 `dist/` | 前后端合并部署时的静态目录 |

生产环境应配置 `ALLOWED_ORIGINS`，例如 `https://watch.example.com`。Origin 校验不等于身份认证，私有房间仍需单独实现权限控制。

## 单进程部署

小规模单机环境可以由 Node.js 同时托管前端和 WebSocket：

```bash
npm ci
npm run check
NODE_ENV=production HOST=127.0.0.1 PORT=4173 SERVE_STATIC=true npm start
```

在 `4173` 端口前配置 TLS 反向代理，并正确转发 `/ws` 的 WebSocket Upgrade。使用 systemd、Docker 或其他进程管理器托管 Node.js，并确保其发送 `SIGTERM` 且等待优雅退出。

## 健康检查与日志

- `GET /healthz` 用于存活检查。
- `GET /readyz` 用于就绪检查；由 Node.js 托管前端时，还会检查 `dist/index.html` 是否存在。
- 生产日志以单行 JSON 输出到 stdout。应由容器平台采集 stdout/stderr，不在容器内写日志文件。

## 扩容边界

房间状态、房主身份和最近消息仍保存在单个 Node.js 进程中，因此后端应保持一个副本。横向扩容前，需要实现共享房间状态、跨实例事件投递，并确保同一房间成员路由到同一个状态所有者。直接使用轮询负载均衡会拆散房间并破坏同步。
