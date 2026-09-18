import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createIceServerProvider } from "./ice.js";

test("createIceServerProvider signs temporary TURN credentials", () => {
  const config = {
    stunUrls: ["stun:turn.example.com:3478"],
    turnUrls: ["turn:turn.example.com:3478?transport=udp"],
    turnSharedSecret: "shared-secret",
    turnCredentialTtlSeconds: 3600,
  };
  const createIceServers = createIceServerProvider(config, () => 1_700_000_000_000);
  const iceServers = createIceServers("member-1");
  const username = "1700003600:member-1";

  assert.deepEqual(iceServers[0], { urls: config.stunUrls });
  assert.equal(iceServers[1].username, username);
  assert.equal(
    iceServers[1].credential,
    createHmac("sha1", "shared-secret").update(username).digest("base64"),
  );
});

test("createIceServerProvider requires a secret for TURN", () => {
  assert.throws(() => createIceServerProvider({
    stunUrls: [],
    turnUrls: ["turn:turn.example.com:3478"],
    turnSharedSecret: "",
    turnCredentialTtlSeconds: 3600,
  }), /TURN_SHARED_SECRET is required/);
});
