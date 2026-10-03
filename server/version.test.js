import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import pg from "pg";
import { WebSocket } from "ws";
import { createApplication } from "./app.js";
import { loadConfig, loadEnvironment } from "./config.js";
import { episodeKey } from "./discovery.js";
import { SYNC_TICK_MS, SYNC_PROTOCOL } from "../shared/sync.js";

loadEnvironment();
const logger = { info() {}, warn() {}, error() {} };

async function fixture(context, env = {}, legacy = []) {
  const directory = mkdtempSync(join(tmpdir(), "watch-version-"));
  writeFileSync(join(directory, "catalog.json"), JSON.stringify(legacy));
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const config = { ...loadConfig({ SERVE_STATIC: "false", ADMIN_TOKEN: "test-admin", DATA_DIR: directory, ...env }),
    databaseUrl: process.env.DATABASE_URL, databaseSchema: schema, port: 0, host: "127.0.0.1" };
  let app = createApplication(config, logger);
  let address = await app.listen();
  context.after(async () => {
    await app.close();
    const pool = new pg.Pool({ connectionString: config.databaseUrl });
    try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); }
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    schema,
    get base() { return `http://127.0.0.1:${address.port}`; },
    get ws() { return `ws://127.0.0.1:${address.port}/ws`; },
    async restart() { await app.close(); app = createApplication(config, logger); address = await app.listen(); },
  };
}

async function request(server, path, { cookie = "", admin = false, method = "GET", body } = {}) {
  const response = await fetch(`${server.base}${path}`, { method, headers: {
    ...(cookie ? { Cookie: cookie } : {}), ...(admin ? { Authorization: "Bearer test-admin" } : {}),
    ...(body ? { "Content-Type": "application/json" } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, headers: response.headers, data: await response.json() };
}

async function register(server) {
  const username = `user_${randomUUID().slice(0, 8)}`;
  const response = await request(server, "/api/auth/register", { method: "POST", body: { username, password: "Test-password-2026" } });
  assert.equal(response.status, 201);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.ok(!JSON.stringify(response.data).includes("password"));
  return { username, user: response.data.user, cookie: response.headers.get("set-cookie").split(";")[0] };
}

function message(socket, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("message", handler); reject(new Error(`Missing ${type} message`)); }, 5000);
    const handler = (data) => {
      const value = JSON.parse(data);
      if (value.type === type) { clearTimeout(timer); socket.off("message", handler); resolve(value); }
    };
    socket.on("message", handler);
  });
}

async function enter(server, cookie, selection, type = "joined") {
  const socket = new WebSocket(server.ws, { headers: { Cookie: cookie } });
  await once(socket, "open");
  const response = message(socket, type);
  socket.send(JSON.stringify({ type: "join", syncProtocol: SYNC_PROTOCOL, name: "Viewer", ...selection }));
  return { socket, response: await response };
}

test("PostgreSQL preserves migrated resources, sessions, rooms and private viewing progress after restart", async (context) => {
  const legacy = { id: randomUUID(), title: "Legacy", url: "https://media.example.com/legacy.mp4", poster: "https://images.example.com/cover.jpg", enabled: true };
  const server = await fixture(context, {}, [legacy]);
  assert.equal((await request(server, "/api/resources")).data.resources.length, 1);
  const added = await request(server, "/api/admin/resources", { admin: true, method: "POST", body: { title: "New movie", url: "https://media.example.com/new.mp4" } });
  await Promise.all([1, 2].map((index) => request(server, "/api/admin/resources", { admin: true, method: "POST", body: { title: `Parallel ${index}`, url: `https://media.example.com/parallel-${index}.mp4` } })));
  assert.equal((await request(server, "/api/resources")).data.resources.length, 4);
  const owner = await register(server);
  const other = await register(server);
  assert.equal((await request(server, "/api/history")).status, 401);
  assert.equal((await request(server, "/api/auth/login", { method: "POST", body: { username: owner.username, password: "Incorrect-password" } })).status, 401);
  const anonymous = await enter(server, "", { roomId: "ANON" }, "join-error");
  assert.equal(anonymous.response.code, 401); anonymous.socket.close();
  const viewer = await enter(server, owner.cookie, { roomId: "HISTORY", resourceId: added.data.resource.id });
  const command = message(viewer.socket, "sync-command");
  viewer.socket.send(JSON.stringify({ type: "sync-command", command: { id: randomUUID(), sequence: 1, paused: true, position: 27, executeAt: Date.now(), mediaUrl: added.data.resource.url, mediaTitle: added.data.resource.title, playlistIndex: -1 } }));
  await command;
  viewer.socket.send(JSON.stringify({ type: "member-status", playback: { mediaUrl: added.data.resource.url, position: 27, duration: 60, ready: true } }));
  const closed = once(viewer.socket, "close"); viewer.socket.close(); await closed;
  const history = (await request(server, "/api/history", { cookie: owner.cookie })).data.history;
  assert.equal(history.length, 1); assert.equal(history[0].position, 27); assert.equal(history[0].duration, 60);
  assert.deepEqual((await request(server, "/api/history", { cookie: other.cookie })).data.history, []);
  assert.equal((await request(server, "/api/history/resume", { cookie: other.cookie, method: "POST", body: { key: history[0].key } })).status, 404);
  await server.restart();
  assert.equal((await request(server, "/api/resources")).data.resources.length, 4);
  assert.equal((await request(server, "/api/account", { cookie: owner.cookie })).data.user.id, owner.user.id);
  assert.equal((await request(server, "/api/history", { cookie: owner.cookie })).data.history[0].position, 27);
  const restored = await enter(server, owner.cookie, { roomId: "HISTORY", reconnect: true });
  assert.equal(restored.response.state.position, 27);
  assert.equal(restored.response.state.mediaUrl, added.data.resource.url);
  const signedOut = message(restored.socket, "account-logout");
  await request(server, "/api/auth/logout", { cookie: owner.cookie, method: "POST" });
  await signedOut;
  assert.equal((await request(server, "/api/account", { cookie: owner.cookie })).data.user, null);
});

test("merged resources hide provider identities; series line switching keeps episode, progress and host-only controls", async (context) => {
  const originalFetch = globalThis.fetch;
  context.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    if (!["one.example", "two.example"].includes(url.hostname)) return originalFetch(input, options);
    const second = url.hostname === "two.example";
    const item = { vod_id: second ? 2 : 1, vod_name: second ? "Alpha2026" : "Alpha", vod_year: "2026", vod_douban_id: 501,
      vod_pic: "https://images.example.com/cover.jpg", vod_play_from: "private-player-name" };
    if (url.searchParams.get("ac") === "detail") item.vod_play_url = [1, 2].map((episode) => `${second ? `第${episode}集` : `第0${episode}集`}$https://media.example.com/${second ? 'b' : 'a'}-${episode}.mp4`).join("#");
    return new Response(JSON.stringify({ page: 1, pagecount: 1, list: [item] }));
  });
  const server = await fixture(context, { MACCMS_SOURCES: "Secret One|https://one.example/api.php/provide/vod/,Secret Two|https://two.example/api.php/provide/vod/" });
  const search = (await request(server, "/api/discover?keyword=Alpha")).data;
  assert.equal(search.list.length, 1); assert.equal(search.list[0].lineCount, 2);
  assert.equal(search.list[0].poster, "https://images.example.com/cover.jpg");
  assert.ok(!JSON.stringify(search).includes("Secret"));
  const detail = (await request(server, `/api/discover?id=${search.list[0].key}`)).data.list[0];
  assert.equal(detail.lines.length, 2);
  assert.ok(!JSON.stringify(detail).includes("private-player-name"));
  const owner = await register(server); const guest = await register(server);
  const outdated = await enter(server, owner.cookie, { roomId: "OLD", syncProtocol: 0 }, "join-error");
  assert.equal(outdated.response.code, 426); outdated.socket.close();
  const host = await enter(server, owner.cookie, { roomId: "LINES", selectionId: detail.playlists[0].selectionId, playlistIndex: 1 });
  const follower = await enter(server, guest.cookie, { roomId: "LINES" });
  const synced = message(host.socket, "sync-command");
  host.socket.send(JSON.stringify({ type: "sync-command", command: { id: randomUUID(), sequence: 1, playlistIndex: 1, paused: true, position: 19, autoAdvance: false, executeAt: Date.now() } }));
  await synced;
  const available = message(host.socket, "available-lines"); host.socket.send(JSON.stringify({ type: "request-lines" }));
  const lines = (await available).lines;
  follower.socket.send(JSON.stringify({ type: "switch-line", id: lines[1].id, position: 99 }));
  const canonical = message(follower.socket, "room-state");
  follower.socket.send(JSON.stringify({ type: "sync-command", command: { sequence: 999, paused: false, position: 99, playlistIndex: 0 } }));
  assert.equal((await canonical).state.mediaUrl, "https://media.example.com/a-2.mp4");
  const switched = message(host.socket, "sync-command");
  host.socket.send(JSON.stringify({ type: "switch-line", id: lines[1].id, position: 19 }));
  const changed = (await switched).command;
  assert.equal(changed.mediaUrl, "https://media.example.com/b-2.mp4");
  assert.equal(changed.position, 19); assert.equal(changed.playlistIndex, 1);
  const promoted = message(follower.socket, "host-changed"); host.socket.close();
  const nextHost = await promoted;
  assert.equal(nextHost.hostId, follower.response.clientId);
  assert.equal(nextHost.state.autoAdvance, false); assert.equal(nextHost.state.playlistIndex, 1);
  follower.socket.close();
});

test("episode matching distinguishes dated episodes and normalizes numbered episodes across lines", () => {
  assert.equal(episodeKey("第01集"), episodeKey("第1集"));
  assert.equal(episodeKey("2026-10-02期"), episodeKey("20261002期"));
  assert.notEqual(episodeKey("20261001期"), episodeKey("20261002期"));
});

test("server sync pauses both clients on buffer loss, stalled status, excessive drift and signal latency without P2P", async (context) => {
  const server = await fixture(context);
  const owner = await register(server); const guest = await register(server);
  const host = await enter(server, owner.cookie, { roomId: "STRICT", media: { title: "Sync", url: "https://media.example.com/sync.mp4" } });
  const follower = await enter(server, guest.cookie, { roomId: "STRICT" });
  let state = host.response.state;
  let guestFault = {};
  let guestSilent = false;
  const receive = (data) => { const payload = JSON.parse(data); if (payload.type === "sync-state") state = payload.state; };
  host.socket.on("message", receive);
  const report = (socket, patch = {}) => socket.send(JSON.stringify({ type: "member-status", playback: {
    mediaUrl: state.mediaUrl, position: state.position + (state.paused ? 0 : Math.max(0, Date.now() - state.executeAt) / 1000), duration: 60,
    ready: true, buffering: false, paused: state.paused, sequence: state.sequence, sampledAt: Date.now(), syncRttMs: 10, ...patch,
  } }));
  const reports = setInterval(() => { report(host.socket); if (!guestSilent) report(follower.socket, guestFault); }, SYNC_TICK_MS);
  context.after(() => { clearInterval(reports); host.socket.close(); follower.socket.close(); });
  async function start() {
    guestFault = {}; guestSilent = false;
    const acknowledged = message(host.socket, "member-status"); report(follower.socket); report(host.socket); await acknowledged;
    const commanded = message(host.socket, "sync-command");
    host.socket.send(JSON.stringify({ type: "sync-command", command: { id: randomUUID(), sequence: state.sequence + 1, paused: false, position: state.position, executeAt: Date.now() + 100 } }));
    const command = (await commanded).command;
    assert.equal(command.paused, false);
    state = { ...command, serverTime: Date.now() };
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(state.paused, false);
  }
  for (const fault of [{ buffering: true, ready: false, paused: true }, { position: 30 }, { syncRttMs: 500 }, null]) {
    await start();
    const stoppedHost = message(host.socket, "sync-command");
    const stoppedGuest = message(follower.socket, "sync-command");
    const began = Date.now();
    guestFault = fault || {}; guestSilent = fault === null;
    if (!guestSilent) report(follower.socket, guestFault);
    const [a, b] = await Promise.all([stoppedHost, stoppedGuest]);
    assert.equal(a.command.paused, true); assert.equal(b.command.paused, true);
    assert.equal(a.command.position, b.command.position);
    assert.ok(Date.now() - began < 1000);
    state = { ...a.command, serverTime: Date.now() };
  }
  await start();
  const departed = message(host.socket, "sync-command"); follower.socket.close();
  const stopped = (await departed).command;
  assert.equal(stopped.paused, true); assert.equal(stopped.requireHostResume, true);
});

test("application branding is public to read, admin-only to change and survives a PostgreSQL restart", async (context) => {
  const server = await fixture(context);
  const defaults = (await request(server, "/api/settings")).data.settings;
  assert.equal(defaults.name, "同频放映室");
  assert.equal(defaults.icon, "/couple-tv-icon.png");
  const icon = `data:image/png;base64,${readFileSync(new URL("../public/couple-tv-icon.png", import.meta.url)).toString("base64")}`;
  const settings = { name: "我们的放映室", icon };
  assert.equal((await request(server, "/api/admin/settings", { method: "PUT", body: settings })).status, 401);
  const changed = await request(server, "/api/admin/settings", { admin: true, method: "PUT", body: settings });
  assert.equal(changed.status, 200);
  assert.deepEqual((await request(server, "/api/settings")).data.settings, settings);
  await server.restart();
  assert.deepEqual((await request(server, "/api/settings")).data.settings, settings);
  for (const invalid of [{ name: "", icon }, { name: "Test", icon: "javascript:alert(1)" }, { name: "Test", icon: `data:image/png;base64,${Buffer.alloc(512 * 1024 + 1).toString("base64")}` }]) {
    assert.equal((await request(server, "/api/admin/settings", { admin: true, method: "PUT", body: invalid })).status, 400);
  }
  assert.deepEqual((await request(server, "/api/settings")).data.settings, settings);
});

test("viewing history deletion and cleanup are private and preserve network resources outside the library", async (context) => {
  const originalFetch = globalThis.fetch;
  context.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    if (url.hostname !== "history.example") return originalFetch(input, options);
    return new Response(JSON.stringify({ page: 1, pagecount: 1, list: [{ vod_id: 1, vod_name: "Network movie", vod_year: "2026",
      vod_play_from: "m3u8", vod_play_url: "正片$https://media.example.com/network.mp4" }] }));
  });
  const server = await fixture(context, { MACCMS_SOURCES: "Network|https://history.example/api.php/provide/vod/" });
  const owner = await register(server); const other = await register(server);
  const resources = [];
  for (const title of ["Available", "Removed"]) {
    const added = await request(server, "/api/admin/resources", { admin: true, method: "POST", body: { title, url: `https://media.example.com/${title}.mp4` } });
    resources.push(added.data.resource);
  }
  const search = (await request(server, "/api/discover")).data.list[0];
  const detail = (await request(server, `/api/discover?id=${search.key}`)).data.list[0];
  const selections = [{ resourceId: resources[0].id }, { resourceId: resources[1].id }, { selectionId: detail.playlists[0].selectionId }];
  for (const [index, selection] of selections.entries()) {
    const viewer = await enter(server, owner.cookie, { roomId: `DELETE${index}`, ...selection });
    const closed = once(viewer.socket, "close"); viewer.socket.close(); await closed;
  }
  const otherViewer = await enter(server, other.cookie, { roomId: "OTHER", resourceId: resources[1].id });
  const closed = once(otherViewer.socket, "close"); otherViewer.socket.close(); await closed;
  await request(server, `/api/admin/resources/${resources[1].id}`, { admin: true, method: "DELETE" });
  let history = (await request(server, "/api/history", { cookie: owner.cookie })).data.history;
  assert.equal(history.find((item) => item.title === "Removed").available, false);
  assert.equal(history.find((item) => item.title === "Available").available, true);
  assert.equal(history.find((item) => item.title === "Network movie").available, true);
  const availableKey = history.find((item) => item.title === "Available").key;
  assert.equal((await request(server, `/api/history/${availableKey}`, { method: "DELETE" })).status, 401);
  assert.equal((await request(server, "/api/history/cleanup", { method: "POST" })).status, 401);
  assert.equal((await request(server, `/api/history/${availableKey}`, { cookie: other.cookie, method: "DELETE" })).status, 404);
  const cleanup = await request(server, "/api/history/cleanup", { cookie: owner.cookie, method: "POST" });
  assert.equal(cleanup.data.deleted, 1);
  assert.equal((await request(server, "/api/history", { cookie: other.cookie })).data.history.length, 1);
  assert.equal((await request(server, `/api/history/${availableKey}`, { cookie: owner.cookie, method: "DELETE" })).status, 200);
  await server.restart();
  history = (await request(server, "/api/history", { cookie: owner.cookie })).data.history;
  assert.equal(history.length, 1); assert.equal(history[0].title, "Network movie");
  const source = (await request(server, "/api/admin/sources", { admin: true })).data.sources[0];
  await request(server, `/api/admin/sources/${source.id}`, { admin: true, method: "PUT", body: { ...source, enabled: false } });
  assert.equal((await request(server, "/api/history", { cookie: owner.cookie })).data.history[0].available, false);
  assert.equal((await request(server, "/api/history/cleanup", { cookie: owner.cookie, method: "POST" })).data.deleted, 1);
  assert.deepEqual((await request(server, "/api/history", { cookie: owner.cookie })).data.history, []);
});

test("completed series history starts the next episode and replays after the final episode", async (context) => {
  const server = await fixture(context);
  const owner = await register(server);
  const resources = [];
  for (const episode of [1, 2]) {
    const added = await request(server, "/api/admin/resources", { admin: true, method: "POST", body: {
      title: `Episode ${episode}`, seriesTitle: "Finished series", episodeLabel: `第${episode}集`, episodeCount: 2, url: `https://media.example.com/completed-${episode}.mp4`,
    } });
    resources.push(added.data.resource);
  }
  const series = (await request(server, "/api/resources")).data.groups[0];
  for (const index of [0, 1]) {
    const viewer = await enter(server, owner.cookie, { roomId: `END${index}`, libraryGroupId: series.id, collectionResourceId: resources[index].id });
    viewer.socket.send(JSON.stringify({ type: "member-status", playback: { mediaUrl: resources[index].url, position: 60, duration: 60, ready: true } }));
    const closed = once(viewer.socket, "close"); viewer.socket.close(); await closed;
    const history = (await request(server, "/api/history", { cookie: owner.cookie })).data.history;
    assert.equal(history.length, 1);
    assert.equal(history[0].completed, true);
    const resume = await request(server, "/api/history/resume", { cookie: owner.cookie, method: "POST", body: { key: history[0].key } });
    assert.equal(resume.status, 200);
    assert.equal(resume.data.selection.collectionResourceId, resources[index === 0 ? 1 : 0].id);
    assert.equal(resume.data.selection.resumePosition, 0);
  }
});

test("library series merge duplicate episodes, switch local lines and resume through another available resource", async (context) => {
  const server = await fixture(context);
  const owner = await register(server);
  const resources = [];
  for (const line of ["a", "b"]) for (const episode of [1, 2]) {
    const label = line === "a" ? `第0${episode}集` : `第${episode}集`;
    const response = await request(server, "/api/admin/resources", { admin: true, method: "POST", body: {
      title: `Alpha · ${label}`, seriesTitle: "Alpha", year: "2026", doubanId: 501, episodeCount: 2, episodeLabel: label,
      url: `https://media.example.com/${line}-${episode}.mp4`, poster: "https://images.example.com/cover.jpg", source: "manual",
    } });
    resources.push(response.data.resource);
  }
  assert.equal((await request(server, "/api/resources")).data.resources.length, 2);
  const library = (await request(server, "/api/resources")).data.groups;
  assert.equal(library.length, 1);
  assert.equal(library[0].items.length, 2);
  assert.equal(library[0].items[0].episodeLabel, "第1集");
  const series = library[0];
  const current = resources.find((resource) => resource.id === series.items[0].id);
  const alternate = resources.find((resource) => resource.episodeLabel.endsWith("1集") && resource.id !== current.id);
  assert.ok(series.items[0].alternatives.some(line => line.id === alternate.id && line.url === alternate.url));
  const fallback = await enter(server, owner.cookie, { roomId: "LIBALT", libraryGroupId: series.id, collectionResourceId: alternate.id });
  assert.equal(fallback.response.state.mediaUrl, alternate.url);
  assert.equal(fallback.response.state.playlistIndex, 0);
  assert.equal(fallback.response.playlist.length, 2);
  fallback.socket.close();
  const viewer = await enter(server, owner.cookie, { roomId: "SERIES", libraryGroupId: series.id, collectionResourceId: current.id });
  assert.equal(viewer.response.state.playlistIndex, 0);
  assert.equal(viewer.response.playlist[0].url, current.url);
  const available = message(viewer.socket, "available-lines"); viewer.socket.send(JSON.stringify({ type: "request-lines" }));
  const lines = (await available).lines;
  assert.equal(lines.length, 2);
  const switched = message(viewer.socket, "sync-command");
  viewer.socket.send(JSON.stringify({ type: "switch-line", id: lines[1].id, position: 11 }));
  assert.equal((await switched).command.mediaUrl, alternate.url);
  viewer.socket.send(JSON.stringify({ type: "member-status", playback: { mediaUrl: alternate.url, position: 11, duration: 60, ready: true } }));
  const closed = once(viewer.socket, "close"); viewer.socket.close(); await closed;
  await request(server, `/api/admin/resources/${current.id}`, { admin: true, method: "PUT", body: { ...current, enabled: false } });
  const history = (await request(server, "/api/history", { cookie: owner.cookie })).data.history;
  const resume = await request(server, "/api/history/resume", { cookie: owner.cookie, method: "POST", body: { key: history[0].key } });
  assert.equal(resume.status, 200); assert.equal(resume.data.selection.collectionResourceId, alternate.id);
  assert.equal(resume.data.selection.resumePosition, 11);
  await server.restart();
  assert.equal((await request(server, "/api/resources")).data.groups[0].id, series.id);
});


test("collection routes are retired and bulk episode import creates an ordinary library series", async (context) => {
  const server = await fixture(context);
  for (const path of ["/api/collections", "/api/admin/collections"]) assert.equal((await request(server, path, { admin: true })).status, 404);
  assert.equal((await request(server, "/api/admin/collections", { admin: true, method: "POST", body: { title: "Old feature" } })).status, 404);
  assert.equal((await request(server, "/api/admin/collections/import", { admin: true, method: "POST", body: { resources: [] } })).status, 404);
  const resources = [2, 1].map((episode) => ({ title: `Imported · 第${episode}集`, seriesTitle: "Imported", episodeCount: 2, episodeLabel: `第${episode}集`, url: `https://media.example.com/imported-${episode}.mp4` }));
  assert.equal((await request(server, "/api/admin/resources/import", { method: "POST", body: { resources } })).status, 401);
  const imported = await request(server, "/api/admin/resources/import", { admin: true, method: "POST", body: { resources } });
  assert.equal(imported.status, 201); assert.equal(imported.data.resources.length, 2);
  const invalid = await request(server, "/api/admin/resources/import", { admin: true, method: "POST", body: { resources: [...resources, { title: "Invalid", url: "javascript:alert(1)" }] } });
  assert.equal(invalid.status, 400);
  const series = (await request(server, "/api/resources")).data.groups[0];
  assert.equal(series.items.length, 2); assert.equal(series.items[0].episodeLabel, "第1集");
  const owner = await register(server);
  const rejected = await enter(server, owner.cookie, { roomId: "OLDLIST", collectionId: "old-collection" }, "join-error");
  rejected.socket.close();
  const legacyPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${server.schema},public` });
  try {
    await legacyPool.query("INSERT INTO watch_history(user_id,content_key,media) VALUES($1,$2,$3::jsonb)", [owner.user.id, "old-collection", JSON.stringify({ title: "Old collection", collectionId: "old-collection", url: resources[0].url })]);
  } finally { await legacyPool.end(); }
  assert.equal((await request(server, "/api/history", { cookie: owner.cookie })).data.history[0].available, false);
  assert.equal((await request(server, "/api/history/resume", { cookie: owner.cookie, method: "POST", body: { key: "old-collection" } })).status, 404);
  assert.equal((await request(server, `/api/history/old-collection`, { cookie: owner.cookie, method: "DELETE" })).status, 200);
  const viewer = await enter(server, owner.cookie, { roomId: "IMPORTED", libraryGroupId: series.id, collectionResourceId: series.items[1].id });
  assert.equal(viewer.response.state.playlistIndex, 1);
  viewer.socket.close();
});
