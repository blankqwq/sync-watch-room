import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

test("loadConfig returns production-safe server defaults", () => {
  const config = loadConfig({});
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 4173);
  assert.equal(config.wsPath, "/ws");
  assert.equal(config.serveStatic, true);
  assert.equal(config.maxPayloadBytes, 65536);
});

test("loadConfig parses deployment settings", () => {
  const config = loadConfig({
    PORT: "8080",
    SERVE_STATIC: "false",
    ALLOWED_ORIGINS: "https://watch.example.com, https://admin.example.com",
  });
  assert.equal(config.port, 8080);
  assert.equal(config.serveStatic, false);
  assert.deepEqual(config.allowedOrigins, ["https://watch.example.com", "https://admin.example.com"]);
});

test("loadConfig rejects invalid values", () => {
  assert.throws(() => loadConfig({ PORT: "invalid" }), /PORT must be an integer/);
  assert.throws(() => loadConfig({ SERVE_STATIC: "yes" }), /SERVE_STATIC must be either true or false/);
  assert.throws(() => loadConfig({ WS_PATH: "ws" }), /WS_PATH must be an absolute URL path/);
});
