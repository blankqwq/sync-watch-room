import { requestJson } from "./api.js";

export async function uploadOssFile(file, token, { title = file.name, publish = true, onProgress, signal } = {}) {
  if (!/\.(mp4|webm)$/i.test(file.name)) throw new Error("请选择 MP4 或 WebM 视频");
  if (file.size < 1 || file.size > 1073741824) throw new Error("请选择不超过 1 GiB 的非空视频文件");
  const signed = await requestJson("/api/admin/uploads", token, { method: "POST", body: JSON.stringify({ fileName: file.name, size: file.size }), signal });
  await new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const finish = (error) => { signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(); };
    request.open("PUT", signed.uploadUrl);
    request.setRequestHeader("Content-Type", signed.contentType);
    request.timeout = 3600000;
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress?.(Math.round(event.loaded * 100 / event.total)); };
    request.onload = () => finish(request.status >= 200 && request.status < 300 ? null : new Error(`OSS 上传失败 (${request.status})`));
    request.onerror = () => finish(new Error("上传失败，请检查网络与 OSS 跨域配置"));
    request.ontimeout = () => finish(new Error("上传超时，请重新上传"));
    request.onabort = () => finish(new DOMException("上传已取消", "AbortError"));
    if (signal?.aborted) { finish(new DOMException("上传已取消", "AbortError")); return; }
    signal?.addEventListener("abort", abort, { once: true });
    request.send(file);
  });
  const result = await requestJson("/api/admin/uploads/complete", token, { method: "POST", body: JSON.stringify({ key: signed.key, title, publish }), signal });
  return { ...result, key: signed.key, fileName: file.name };
}
