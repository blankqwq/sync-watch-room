import { createHmac } from "node:crypto";

function validateUrls(urls, protocols, name) {
  for (const url of urls) {
    const protocol = url.split(":", 1)[0];
    if (!protocols.includes(protocol)) {
      throw new Error(`${name} contains an unsupported URL: ${url}`);
    }
  }
}

export function createIceServerProvider(config, now = () => Date.now()) {
  validateUrls(config.stunUrls, ["stun", "stuns"], "STUN_URLS");
  validateUrls(config.turnUrls, ["turn", "turns"], "TURN_URLS");
  if (config.turnUrls.length && !config.turnSharedSecret) {
    throw new Error("TURN_SHARED_SECRET is required when TURN_URLS is configured");
  }

  return (subject = "guest") => {
    const iceServers = [];
    if (config.stunUrls.length) iceServers.push({ urls: config.stunUrls });
    if (!config.turnUrls.length) return iceServers;

    const expiresAt = Math.floor(now() / 1000) + config.turnCredentialTtlSeconds;
    const safeSubject = String(subject).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "guest";
    const username = `${expiresAt}:${safeSubject}`;
    const credential = createHmac("sha1", config.turnSharedSecret).update(username).digest("base64");
    iceServers.push({ urls: config.turnUrls, username, credential });
    return iceServers;
  };
}
