import assert from "node:assert/strict";
import test from "node:test";
import { describeHlsError } from "./media-errors.js";

const origin = "https://watch.example.com";
const media = "https://media.example.com/index.m3u8";
const network = { type: "networkError", details: "manifestLoadError", response: { code: 0 } };

test("explicit CORS failures show the blocked resource message", () => {
  const result = describeHlsError({ ...network, error: new Error("Blocked by CORS: missing Access-Control-Allow-Origin") }, media, origin);
  assert.equal(result.kind, "cors");
  assert.match(result.message, /该资源被跨域限制/);
});

test("opaque cross-origin failures get a cross-origin loading hint without claiming a confirmed CORS policy error", () => {
  const result = describeHlsError(network, media, origin);
  assert.equal(result.kind, "cross-origin");
  assert.match(result.message, /跨域加载失败/);
  assert.doesNotMatch(result.message, /被跨域限制/);
  assert.equal(describeHlsError(network, "/index.m3u8", origin).kind, "network");
});

test("HTTP responses, offline state, timeout and codec errors keep their own reasons", () => {
  for (const status of [403, 404, 410, 502]) {
    const result = describeHlsError({ ...network, response: { code: status } }, media, origin);
    assert.equal(result.kind, "http");
    assert.doesNotMatch(result.message, /跨域/);
  }
  assert.equal(describeHlsError(network, media, origin, false).kind, "offline");
  assert.equal(describeHlsError({ ...network, details: "fragLoadTimeOut" }, media, origin).kind, "timeout");
  assert.equal(describeHlsError({ type: "mediaError" }, media, origin).kind, "media");
});
