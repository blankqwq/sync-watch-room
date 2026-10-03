export function describeHlsError(data, url, origin, online = true) {
  const status = Number(data.response?.code || data.networkDetails?.status || 0);
  if (status === 403) return { kind: "http", message: "资源站拒绝访问（403），请重试或切换线路" };
  if ([404, 410].includes(status)) return { kind: "http", message: "这条线路的文件已失效，请切换线路" };
  if (status >= 400) return { kind: "http", message: `资源站请求失败（${status}），请重试或切换线路` };
  if (data.type !== "networkError") return { kind: "media", message: "这条 HLS 线路无法播放，请重试或切换线路" };
  if (!online) return { kind: "offline", message: "网络已断开，请连接网络后重试" };
  if (/timeout/i.test(data.details || "")) return { kind: "timeout", message: "资源请求超时，请重试或切换线路" };
  const details = `${data.error?.message || ""} ${data.reason || ""}`;
  if (/\bCORS\b|cross[- ]origin|access-control-allow-origin|跨域/i.test(details)) {
    return { kind: "cors", message: "该资源被跨域限制，无法加载，请切换线路或资源" };
  }
  try {
    if (!status && new URL(url, origin).origin !== new URL(origin).origin) {
      return { kind: "cross-origin", message: "该资源跨域加载失败，请重试或切换线路或资源" };
    }
  } catch { /* Invalid addresses keep the general network error message. */ }
  return { kind: "network", message: "HLS 网络加载失败，请重试或切换线路" };
}
