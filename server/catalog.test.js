import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCatalog } from "./catalog.js";

test("catalog mutations survive reload and failed writes do not publish resources", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "watch-store-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const catalog = createCatalog(directory);
  const filePath = join(directory, "catalog.json");
  mkdirSync(filePath);
  const input = { title: "Demo", url: "https://example.com/demo.mp4" };
  assert.throws(() => catalog.upsert(input));
  assert.deepEqual(catalog.list(), []);
  assert.deepEqual(readdirSync(directory), ["catalog.json"]);

  rmSync(filePath, { recursive: true });
  const resource = catalog.upsert(input);
  assert.equal(createCatalog(directory).find(resource.id).title, "Demo");
  const duplicate = catalog.upsert({ ...input, title: "Updated demo" });
  assert.equal(duplicate.id, resource.id);
  assert.equal(catalog.list().length, 1);
  catalog.upsert({ ...resource, enabled: false }, resource.id);
  assert.deepEqual(createCatalog(directory).list(), []);
  assert.equal(createCatalog(directory).list(true).length, 1);
  catalog.remove(resource.id);
  assert.deepEqual(createCatalog(directory).list(true), []);
});
