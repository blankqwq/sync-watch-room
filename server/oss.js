import { randomUUID } from "node:crypto";
import OSS from "ali-oss";

const contentTypes = { mp4: "video/mp4", webm: "video/webm" };

export function createOss(config) {
  const values = Object.values(config);
  if (values.every((value) => !value)) return null;
  if (values.some((value) => !value)) throw new Error("OSS_REGION, OSS_BUCKET, OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, and OSS_PUBLIC_URL are all required");
  const publicUrl = new URL(config.publicUrl);
  if (publicUrl.protocol !== "https:") throw new Error("OSS_PUBLIC_URL must use HTTPS");
  const client = new OSS({
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    authorizationV4: true,
    secure: true,
    timeout: 15000,
  });

  function objectUrl(key) {
    return `${config.publicUrl}/${String(key).split("/").map(encodeURIComponent).join("/")}`;
  }

  async function listFiles({ prefix = "videos/", continuationToken = "" } = {}) {
    const result = await client.listV2({ prefix: String(prefix).slice(0, 500), "max-keys": 50, "continuation-token": continuationToken || undefined });
    return {
      files: (result.objects || []).filter((object) => /\.(mp4|webm|m3u8)$/i.test(object.name)).map((object) => ({
        key: object.name, size: object.size, modifiedAt: object.lastModified, url: objectUrl(object.name),
      })),
      nextToken: result.nextContinuationToken || "",
    };
  }

  async function deleteFile(key) {
    if (!key || key.length > 2048 || !/\.(mp4|webm|m3u8)$/i.test(key)) throw new Error("Video object key is invalid");
    await client.delete(key);
  }

  async function signUpload(fileName, size) {
    const extension = String(fileName || "").split(".").pop()?.toLowerCase();
    if (!contentTypes[extension]) throw new Error("Only MP4 and WebM uploads are supported");
    if (!Number.isInteger(size) || size < 1 || size > 1024 * 1024 * 1024) {
      throw new Error("Video size must be between 1 byte and 1 GiB");
    }
    const key = `videos/${Date.now()}-${randomUUID()}.${extension}`;
    const uploadUrl = await client.signatureUrlV4("PUT", 3600, { headers: { "Content-Type": contentTypes[extension] } }, key);
    return { key, uploadUrl, url: objectUrl(key), contentType: contentTypes[extension] };
  }

  async function verifyUpload(key) {
    if (!/^videos\/\d+-[0-9a-f-]+\.(mp4|webm)$/.test(key)) throw new Error("Invalid upload key");
    const result = await client.getObjectMeta(key);
    const size = Number(result.res.headers["content-length"]);
    if (!Number.isInteger(size) || size < 1 || size > 1024 * 1024 * 1024) {
      throw new Error("Video upload must be between 1 byte and 1 GiB");
    }
    return objectUrl(key);
  }

  return { signUpload, verifyUpload, objectUrl, listFiles, deleteFile };
}
