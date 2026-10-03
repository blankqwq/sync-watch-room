import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import OSS from "ali-oss";
import { createApplication } from "./app.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { loadConfig, loadEnvironment } from "./config.js";
import { SYNC_PROTOCOL } from "../shared/sync.js";
loadEnvironment();

const silentLogger = { info() {}, warn() {}, error() {} };
function createTestApplication(config, logger, context) {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const app = createApplication({ ...config, databaseUrl: process.env.DATABASE_URL, databaseSchema: schema }, logger);
  context.after(async () => {
    await app.close();
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); }
  });
  return app;
}
async function guestCookie(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: `test_${randomUUID().slice(0,8)}`, password: "Test-password-2026" }) });
  assert.equal(response.status, 201);
  return response.headers.get("set-cookie").split(";")[0];
}


test("health and readiness endpoints report service state", async (context) => {
  const config = { ...loadConfig({ SERVE_STATIC: "false" }), port: 0, host: "127.0.0.1" };
  const app = createTestApplication(config, silentLogger, context);
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const healthResponse = await fetch(`${baseUrl}/healthz`);
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).status, "ok");

  const readyResponse = await fetch(`${baseUrl}/readyz`);
  const readiness = await readyResponse.json();
  assert.equal(readyResponse.status, 200);
  assert.equal(readiness.status, "ready");
  assert.equal(readiness.rooms, 0);
  assert.equal(readiness.clients, 0);
});

test("join response includes short-lived TURN credentials", async (context) => {
  const config = {
    ...loadConfig({
      SERVE_STATIC: "false",
      STUN_URLS: "stun:turn.example.com:3478",
      TURN_URLS: "turn:turn.example.com:3478?transport=udp",
      TURN_SHARED_SECRET: "test-shared-secret",
    }),
    port: 0,
    host: "127.0.0.1",
  };
  const app = createTestApplication(config, silentLogger, context);
  const address = await app.listen();
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { Cookie: await guestCookie(`http://127.0.0.1:${address.port}`) } });
  context.after(() => socket.close());

  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "join", syncProtocol: SYNC_PROTOCOL, roomId: "TURN", name: "tester" }));
  const joined = await new Promise((resolve, reject) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data);
      if (message.type === "joined") resolve(message);
    });
    socket.once("error", reject);
  });

  assert.equal(joined.iceServers.length, 2);
  assert.match(joined.iceServers[1].username, /^\d+:\S+$/);
  assert.ok(joined.iceServers[1].credential);
});

test("admin catalog is private, public resources open rooms, and admin can close rooms", async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), "watch-catalog-"));
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const config = { ...loadConfig({ SERVE_STATIC: "false", ADMIN_TOKEN: "test-admin-token", DATA_DIR: dataDir }), port: 0, host: "127.0.0.1" };
  const app = createTestApplication(config, silentLogger, context);
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: "Bearer test-admin-token", "Content-Type": "application/json" };

  assert.equal((await fetch(`${baseUrl}/api/admin/rooms`)).status, 401);
  const createdResponse = await fetch(`${baseUrl}/api/admin/resources`, {
    method: "POST", headers,
    body: JSON.stringify({ title: "Demo", url: "https://media.example.com/demo.mp4", enabled: true }),
  });
  assert.equal(createdResponse.status, 201);
  const { resource } = await createdResponse.json();
  assert.ok(resource.id);
  assert.equal((await (await fetch(`${baseUrl}/api/resources`)).json()).resources.length, 1);

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { Cookie: await guestCookie(`http://127.0.0.1:${address.port}`) } });
  context.after(() => socket.close());
  await new Promise((resolve) => socket.once("open", resolve));
  socket.send(JSON.stringify({ type: "join", syncProtocol: SYNC_PROTOCOL, roomId: "MEDIA", name: "viewer", resourceId: resource.id }));
  const joined = await new Promise((resolve) => socket.on("message", (data) => {
    const message = JSON.parse(data);
    if (message.type === "joined") resolve(message);
  }));
  assert.equal(joined.state.mediaUrl, resource.url);
  assert.equal(joined.state.mediaTitle, "Demo");
  const roomData = await (await fetch(`${baseUrl}/api/admin/rooms`, { headers })).json();
  assert.equal(roomData.rooms[0].members[0].name, "viewer");
  assert.equal((await fetch(`${baseUrl}/api/admin/rooms/MEDIA`, { method: "DELETE", headers })).status, 200);
  assert.equal((await (await fetch(`${baseUrl}/api/admin/rooms`, { headers })).json()).rooms.length, 0);

  await fetch(`${baseUrl}/api/admin/resources/${resource.id}`, { method: "PUT", headers, body: JSON.stringify({ ...resource, enabled: false }) });
  assert.equal((await (await fetch(`${baseUrl}/api/resources`)).json()).resources.length, 0);
});

test("OSS completion publishes only verified nonempty objects", async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), "watch-upload-"));
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  let uploadedSize = null;
  context.mock.method(OSS.prototype, "getObjectMeta", async () => {
    if (uploadedSize === null) throw new Error("Object not found");
    return { res: { headers: { "content-length": String(uploadedSize) } } };
  });
  const config = {
    ...loadConfig({
      SERVE_STATIC: "false", ADMIN_TOKEN: "upload-token", DATA_DIR: dataDir,
      OSS_REGION: "oss-cn-hangzhou", OSS_BUCKET: "demo-bucket", OSS_ACCESS_KEY_ID: "test-id",
      OSS_ACCESS_KEY_SECRET: "test-secret", OSS_PUBLIC_URL: "https://cdn.example.com",
    }), port: 0, host: "127.0.0.1",
  };
  const app = createTestApplication(config, silentLogger, context);
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: "Bearer upload-token", "Content-Type": "application/json" };
  const signingResponse = await fetch(`${baseUrl}/api/admin/uploads`, {
    method: "POST", headers, body: JSON.stringify({ fileName: "film.mp4", size: 123 }),
  });
  assert.equal(signingResponse.status, 200);
  const signed = await signingResponse.json();
  assert.ok(new URL(signed.uploadUrl).searchParams.has("x-oss-signature"));
  const complete = () => fetch(`${baseUrl}/api/admin/uploads/complete`, {
    method: "POST", headers, body: JSON.stringify({ key: signed.key, title: "Uploaded video" }),
  });
  assert.equal((await complete()).status, 502);
  uploadedSize = 0;
  assert.equal((await complete()).status, 400);
  assert.deepEqual((await (await fetch(`${baseUrl}/api/resources`)).json()).resources, []);
  uploadedSize = 123;
  assert.equal((await complete()).status, 201);
  const resources = (await (await fetch(`${baseUrl}/api/resources`)).json()).resources;
  assert.equal(resources[0].url, signed.url);
  assert.equal(resources[0].source, "OSS");
});

test("MacCMS search and detail can be imported and opened in a guest room", async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), "watch-import-"));
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  const calls = [];
  context.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    if (url.hostname !== "source.example.com") return originalFetch(input, options);
    calls.push(url);
    const item = { vod_id: 42, vod_name: "Imported film" };
    if (url.searchParams.get("ac") === "detail") {
      item.vod_play_url = "正片$https://media.example.com/film.m3u8";
    }
    return new Response(JSON.stringify({ page: 1, pagecount: 1, list: [item] }));
  });
  const config = {
    ...loadConfig({ SERVE_STATIC: "false", ADMIN_TOKEN: "import-token", DATA_DIR: dataDir,
      MACCMS_SOURCES: "Catalog|https://source.example.com/api.php/provide/vod/" }),
    port: 0, host: "127.0.0.1",
  };
  const app = createTestApplication(config, silentLogger, context);
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: "Bearer import-token", "Content-Type": "application/json" };
  const { sources } = await (await fetch(`${baseUrl}/api/admin/sources`, { headers })).json();
  const sourceId = sources[0].id;
  const search = await (await fetch(`${baseUrl}/api/admin/maccms?source=${sourceId}&keyword=film`, { headers })).json();
  assert.equal(search.list[0].id, "42");
  assert.equal(calls[0].searchParams.get("wd"), "film");
  const detail = await (await fetch(`${baseUrl}/api/admin/maccms?source=${sourceId}&id=42`, { headers })).json();
  const item = detail.list[0];
  const created = await fetch(`${baseUrl}/api/admin/resources`, {
    method: "POST", headers,
    body: JSON.stringify({ title: item.title, url: item.episodes[0].url, source: "Catalog" }),
  });
  const { resource } = await created.json();
  assert.equal((await (await fetch(`${baseUrl}/api/resources`)).json()).resources[0].id, resource.id);
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { Cookie: await guestCookie(`http://127.0.0.1:${address.port}`) } });
  context.after(() => socket.close());
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const joined = new Promise((resolve) => socket.on("message", (data) => {
    const message = JSON.parse(data);
    if (message.type === "joined") resolve(message);
  }));
  socket.send(JSON.stringify({ type: "join", syncProtocol: SYNC_PROTOCOL, roomId: "IMPORTED", name: "Guest", resourceId: resource.id }));
  assert.equal((await joined).state.mediaUrl, item.episodes[0].url);

  const directSocket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { Cookie: await guestCookie(baseUrl) } });
  context.after(() => directSocket.close());
  await new Promise((resolve, reject) => { directSocket.once("open", resolve); directSocket.once("error", reject); });
  const directJoined = new Promise((resolve) => directSocket.on("message", (data) => {
    const message = JSON.parse(data);
    if (message.type === "joined") resolve(message);
  }));
  directSocket.send(JSON.stringify({ type: "join", syncProtocol: SYNC_PROTOCOL, roomId: "DIRECT", name: "Guest", media: { url: item.episodes[0].url, title: item.title } }));
  assert.equal((await directJoined).state.mediaUrl, item.episodes[0].url);

  const privateSourceResponse = await fetch(`${baseUrl}/api/admin/sources`, {
    method: "POST", headers, body: JSON.stringify({ name: "Private source", url: "https://private.example.com/custom-api.php" }),
  });
  assert.equal(privateSourceResponse.status, 201);
  const { source: privateSource } = await privateSourceResponse.json();
  assert.equal((await fetch(`${baseUrl}/api/maccms?source=${privateSource.id}`)).status, 404);
  assert.equal((await (await fetch(`${baseUrl}/api/sources`)).json()).sources.length, 1);
  await fetch(`${baseUrl}/api/admin/sources/${sourceId}`, {
    method: "PUT", headers,
    body: JSON.stringify({ name: "Catalog", url: config.macCmsSources[0].url, public: true, enabled: false }),
  });
  assert.deepEqual((await (await fetch(`${baseUrl}/api/sources`)).json()).sources, []);
  assert.equal((await fetch(`${baseUrl}/api/maccms?source=${sourceId}`)).status, 404);
});
