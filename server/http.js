import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

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

export function createHttpHandler(config, getServiceStatus) {
  return (request, response) => {
    setSecurityHeaders(response);
    const url = new URL(request.url || "/", "http://localhost");

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
  };
}
