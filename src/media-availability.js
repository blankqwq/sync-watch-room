import { reactive } from "vue";

const failures = reactive(new Map());
const resources = reactive(new Map());
const checked = new Map();
const pending = new Map();

export function isMediaUnavailable(url) { return (failures.get(url) || 0) > Date.now(); }
export function markMediaUnavailable(url) {
  checked.delete(url);
  if (failures.size >= 500) failures.delete(failures.keys().next().value);
  failures.set(url, Date.now() + 10 * 60 * 1000);
}
export function clearMediaFailure(url) { failures.delete(url); checked.delete(url); }
export function markMediaAvailable(url) { failures.delete(url); checked.set(url, Date.now() + 60000); }
function unavailable(message) { return Object.assign(new Error(message), { unavailable: true }); }
function responseError(response) {
  return [404, 410].includes(response.status) ? unavailable(`HLS 文件已失效 (${response.status})`) : new Error(`HLS 请求失败 (${response.status})`);
}
export function registerMediaResource(id, urls) {
  if (resources.size >= 500) resources.delete(resources.keys().next().value);
  resources.set(id, urls);
}
export function isResourceUnavailable(id) {
  const urls = resources.get(id);
  return Boolean(urls?.length && urls.every(isMediaUnavailable));
}

async function readManifest(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) { await response.body?.cancel(); throw responseError(response); }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) throw new Error("HLS 清单过大，交由播放器加载");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const text = new TextDecoder().decode(bytes).trim();
  if (!/^#EXTM3U(?:\r?\n|$)/.test(text)) throw unavailable("HLS 清单格式无效");
  return { text, base: response.url || url };
}

async function probeHls(url, signal, depth = 0) {
  if (depth > 3) throw new Error("HLS 清单层级较深，交由播放器加载");
  const { text, base } = await readManifest(url, signal);
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const addresses = lines.filter(line => line && !line.startsWith("#"));
  if (lines.some(line => line.startsWith("#EXT-X-STREAM-INF:"))) {
    let uncertain = null;
    for (const address of addresses.slice(0, 6)) {
      try { await probeHls(new URL(address, base).href, signal, depth + 1); return; }
      catch (error) { if (signal.aborted) throw error; if (!error.unavailable) uncertain = error; }
    }
    if (uncertain || addresses.length > 6) throw uncertain || new Error("HLS 画质线路尚未检查完成");
    throw unavailable("HLS 没有可用画质线路");
  }
  if (!addresses.length || !lines.some(line => line.startsWith("#EXTINF:"))) {
    if (!lines.includes("#EXT-X-ENDLIST") && lines.some(line => line.startsWith("#EXT-X-TARGETDURATION:"))) throw new Error("直播清单正在等待分片");
    throw unavailable("HLS 没有可播放的分片");
  }
  const required = [new URL(addresses[0], base).href];
  for (const line of lines) {
    if (line && !line.startsWith("#")) break;
    if (!/^#EXT-X-(MAP|KEY):/.test(line) || line.includes("METHOD=NONE")) continue;
    const uri = /(?:^|,)URI="([^"]+)"/.exec(line.slice(line.indexOf(":") + 1))?.[1];
    if (uri) required.push(new URL(uri, base).href);
    if (required.length >= 4) break;
  }
  for (const address of required) {
    const response = await fetch(address, { signal });
    await response.body?.cancel();
    if (!response.ok) throw responseError(response);
  }
}

export async function checkMediaAvailability(url) {
  if (!/\.m3u8(?:$|[?#])/i.test(url || "")) return;
  if (isMediaUnavailable(url)) throw unavailable("已跳过无法加载的 HLS 线路，请选择其他线路，或在播放器重试");
  if ((checked.get(url) || 0) > Date.now()) return;
  if (pending.has(url)) return pending.get(url);
  const task = (async () => {
    try {
      await probeHls(url, AbortSignal.timeout(8000));
      if (checked.size >= 500) checked.delete(checked.keys().next().value);
      markMediaAvailable(url);
    } catch (cause) {
      // Timeouts, CORS and access restrictions do not prove that the media is invalid.
      if (!cause.unavailable || globalThis.navigator?.onLine === false) return;
      markMediaUnavailable(url);
      throw unavailable("这个 HLS 资源已失效，已跳过，请选择其他线路或资源");
    } finally { pending.delete(url); }
  })();
  pending.set(url, task);
  return task;
}
