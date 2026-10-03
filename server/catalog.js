import { createHash, randomUUID } from "node:crypto";
import { createStore } from "./store.js";
import { episodeKey } from "./discovery.js";
import { plainText } from "./text.js";

export function mediaUrl(value) {
  const url = new URL(String(value || ""));
  if (url.href.length > 2048 || !["https:", "http:"].includes(url.protocol) || !/\.(mp4|webm|m3u8)(?:$|[?#])/i.test(url.href)) {
    throw new Error("Video URL must be an HTTP(S) MP4, WebM, or M3U8 file");
  }
  return url.toString();
}

function optionalUrl(value) {
  if (!value) return "";
  const url = new URL(String(value));
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Image URL must use HTTP(S)");
  return url.toString();
}

function normalizedResource(input, existing = null) {
  input = { ...existing, ...input };
  const title = String(input.title || "").trim().slice(0, 120);
  if (!title) throw new Error("Video title is required");
  return {
    id: existing?.id || randomUUID(), title, url: mediaUrl(input.url),
    poster: optionalUrl(input.poster),
    description: plainText(input.description),
    source: String(input.source || "manual").slice(0, 80),
    seriesTitle: String(input.seriesTitle || "").slice(0, 120),
    year: String(input.year || "").slice(0, 10),
    episodeLabel: String(input.episodeLabel || "").slice(0, 60),
    episodeCount: Math.max(0, Math.min(10000, Math.floor(Number(input.episodeCount) || 0))),
    doubanId: Number(input.doubanId) > 0 ? String(Number(input.doubanId)) : "",
    networkReferences: Array.isArray(input.networkReferences) ? input.networkReferences.filter(reference => reference && /^[a-f0-9-]{24,36}$/.test(reference.sourceId) && /^\d+$/.test(String(reference.vodId))).slice(0, 16) : [],
    enabled: input.enabled === undefined ? existing?.enabled !== false : Boolean(input.enabled),
    createdAt: existing?.createdAt || Date.now(),
  };
}

export function createCatalog(dataDir, database = null) {
  const store = createStore(dataDir, "catalog.json", [], database);
  function list(includeDisabled = false) { return store.read().filter(resource => includeDisabled || resource.enabled); }
  function identity(resource) {
      const parts = resource.title.split(" · ");
      let title = (resource.seriesTitle || parts[0]).normalize("NFKC").toLowerCase().replace(/\s/g, "");
      if (/^(19|20)\d{2}$/.test(resource.year)) title = title.replace(new RegExp(`[（(]?${resource.year}[)）]?$`), "");
      const label = resource.episodeLabel || (parts.length > 1 ? parts.at(-1) : "");
      let episode = episodeKey(label);
      if (resource.episodeCount === 1 && !episode.startsWith("episode:") && !episode.startsWith("date:") && !/^(上|下|中)(部|集|篇)?$/.test(label)) episode = "";
      return `${resource.doubanId ? `douban:${resource.doubanId}` : `${title}|${resource.year || ''}`}|${episode}`;
  }
  function unique(resources) {
    const records = new Map();
    for (const resource of resources) {
      const key = identity(resource);
      if (!records.has(key)) records.set(key, resource);
    }
    return [...records.values()];
  }
  function published() { return unique(list()); }
  function groups() {
    const records = new Map();
    const enabled = list();
    const alternatives = new Map();
    for (const resource of enabled) {
      const key = identity(resource);
      if (!alternatives.has(key)) alternatives.set(key, []);
      alternatives.get(key).push({ id: resource.id, url: resource.url });
    }
    for (const resource of unique(enabled)) {
      const title = resource.seriesTitle || resource.title.split(" · ")[0];
      const key = resource.doubanId ? `douban:${resource.doubanId}` : `${title.normalize("NFKC").toLowerCase()}|${resource.year || ''}`;
      const id = `library_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
      if (!records.has(id)) records.set(id, { id, kind: "library", title, year: resource.year, poster: resource.poster, description: plainText(resource.description), items: [] });
      records.get(id).items.push({ ...resource, alternatives: alternatives.get(identity(resource)).filter(item => item.id !== resource.id) });
    }
    const order = new Intl.Collator("zh-CN", { numeric: true });
    return [...records.values()].map(group => ({ ...group, items: group.items.sort((a, b) => order.compare(episodeKey(a.episodeLabel || a.title.split(' · ').at(-1)), episodeKey(b.episodeLabel || b.title.split(' · ').at(-1)))) }));
  }
  function group(id) { return groups().find(group => group.id === id); }
  function find(id) { return store.read().find(resource => resource.id === id); }
  function upsert(input, id = null) {
    return store.update(resources => {
      const url = mediaUrl(input.url);
      const existing = id ? resources.find(resource => resource.id === id) : resources.find(resource => resource.url === url);
      if (id && !existing) return { items: resources, result: null };
      const resource = normalizedResource(input, existing);
      return { items: existing ? resources.map(item => item.id === existing.id ? resource : item) : [resource, ...resources], result: resource };
    });
  }
  function remove(id) {
    return store.update(resources => ({ items: resources.filter(resource => resource.id !== id), result: resources.some(resource => resource.id === id) }));
  }
  function upsertMany(inputs) {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 300) throw new Error("Collection must contain 1–300 resources");
    return store.update(original => {
      const items = [...original];
      const resources = inputs.map(input => {
        const url = mediaUrl(input.url);
        const existing = items.find(resource => resource.url === url);
        const resource = normalizedResource(input, existing);
        if (existing) items[items.indexOf(existing)] = resource;
        else items.unshift(resource);
        return resource;
      });
      return { items, result: resources };
    });
  }
  return { list, identity, unique, published, groups, group, find, upsert, upsertMany, remove };
}
