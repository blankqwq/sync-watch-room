import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSources } from "./sources.js";

test("source settings persist, private sources stay private, and deletions override env seeds", (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), "watch-sources-"));
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const seeds = [{ name: "Seed", url: "https://example.com/api.php/provide/vod/" }];
  const sources = createSources(dataDir, seeds);
  const id = sources.list()[0].id;
  assert.equal(createSources(dataDir, seeds).list()[0].id, id);
  const added = sources.upsert({ name: "Private", url: "https://other.example.com/custom.php" });
  assert.equal(sources.list().length, 1);
  assert.equal(createSources(dataDir, seeds).find(added.id).public, false);
  sources.upsert({ ...added, public: true }, added.id);
  assert.equal(createSources(dataDir, seeds).list().length, 2);
  sources.remove(id);
  sources.remove(added.id);
  assert.deepEqual(createSources(dataDir, seeds).list(true), []);
});

test("source URLs normalize XML providers to JSON and reject duplicate entries", (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), "watch-source-url-"));
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const sources = createSources(dataDir);
  const source = sources.upsert({ name: "Movies", url: "https://example.com/api.php/provide/vod/at/xml/" });
  assert.equal(source.url, "https://example.com/api.php/provide/vod/at/json/");
  assert.throws(() => sources.upsert({ name: "Duplicate", url: source.url }), /already exists/);
  assert.throws(() => sources.upsert({ name: "HTTP", url: "http://example.com/api" }), /HTTPS/);
});
