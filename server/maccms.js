import { plainText } from "./text.js";

export function normalizeSourceUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:" || url.username || url.password || url.href.length > 2048) {
    throw new Error("Source URL must use HTTPS");
  }
  url.pathname = url.pathname.replace(/\/at\/xml\/?$/, "/at/json/");
  url.hash = "";
  return url.toString();
}

function playableEpisodes(item) {
  const groups = String(item.vod_play_url || "").split("$$$");
  const sources = String(item.vod_play_from || "").split("$$$");
  const episodes = [];
  groups.forEach((group, groupIndex) => {
    group.split("#").forEach((part) => {
      const separator = part.indexOf("$");
      const label = separator < 0 ? "正片" : part.slice(0, separator);
      const address = separator < 0 ? part : part.slice(separator + 1);
      try {
        const url = new URL(address);
        if (url.protocol !== "https:" || !/\.(mp4|webm|m3u8)(?:$|[?#])/i.test(url.href)) return;
        if (url.href.length > 2048 || episodes.some((episode) => episode.url === url.href)) return;
        episodes.push({ label: label.slice(0, 60), url: url.toString(), source: sources[groupIndex] || "" });
      } catch { /* Ignore player pages and unsupported links. */ }
    });
  });
  return episodes;
}

export async function fetchMacCms(source, { keyword = "", page = 1, id = "" } = {}) {
  const url = new URL(source.url);
  url.searchParams.set("at", "json");
  url.searchParams.set("ac", id ? "detail" : "videolist");
  if (id) url.searchParams.set("ids", String(id));
  else {
    url.searchParams.set("pg", String(page));
    if (keyword) url.searchParams.set("wd", keyword);
  }
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Source returned ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error("Source response is too large");
    chunks.push(Buffer.from(chunk));
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (Number(payload.code) === 0) throw new Error("Source rejected the request");
  if (!Array.isArray(payload.list)) throw new Error("Invalid MacCMS response");
  return {
    page: Number(payload.page) || 1,
    pagecount: Number(payload.pagecount) || 1,
    list: payload.list.slice(0, 100).map((item) => ({
      id: String(item.vod_id || ""),
      title: plainText(item.vod_name, 120),
      poster: String(item.vod_pic || "").slice(0, 2048),
      description: plainText(item.vod_content),
      remarks: String(item.vod_remarks || "").slice(0, 60),
      year: /(?:19|20)\d{2}/.exec(String(item.vod_year || ""))?.[0] || "",
      doubanId: Number(item.vod_douban_id) > 0 ? String(Number(item.vod_douban_id)) : "",
      category: String(item.type_name || "").slice(0, 40),
      episodes: id ? playableEpisodes(item) : [],
    })),
  };
}
