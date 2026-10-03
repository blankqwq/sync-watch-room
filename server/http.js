import { createReadStream, existsSync, statSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { extname, join, resolve, sep } from "node:path";
import { sourcePresets } from "./sources.js";
import { episodeKey } from "./discovery.js";
import { plainText } from "./text.js";

const mimeTypes = {
  ".aac": "audio/aac",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".m4s": "video/iso.segment",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ts": "video/mp2t",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
};

function setSecurityHeaders(response) {
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "SAMEORIGIN");
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(body);
}

async function readJson(request, limit = 16384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function authorized(request, token) {
  const value = request.headers.authorization?.replace(/^Bearer /, "") || "";
  const actual = Buffer.from(value);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function cacheControl(filePath) {
  if (filePath.endsWith("index.html")) return "no-cache";
  if (filePath.includes(`${sep}assets${sep}`)) return "public, max-age=31536000, immutable";
  return "public, max-age=3600";
}

function resolveStaticFile(distDir, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const requestedPath = decodedPath === "/" ? "/index.html" : decodedPath;
  let filePath = resolve(distDir, `.${requestedPath}`);
  if (filePath !== distDir && !filePath.startsWith(`${distDir}${sep}`)) return null;
  if (!existsSync(filePath) && !extname(filePath)) filePath = join(distDir, "index.html");
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) return null;
  return filePath;
}

function serveFile(request, response, filePath) {
  const fileSize = statSync(filePath).size;
  const range = request.headers.range;
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl(filePath),
    "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
  };

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      response.writeHead(416, { "Content-Range": `bytes */${fileSize}` }).end();
      return;
    }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), fileSize - 1) : fileSize - 1;
    if (start > end || start >= fileSize) {
      response.writeHead(416, { "Content-Range": `bytes */${fileSize}` }).end();
      return;
    }
    response.writeHead(206, {
      ...headers,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(filePath, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, { ...headers, "Content-Length": fileSize });
  if (request.method === "HEAD") response.end();
  else createReadStream(filePath).pipe(response);
}

export function createHttpHandler(config, getServiceStatus, { catalog, accounts, discovery, settings, realtime, oss, sources, fetchMacCms }) {
  function historySeries(media) {
    const collection = catalog.group(media.libraryGroupId);
    const item = collection?.items.find((item) => item.id === media.collectionResourceId || (media.episodeIdentity && catalog.identity(item) === media.episodeIdentity));
    return { collection, item };
  }
  function historyAvailable(media) {
    if (media.collectionId) return false;
    if (media.libraryGroupId) return Boolean(historySeries(media).item);
    if (media.references?.length) return media.references.some((reference) => {
      const source = sources.find(reference.sourceId);
      return source?.enabled && source.public;
    });
    if (media.resourceId) return Boolean(catalog.find(media.resourceId)?.enabled);
    return Boolean(media.url);
  }
  return async (request, response) => {
    setSecurityHeaders(response);
    const url = new URL(request.url || "/", "http://localhost");

    try {
      const adminRequest = url.pathname.startsWith("/api/admin/");
      if (adminRequest) {
        if (!config.adminToken) return sendJson(response, 503, { error: "Admin access is not configured" });
        if (!authorized(request, config.adminToken)) return sendJson(response, 401, { error: "Invalid admin token" });
      }
      if (["/api/settings", "/api/admin/settings"].includes(url.pathname) && request.method === "GET") {
        return sendJson(response, 200, { settings: settings.read() });
      }
      if (url.pathname === "/api/admin/settings" && request.method === "PUT") {
        return sendJson(response, 200, { settings: await settings.update(await readJson(request, 1024 * 1024)) });
      }
      if (url.pathname === "/api/account" && request.method === "GET") {
        return sendJson(response, 200, { user: await accounts.getUser(request) });
      }
      if (["/api/auth/login", "/api/auth/register", "/api/auth/logout"].includes(url.pathname) && request.method === "POST") {
        const origin = request.headers.origin;
        const allowed = config.allowedOrigins;
        if (origin && allowed.length && !allowed.includes("*") && !allowed.includes(origin)) return sendJson(response, 403, { error: "请求来源不允许" });
        if (url.pathname === "/api/auth/logout") {
          const key = accounts.sessionKey(request);
          response.setHeader("Set-Cookie", await accounts.logout(request));
          realtime.endSession(key);
          return sendJson(response, 200, { user: null });
        }
        const input = await readJson(request);
        const result = url.pathname.endsWith("/register") ? await accounts.register(request, input) : await accounts.login(request, input);
        response.setHeader("Set-Cookie", result.cookie);
        return sendJson(response, url.pathname.endsWith("/register") ? 201 : 200, { user: result.user });
      }
      if (url.pathname === "/api/history" && request.method === "GET") {
        const user = await accounts.getUser(request);
        if (!user) return sendJson(response, 401, { error: "请先登录" });
        return sendJson(response, 200, { history: await accounts.history(user.id, historyAvailable) });
      }
      if (url.pathname === "/api/history/cleanup" && request.method === "POST") {
        const user = await accounts.getUser(request);
        if (!user) return sendJson(response, 401, { error: "请先登录" });
        return sendJson(response, 200, { deleted: await accounts.cleanHistory(user.id, historyAvailable) });
      }
      if (/^\/api\/history\/[^/]+$/.test(url.pathname) && request.method === "DELETE") {
        const user = await accounts.getUser(request);
        if (!user) return sendJson(response, 401, { error: "请先登录" });
        const key = decodeURIComponent(url.pathname.slice("/api/history/".length));
        if (!await accounts.deleteHistory(user.id, key)) return sendJson(response, 404, { error: "观看记录不存在" });
        return sendJson(response, 200, { deleted: true });
      }
      if (url.pathname === "/api/history/resume" && request.method === "POST") {
        const user = await accounts.getUser(request);
        if (!user) return sendJson(response, 401, { error: "请先登录" });
        const { key } = await readJson(request);
        const saved = await accounts.historyItem(user.id, key);
        if (!saved) return sendJson(response, 404, { error: "观看记录不存在" });
        const media = saved.media;
        const completed = saved.duration > 0 && saved.position >= saved.duration - 1;
        if (media.collectionId) return sendJson(response, 404, { error: "该记录对应的观看合集已停用，请从资源库重新选片" });
        if (media.libraryGroupId) {
          let { collection, item } = historySeries(media);
          if (!item) return sendJson(response, 404, { error: "剧集资源已更新，请重新选集" });
          if (completed) item = collection.items[collection.items.indexOf(item) + 1] || collection.items[0];
          return sendJson(response, 200, { selection: { title: collection.title, url: item.url, libraryGroupId: collection.id, collectionResourceId: item.id, resumePosition: completed ? 0 : saved.position } });
        }
        if (media.references?.length) {
          const detail = await discovery.detailsFromReferences(media.references, key);
          const line = detail.lines.find(line => line.episodes.some(episode => episodeKey(episode.label) === episodeKey(media.episodeLabel))) || detail.lines.find(line => line.episodes.length === 1);
          if (!line) return sendJson(response, 404, { error: "暂无可用线路" });
          let index = Math.max(0, line.episodes.findIndex((episode) => episodeKey(episode.label) === episodeKey(media.episodeLabel)));
          if (completed) index = index + 1 < line.episodes.length ? index + 1 : 0;
          return sendJson(response, 200, { selection: { title: detail.title, url: line.episodes[index].url, selectionId: line.selectionId, playlistIndex: index, resumePosition: completed ? 0 : saved.position, poster: detail.poster } });
        }
        const resource = media.resourceId ? catalog.find(media.resourceId) : null;
        if (media.resourceId && !resource?.enabled) return sendJson(response, 404, { error: "资源已下架" });
        return sendJson(response, 200, { selection: { id: resource?.id, title: media.episodeTitle || media.title, url: resource?.url || media.url, poster: media.poster, resumePosition: completed ? 0 : saved.position } });
      }
      if (url.pathname === "/api/discover" && request.method === "GET") {
        const key = url.searchParams.get("id");
        if (key) return sendJson(response, 200, { list: [await discovery.detail(key)] });
        return sendJson(response, 200, await discovery.search({ keyword: String(url.searchParams.get("keyword") || "").slice(0, 100), page: Math.max(1, Math.min(10000, Math.floor(Number(url.searchParams.get("page")) || 1))) }));
      }
      if (url.pathname === "/api/resources" && request.method === "GET") {
        const visible = resource => ({ ...resource, description: plainText(resource.description), source: "精选资源", networkReferences: undefined });
        sendJson(response, 200, { resources: catalog.published().map(visible), groups: catalog.groups().map(group => ({ ...group, items: group.items.map(visible) })) });
        return;
      }
      if (url.pathname === "/api/sources" && request.method === "GET") {
        return sendJson(response, 200, { sources: sources.list().length ? [{ id: "unified", name: "全部资源", updatedAt: Math.max(0, ...sources.list(true).map(source => source.updatedAt || 0)) }] : [] });
      }
      if (["/api/maccms", "/api/admin/maccms"].includes(url.pathname) && request.method === "GET") {
        if (!adminRequest) return sendJson(response, 404, { error: "Not found" });
        const sourceId = url.searchParams.get("source") || "";
        const source = sources.find(sourceId);
        if (!source || !source.enabled || (!adminRequest && !source.public)) {
          return sendJson(response, 404, { error: "Source is not available" });
        }
        const id = url.searchParams.get("id") || "";
        const page = Math.max(1, Math.min(10000, Math.floor(Number(url.searchParams.get("page")) || 1)));
        if (id && !/^\d+$/.test(id)) return sendJson(response, 400, { error: "Invalid video ID" });
        const result = await fetchMacCms(source, { id, page, keyword: String(url.searchParams.get("keyword") || "").slice(0, 100) });
        if (id) {
          for (const item of result.list) {
            item.reference = { sourceId: source.id, vodId: item.id };
            const lines = [...new Set(item.episodes.map((episode) => episode.source))];
            item.playlists = lines.map((line) => ({ line, selectionId: realtime.preparePlaylist({
              title: item.title, poster: item.poster, context: { title: item.title, poster: item.poster, references: [item.reference], year: item.year },
              items: item.episodes.filter((episode) => episode.source === line).map((episode) => ({ ...episode, title: `${item.title} · ${episode.label}`, poster: item.poster })),
            }) }));
          }
        }
        return sendJson(response, 200, result);
      }

      if (adminRequest) {
        if (url.pathname === "/api/admin/resources/import" && request.method === "POST") {
          const input = await readJson(request, 1048576);
          return sendJson(response, 201, { resources: await catalog.upsertMany(input.resources) });
        }
        if (url.pathname === "/api/admin/source-presets" && request.method === "GET") {
          return sendJson(response, 200, { presets: sourcePresets });
        }
        if (url.pathname === "/api/admin/oss/files") {
          if (!oss) return sendJson(response, 503, { error: "OSS is not configured" });
          if (request.method === "GET") {
            return sendJson(response, 200, await oss.listFiles({ prefix: url.searchParams.get("prefix") ?? "videos/", continuationToken: url.searchParams.get("token") || "" }));
          }
          if (request.method === "DELETE") {
            const key = url.searchParams.get("key") || "";
            if (catalog.list(true).some((resource) => resource.url === oss.objectUrl(key)) || realtime.mediaInUse(oss.objectUrl(key))) {
              return sendJson(response, 409, { error: "该文件仍在资源库中，请先删除资源条目后再删除文件" });
            }
            await oss.deleteFile(key);
            return sendJson(response, 200, { deleted: true });
          }
        }

        if (url.pathname === "/api/admin/rooms" && request.method === "GET") {
          return sendJson(response, 200, { rooms: realtime.listRooms() });
        }
        const roomMatch = /^\/api\/admin\/rooms\/([A-Z0-9]{1,8})$/.exec(url.pathname);
        if (roomMatch && request.method === "DELETE") {
          return sendJson(response, realtime.closeRoom(roomMatch[1]) ? 200 : 404, { closed: true });
        }
        if (url.pathname === "/api/admin/resources" && request.method === "GET") {
          return sendJson(response, 200, { resources: catalog.list(true) });
        }
        if (url.pathname === "/api/admin/resources" && request.method === "POST") {
          return sendJson(response, 201, { resource: await catalog.upsert(await readJson(request)) });
        }
        const resourceMatch = /^\/api\/admin\/resources\/([0-9a-f-]{36})$/.exec(url.pathname);
        if (resourceMatch && request.method === "PUT") {
          const resource = await catalog.upsert(await readJson(request), resourceMatch[1]);
          return sendJson(response, resource ? 200 : 404, { resource });
        }
        if (resourceMatch && request.method === "DELETE") {
          return sendJson(response, (await catalog.remove(resourceMatch[1])) ? 200 : 404, { deleted: true });
        }
        if (url.pathname === "/api/admin/sources" && request.method === "GET") {
          return sendJson(response, 200, { sources: sources.list(true), ossEnabled: Boolean(oss), oss: { enabled: Boolean(oss), bucket: config.oss.bucket, region: config.oss.region, publicUrl: config.oss.publicUrl } });
        }
        if (url.pathname === "/api/admin/sources" && request.method === "POST") {
          return sendJson(response, 201, { source: await sources.upsert(await readJson(request)) });
        }
        const sourceMatch = /^\/api\/admin\/sources\/([0-9a-f-]{24,36})$/.exec(url.pathname);
        if (sourceMatch && request.method === "PUT") {
          const source = await sources.upsert(await readJson(request), sourceMatch[1]);
          return sendJson(response, source ? 200 : 404, { source });
        }
        if (sourceMatch && request.method === "DELETE") {
          return sendJson(response, (await sources.remove(sourceMatch[1])) ? 200 : 404, { deleted: true });
        }
        if (url.pathname === "/api/admin/uploads" && request.method === "POST") {
          if (!oss) return sendJson(response, 503, { error: "OSS is not configured" });
          const { fileName, size } = await readJson(request);
          return sendJson(response, 200, await oss.signUpload(fileName, size));
        }
        if (url.pathname === "/api/admin/uploads/complete" && request.method === "POST") {
          if (!oss) return sendJson(response, 503, { error: "OSS is not configured" });
          const { key, title, publish } = await readJson(request);
          const mediaUrl = await oss.verifyUpload(key);
          if (publish === false) return sendJson(response, 200, { url: mediaUrl });
          const resource = await catalog.upsert({ title, url: mediaUrl, source: "OSS" });
          return sendJson(response, 201, { resource });
        }
        return sendJson(response, 404, { error: "Not found" });
      }

      if (url.pathname === "/healthz") {
        sendJson(response, 200, { status: "ok", uptimeSeconds: Math.floor(process.uptime()) });
        return;
      }

      if (url.pathname === "/readyz") {
        const serviceStatus = getServiceStatus();
        const staticReady = !config.serveStatic || existsSync(join(config.distDir, "index.html"));
        const ready = serviceStatus.ready && staticReady;
        sendJson(response, ready ? 200 : 503, { status: ready ? "ready" : "not-ready", ...serviceStatus });
        return;
      }

      if (!["GET", "HEAD"].includes(request.method)) {
        response.setHeader("Allow", "GET, HEAD");
        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }

      if (!config.serveStatic) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }

      if (!existsSync(config.distDir)) {
        sendJson(response, 503, { error: "Frontend is not built. Run npm run build first." });
        return;
      }

      const filePath = resolveStaticFile(config.distDir, url.pathname);
      if (!filePath) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      serveFile(request, response, filePath);
    } catch (error) {
      if (response.headersSent) return;
      const invalid = error instanceof SyntaxError || error instanceof TypeError || /^(Video|Image|Only|Collection|Invalid upload|Request body|Source name|Source URL|Source already)/.test(error.message);
      sendJson(response, error.status || (invalid ? 400 : 502), { error: error.status || invalid ? error.message : "资源服务暂时不可用，请稍后再试" });
    }
  };
}
