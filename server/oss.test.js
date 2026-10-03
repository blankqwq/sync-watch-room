import assert from "node:assert/strict";
import test from "node:test";
import { createOss } from "./oss.js";

test("OSS signs a short-lived V4 PUT URL without exposing credentials to the client", async () => {
  const oss = createOss({
    region: "oss-cn-hangzhou", bucket: "demo-bucket",
    accessKeyId: "test-id", accessKeySecret: "test-secret", publicUrl: "https://cdn.example.com",
  });
  const signed = await oss.signUpload("movie.mp4", 123);
  const url = new URL(signed.uploadUrl);
  assert.equal(url.searchParams.get("x-oss-signature-version"), "OSS4-HMAC-SHA256");
  assert.equal(signed.contentType, "video/mp4");
  assert.equal(signed.url, `https://cdn.example.com/${signed.key}`);
  assert.ok(!JSON.stringify(signed).includes("test-secret"));
  await assert.rejects(oss.signUpload("movie.exe", 123), /Only MP4 and WebM/);
});
