import { createHash, randomUUID } from "node:crypto";
import { normalizeSourceUrl } from "./maccms.js";
import { createStore } from "./store.js";

export const sourcePresets = [
  { name: "非凡资源", url: "https://api.ffzyapi.com/api.php/provide/vod/from/ffm3u8/", description: "电影、剧集与动漫 · M3U8" },
  { name: "量子资源", url: "https://cj.lziapi.com/api.php/provide/vod/from/lzm3u8/", description: "电影、剧集与综艺 · M3U8" },
];

export function createSources(dataDir, configuredSources = [], database = null) {
  const initialSources = configuredSources.map((source) => ({
    ...source,
    id: createHash("sha256").update(source.url).digest("hex").slice(0, 24),
    enabled: true,
    public: true,
    updatedAt: 0,
  }));
  const store = createStore(dataDir, "sources.json", initialSources, database);

  function list(includePrivate = false) {
    return store.read().filter((source) => includePrivate || (source.enabled && source.public));
  }

  function find(id) {
    return store.read().find((source) => source.id === id);
  }

  function upsert(input, id = null) {
    return store.update((items) => {
    const existing = id ? items.find((source) => source.id === id) : null;
    if (id && !existing) return { items, result: null };
    const name = String(input.name || "").trim().slice(0, 40);
    if (!name) throw new Error("Source name is required");
    const url = normalizeSourceUrl(input.url);
    if (items.some((source) => source.url === url && source.id !== id)) {
      throw new Error("Source already exists");
    }
    const source = {
      id: existing?.id || randomUUID(), name, url,
      enabled: input.enabled === undefined ? existing?.enabled !== false : Boolean(input.enabled),
      public: input.public === undefined ? Boolean(existing?.public) : Boolean(input.public),
      updatedAt: Date.now(),
    };
    return { items: existing ? items.map((item) => item.id === id ? source : item) : [...items, source], result: source };
    });
  }

  function remove(id) {
    if (!find(id)) return false;
    return store.update((items) => ({ items: items.filter((source) => source.id !== id), result: true }));
  }

  return { list, find, upsert, remove };
}
