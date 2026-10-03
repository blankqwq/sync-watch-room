import { createHash } from "node:crypto";
import { fetchMacCms } from "./maccms.js";

export function episodeKey(label) {
  const text = String(label || "").normalize("NFKC").trim().toLowerCase();
  const separated = /^第?(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})(?:日|期)?(.*)$/.exec(text);
  if (separated) return `date:${separated[1]}${separated[2].padStart(2, '0')}${separated[3].padStart(2, '0')}:${separated[4]}`;
  const compact = /^第?(20\d{6})(?:期)?(.*)$/.exec(text);
  if (compact) return `date:${compact[1]}:${compact[2]}`;
  const number = /(?:第|ep)\s*0*(\d+)(?:集|期|话|話)?/.exec(text) || /^0*(\d+)(?:集|期|话|話)?$/.exec(text);
  return number ? `episode:${Number(number[1])}` : text;
}

function titleKey(item) {
  let title = item.title.normalize("NFKC").toLowerCase().replace(/[\s·・:：，,。!！?？]/g, "");
  if (/^(19|20)\d{2}$/.test(item.year)) title = title.replace(new RegExp(`[（(]?${item.year}[)）]?$`), "");
  return `${title}|${item.year || ''}`;
}

function contentKey(item, knownIds) {
  const base = titleKey(item);
  const id = Number(item.doubanId) > 0 ? item.doubanId : knownIds.get(base)?.size === 1 ? [...knownIds.get(base)][0] : "";
  return createHash("sha256").update(id ? `douban:${id}` : base).digest("hex");
}

export function createDiscovery(sources, preparePlaylist) {
  const index = new Map();
  const cache = new Map();

  async function search({ keyword = "", page = 1 } = {}) {
    const available = sources.list();
    const key = JSON.stringify([available.map((source) => [source.id, source.updatedAt]), keyword, page]);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.data;
    const results = await Promise.allSettled(available.map(async (source) => ({ source, data: await fetchMacCms(source, { keyword, page }) })));
    const successful = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
    if (available.length && !successful.length) throw new Error("All resource sources are unavailable");
    const merged = new Map();
    const knownIds = new Map();
    for (const { data } of successful) for (const item of data.list) {
      if (Number(item.doubanId) > 0) {
        const base = titleKey(item);
        if (!knownIds.has(base)) knownIds.set(base, new Set());
        knownIds.get(base).add(item.doubanId);
      }
    }
    for (const { source, data } of successful) {
      for (const item of data.list) {
        const key = contentKey(item, knownIds);
        const entry = merged.get(key) || { ...item, key, variants: [] };
        if (!entry.poster && item.poster) entry.poster = item.poster;
        entry.variants.push({ sourceId: source.id, vodId: item.id });
        merged.set(key, entry);
      }
    }
    for (const [key, item] of merged) index.set(key, item);
    while (index.size > 2000) index.delete(index.keys().next().value);
    const data = {
      page, pagecount: Math.max(1, ...successful.map((result) => result.data.pagecount)),
      list: [...merged.values()].map(({ key, title, poster, description, remarks, year, category, variants }) => ({ id: key, key, title, poster, description, remarks, year, category, lineCount: variants.length })),
      partial: successful.length < available.length,
    };
    if (cache.size >= 100) cache.delete(cache.keys().next().value);
    cache.set(key, { data, expiresAt: Date.now() + 60000 });
    return data;
  }

  async function detailsFromReferences(references, key) {
    const results = await Promise.allSettled(references.map(async (reference) => {
      const source = sources.find(reference.sourceId);
      if (!source?.enabled || !source.public) throw new Error("Source not available");
      return (await fetchMacCms(source, { id: reference.vodId })).list[0];
    }));
    const items = results.filter((result) => result.status === "fulfilled" && result.value).map((result) => result.value);
    if (!items.length) throw Object.assign(new Error("这个资源暂时没有可用线路，请选择其他资源"), { status: 404 });
    const first = items[0];
    const lines = [];
    for (const item of items) {
      for (const line of [...new Set(item.episodes.map((episode) => episode.source))]) {
        const episodes = item.episodes.filter((episode) => episode.source === line);
        if (!episodes.length) continue;
        const name = `线路 ${lines.length + 1}`;
        const selectionId = preparePlaylist({
          title: first.title, poster: first.poster,
          context: { contentKey: key, title: first.title, poster: first.poster, references, year: first.year },
          items: episodes.map((episode) => ({ ...episode, title: `${first.title} · ${episode.label}`, poster: first.poster })),
        });
        lines.push({ name, selectionId, episodes: episodes.map(({ label, url }) => ({ label, url, source: name })) });
      }
    }
    return { id: key, key, title: first.title, poster: first.poster, description: first.description, year: first.year, category: first.category,
      episodes: lines.flatMap((line) => line.episodes), playlists: lines.map((line) => ({ line: line.name, selectionId: line.selectionId })), lines };
  }

  async function detail(key) {
    const item = index.get(key);
    if (!item) throw Object.assign(new Error("资源列表已更新，请重新搜索"), { status: 404 });
    return detailsFromReferences(item.variants, key);
  }
  async function findByTitle(title, year = "", preferredUrl = "") {
    const result = await search({ keyword: title });
    const normalized = titleKey({ title, year }).split("|")[0];
    const matches = result.list.filter((item) => titleKey(item).split("|")[0] === normalized && (!year || item.year === year));
    if (matches.length === 1) return detail(matches[0].key);
    if (preferredUrl) {
      const details = await Promise.allSettled(matches.map((item) => detail(item.key)));
      return details.find((result) => result.status === "fulfilled" && result.value.episodes.some((episode) => episode.url === preferredUrl))?.value || null;
    }
    return null;
  }
  return { search, detail, detailsFromReferences, findByTitle };
}
