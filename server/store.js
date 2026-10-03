import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function createStore(dataDir, fileName, initialItems = [], database = null) {
  const filePath = join(dataDir, fileName);
  let items;
  try {
    items = JSON.parse(readFileSync(filePath, "utf8"));
    if (!Array.isArray(items)) throw new Error(`Invalid ${fileName}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    items = initialItems;
  }
  if (database) return database.document(fileName, items);

  function write(nextItems) {
    mkdirSync(dataDir, { recursive: true });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(nextItems, null, 2));
      renameSync(temporaryPath, filePath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
    items = nextItems;
  }

  function update(change) {
    const next = change(items);
    write(next.items);
    return next.result;
  }
  return { read: () => items, update };
}
