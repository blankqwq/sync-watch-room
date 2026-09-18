import assert from "node:assert/strict";
import test from "node:test";
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
