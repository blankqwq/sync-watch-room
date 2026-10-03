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

浏览器 ── STUN / TURN ─────▶ coturn :3478
浏览器 ── HTTPS 视频请求 ─▶ OSS / CDN
浏览器 ◀──── WebRTC 语音 ─▶ 浏览器
```

前端、后端与 coturn 中继分别运行。Nginx 托管构建后的 Vue 应用，并将 `/api/` 和 `/ws` 转发到 Node.js；后端签发临时 TURN REST 凭证，coturn 负责 STUN 和中继流量。视频继续存放在 OSS/CDN，不经过应用容器。

## Docker Compose

1. 交互式生成部署环境文件：

   ```bash
   npm run setup:env
   ```

   无人值守部署可以直接传参：

   ```bash
   scripts/setup-env.sh \
     --domain watch.example.com \
     --turn-domain turn.example.com \
     --public-ip 203.0.113.10 \
     --force
   ```

2. 脚本会自动生成共享密钥和公网 TURN 地址。如需手动更换密钥：

   ```bash
   openssl rand -hex 32
   ```

   将结果写入 `TURN_SHARED_SECRET`，并按公网域名设置 `ALLOWED_ORIGINS`、`STUN_URLS`、`TURN_URLS` 与 `TURN_REALM`。Node.js 后端和 coturn 必须使用相同密钥。

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
| `VITE_ICE_SERVERS` | 默认 Google STUN | 可选的构建期兜底，仅在后端未下发 ICE 服务时使用 |

Vite 变量会在镜像构建时写入前端资源。正常部署由后端动态下发短期 ICE 凭证，因此 TURN 密钥不会进入前端产物。

### 后端运行变量

原生启动会自动读取项目根目录 `.env`，进程环境变量优先生效。Compose 将同一文件中的配置传给后端，并固定使用 `/app/data` 持久卷。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `4173` | 监听端口；Compose 使用 `4174` |
| `WS_PATH` | `/ws` | WebSocket 路径 |
| `SERVE_STATIC` | `true` | 是否由 Node.js 托管 `dist/`；Compose 中关闭 |
| `ALLOWED_ORIGINS` | 空 | 逗号分隔的 WebSocket 浏览器来源；空值允许所有来源 |
| `ADMIN_TOKEN` | 空 | 后台令牌；空值禁用后台接口；部署脚本自动生成 |
| `DATA_DIR` | 项目 `data/` | 旧 JSON 首次迁移路径；Compose 挂载 `/app/data` |
| `DATABASE_URL` | 必填 | PostgreSQL 连接地址；Compose 后端使用内部 `postgres:5432` |
| `POSTGRES_PASSWORD` | 必填 | 本地数据库密码，部署脚本自动生成并保留已有值 |
| `POSTGRES_PORT` | `55432` | 本地数据库端口，仅绑定 `127.0.0.1` |
| `SESSION_COOKIE_SECURE` | 生产环境 `true` | HTTPS 登录 Cookie；开发命令覆盖为 `false` |
| `MACCMS_SOURCES` | 空 | 初始来源：`名称|HTTPS 苹果 CMS V10 视频接口`，多个用逗号分隔；后台设置保存在 `sources.json` |
| `OSS_REGION`、`OSS_BUCKET`、`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、`OSS_PUBLIC_URL` | 空 | OSS 区域、桶、访问密钥和公开访问地址；全部填写才启用上传 |
| `HEARTBEAT_INTERVAL_MS` | `5000` | 无效 WebSocket 检测周期 |
| `WS_MAX_PAYLOAD_BYTES` | `65536` | 单条 WebSocket 消息大小上限 |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | 优雅退出最长等待时间 |
| `DIST_DIR` | 项目 `dist/` | 前后端合并部署时的静态目录 |
| `STUN_URLS` | Google STUN | 返回给客户端的 STUN 地址，多个地址使用逗号分隔 |
| `TURN_URLS` | 空 | 返回给客户端的 TURN 地址，多个地址使用逗号分隔 |
| `TURN_SHARED_SECRET` | 空 | 仅由 Node.js 与 coturn 共享，用于签发临时凭证 |
| `TURN_CREDENTIAL_TTL_SECONDS` | `3600` | TURN 临时凭证有效期 |

生产环境应配置 `ALLOWED_ORIGINS`，例如 `https://watch.example.com`。Origin 校验不等于身份认证，私有房间仍需单独实现权限控制。

## TURN 网络要求

Compose 默认暴露 TCP/UDP `3478` 和 UDP `49160-49200`，云安全组与主机防火墙都要放行同样的端口。`STUN_URLS` 与 `TURN_URLS` 必须填写浏览器可以公网解析的域名，不能使用 `turn` 这类 Docker 内部服务名。

默认中继端口段只适合低并发。每路中继都会同时消耗服务器入站与出站带宽，提高并发前需要扩大端口段并监控流量。对于只允许 TLS 的严格网络，需要由 coturn 直接在 `5349` 或 `443` 等公网端口提供 TURN/TLS，HTTP Nginx 路由不能代理 TURN 流量。

`TURN_DETECT_EXTERNAL_IP=yes` 会让 TURN 容器自动探测要通告的公网 IPv4。多层 NAT 或手动路由环境应优先显式设置 `TURN_EXTERNAL_IP`，容器会自动将其映射到私有中继地址；只有需要覆盖该地址时才设置 `TURN_RELAY_IP`。`TURN_MAX_BPS` 用于限制每个中继会话的每秒字节数，默认 1 MiB/s。

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

资源、来源、用户、登录会话、观看历史以及房间检查点保存在 PostgreSQL。运行中的成员连接和房主选举由一个 Node.js 进程维护，因此后端保持一个副本；横向扩容前需实现跨实例事件投递和房间路由。旧 `data/*.json` 仅在数据库没有对应记录时用于首次迁移，后续写入不会更新旧文件。
