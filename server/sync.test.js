import assert from "node:assert/strict";
import test from "node:test";
import { memberSyncIssue, MAX_DRIFT_SECONDS, SYNC_LEASE_MS } from "../shared/sync.js";

test("sync policy compensates report transit time and rejects stale, unaligned or buffering members", () => {
  const now = 1000;
  const state = { mediaUrl: "https://example.com/video.mp4", position: 10, sequence: 2 };
  const member = { statusAt: now, playback: { mediaUrl: state.mediaUrl, position: 9.95, sequence: 2, sampledAt: now - 50, syncRttMs: 20, paused: false, ready: true, buffering: false } };
  assert.equal(memberSyncIssue(member, state, now), "");
  for (const patch of [{ buffering: true }, { ready: false }, { sequence: 1 }, { paused: true }, { position: 10 + MAX_DRIFT_SECONDS }, { sampledAt: 0 }, { syncRttMs: 500 }]) {
    assert.ok(memberSyncIssue({ ...member, playback: { ...member.playback, ...patch } }, state, now));
  }
  assert.ok(memberSyncIssue({ ...member, statusAt: now - SYNC_LEASE_MS - 1 }, state, now));
  const aligned = { ...member, playback: { ...member.playback, position: 10, paused: true } };
  assert.equal(memberSyncIssue(aligned, state, now, true), "");
  assert.ok(memberSyncIssue({ ...aligned, playback: { ...aligned.playback, position: 10.1 } }, state, now, true));
});
