import { createStore } from "./store.js";

const defaults = { name: "同频放映室", icon: "/couple-tv-icon.png" };

function normalizeIcon(value) {
  const icon = String(value || "").trim();
  if (!icon || icon === defaults.icon) return defaults.icon;
  if (icon.startsWith("data:")) {
    const match = /^data:image\/(png|jpeg|webp);base64,([a-zA-Z0-9+/]+={0,2})$/.exec(icon);
    if (!match || match[2].length > 700000 || Buffer.from(match[2], "base64").length > 512 * 1024) {
      throw new TypeError("图标需为 PNG、JPEG 或 WebP，且不超过 512 KB");
    }
    return icon;
  }
  let url;
  try { url = new URL(icon); } catch { throw new TypeError("请填写有效的图标图片地址"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || icon.length > 2048) {
    throw new TypeError("图标地址只支持 HTTP 或 HTTPS");
  }
  return url.toString();
}

export function createSettings(dataDir, database = null) {
  const store = createStore(dataDir, "settings.json", [defaults], database);
  function read() { return { ...defaults, ...store.read()[0] }; }
  function update(input) {
    const name = String(input.name || "").trim();
    if (!name || name.length > 24 || /[\u0000-\u001f\u007f]/.test(name)) throw new TypeError("应用名称需为 1–24 个字符");
    const settings = { name, icon: normalizeIcon(input.icon) };
    return store.update(() => ({ items: [settings], result: settings }));
  }
  return { read, update };
}
