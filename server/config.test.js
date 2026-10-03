import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

test("loadConfig returns production-safe server defaults", () => {
  const config = loadConfig({});
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 4173);
  assert.equal(config.wsPath, "/ws");
  assert.equal(config.serveStatic, true);
  assert.equal(config.maxPayloadBytes, 65536);
  assert.deepEqual(config.stunUrls, ["stun:stun.l.google.com:19302"]);
  assert.deepEqual(config.turnUrls, []);
});

test("loadConfig parses deployment settings", () => {
  const config = loadConfig({
    PORT: "8080",
    SERVE_STATIC: "false",
    ALLOWED_ORIGINS: "https://watch.example.com, https://admin.example.com",
    STUN_URLS: "stun:turn.example.com:3478",
    TURN_URLS: "turn:turn.example.com:3478?transport=udp, turn:turn.example.com:3478?transport=tcp",
    TURN_SHARED_SECRET: "test-secret",
  });
  assert.equal(config.port, 8080);
  assert.equal(config.serveStatic, false);
  assert.deepEqual(config.allowedOrigins, ["https://watch.example.com", "https://admin.example.com"]);
  assert.equal(config.turnUrls.length, 2);
});

test("loadConfig rejects invalid values", () => {
  assert.throws(() => loadConfig({ PORT: "invalid" }), /PORT must be an integer/);
  assert.throws(() => loadConfig({ SERVE_STATIC: "yes" }), /SERVE_STATIC must be either true or false/);
  assert.throws(() => loadConfig({ WS_PATH: "ws" }), /WS_PATH must be an absolute URL path/);
  assert.throws(() => loadConfig({ MACCMS_SOURCES: "bad|http://example.com/api.php/provide/vod/" }), /HTTPS video provide URLs/);
});

test("loadConfig reads administrator, OSS, and MacCMS settings", () => {
  const config = loadConfig({
    ADMIN_TOKEN: "secret", MACCMS_SOURCES: "Catalog|https://example.com/api.php/provide/vod/",
    OSS_REGION: "oss-cn-hangzhou", OSS_BUCKET: "movies", OSS_PUBLIC_URL: "https://cdn.example.com/",
  });
  assert.equal(config.adminToken, "secret");
  assert.equal(config.macCmsSources[0].name, "Catalog");
  assert.equal(config.oss.publicUrl, "https://cdn.example.com");
});

test("environment files configure native startup while inherited values take precedence", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "watch-env-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = join(directory, ".env");
  writeFileSync(filePath, "ADMIN_TOKEN=from-file\nMACCMS_SOURCES=Catalog|https://example.com/api.php/provide/vod/\n");
  const configUrl = new URL("./config.js", import.meta.url).href;
  const script = `import { loadConfig, loadEnvironment } from ${JSON.stringify(configUrl)};
    loadEnvironment(${JSON.stringify(filePath)});
    loadEnvironment(${JSON.stringify(join(directory, "missing.env"))});
    const config = loadConfig();
    console.log(JSON.stringify({ token: config.adminToken, sources: config.macCmsSources }));`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, ADMIN_TOKEN: "inherited", MACCMS_SOURCES: undefined }, encoding: "utf8",
  });
  const config = JSON.parse(output);
  assert.equal(config.token, "inherited");
  assert.equal(config.sources[0].name, "Catalog");
});
