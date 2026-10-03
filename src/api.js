export async function requestJson(path, token = "", options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  const data = await response.json().catch(() => ({ error: "服务暂时不可用，请稍后重试" }));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}
