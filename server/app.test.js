import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { createApplication } from "./app.js";
import { loadConfig } from "./config.js";

const silentLogger = { info() {}, warn() {}, error() {} };

test("health and readiness endpoints report service state", async (context) => {
  const config = { ...loadConfig({ SERVE_STATIC: "false" }), port: 0, host: "127.0.0.1" };
  const app = createApplication(config, silentLogger);
  context.after(() => app.close());
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
  const app = createApplication(config, silentLogger);
  context.after(() => app.close());
  const address = await app.listen();
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  context.after(() => socket.close());

  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "join", roomId: "TURN", name: "tester" }));
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
