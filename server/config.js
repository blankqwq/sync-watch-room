import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

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
    stunUrls: readList(env, "STUN_URLS", "stun:stun.l.google.com:19302"),
    turnUrls: readList(env, "TURN_URLS"),
    turnSharedSecret: String(env.TURN_SHARED_SECRET || ""),
    turnCredentialTtlSeconds: readInteger(env, "TURN_CREDENTIAL_TTL_SECONDS", 3600, { min: 300, max: 86400 }),
  };
}
