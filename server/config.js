import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeSourceUrl } from "./maccms.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export function loadEnvironment(filePath = join(projectRoot, ".env")) {
  try {
    loadEnvFile(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function readInteger(env, name, fallback, { min, max }) {
  const rawValue = env[name];
  if (rawValue === undefined || rawValue === "") return fallback;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function readBoolean(env, name, fallback) {
  const rawValue = env[name];
  if (rawValue === undefined || rawValue === "") return fallback;
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  throw new Error(`${name} must be either true or false`);
}

function readPath(env, name, fallback) {
  const value = String(env[name] || fallback).trim();
  if (!value.startsWith("/") || value.length > 64) {
    throw new Error(`${name} must be an absolute URL path`);
  }
  return value;
}

function readList(env, name, fallback = "") {
  return String(env[name] || fallback)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readSources(value) {
  return String(value || "").split(",").map((entry) => {
    const [name, address] = entry.trim().split("|");
    if (!name && !address) return null;
    let url;
    try {
      url = normalizeSourceUrl(address);
    } catch {
      throw new Error("MACCMS_SOURCES must contain HTTPS video provide URLs");
    }
    if (!name.trim()) throw new Error("MACCMS_SOURCES must include a source name");
    return { name: name.trim().slice(0, 40), url };
  }).filter(Boolean);
}

export function loadConfig(env = process.env) {
  return {
    nodeEnv: env.NODE_ENV || "development",
    host: env.HOST || "0.0.0.0",
    port: readInteger(env, "PORT", 4173, { min: 1, max: 65535 }),
    wsPath: readPath(env, "WS_PATH", "/ws"),
    serveStatic: readBoolean(env, "SERVE_STATIC", true),
    distDir: env.DIST_DIR || join(projectRoot, "dist"),
    heartbeatIntervalMs: readInteger(env, "HEARTBEAT_INTERVAL_MS", 5000, { min: 1000, max: 60000 }),
    shutdownTimeoutMs: readInteger(env, "SHUTDOWN_TIMEOUT_MS", 10000, { min: 1000, max: 60000 }),
    maxPayloadBytes: readInteger(env, "WS_MAX_PAYLOAD_BYTES", 65536, { min: 1024, max: 1048576 }),
    allowedOrigins: readList(env, "ALLOWED_ORIGINS"),
    adminToken: String(env.ADMIN_TOKEN || ""),
    dataDir: env.DATA_DIR || join(projectRoot, "data"),
    databaseUrl: String(env.DATABASE_URL || ""),
    databaseSchema: String(env.DATABASE_SCHEMA || "public"),
    secureCookies: readBoolean(env, "SESSION_COOKIE_SECURE", env.NODE_ENV === "production"),
    macCmsSources: readSources(env.MACCMS_SOURCES),
    oss: {
      region: String(env.OSS_REGION || ""),
      bucket: String(env.OSS_BUCKET || ""),
      accessKeyId: String(env.OSS_ACCESS_KEY_ID || ""),
      accessKeySecret: String(env.OSS_ACCESS_KEY_SECRET || ""),
      publicUrl: String(env.OSS_PUBLIC_URL || "").replace(/\/$/, ""),
    },
    stunUrls: readList(env, "STUN_URLS", "stun:stun.l.google.com:19302"),
    turnUrls: readList(env, "TURN_URLS"),
    turnSharedSecret: String(env.TURN_SHARED_SECRET || ""),
    turnCredentialTtlSeconds: readInteger(env, "TURN_CREDENTIAL_TTL_SECONDS", 3600, { min: 300, max: 86400 }),
  };
}
