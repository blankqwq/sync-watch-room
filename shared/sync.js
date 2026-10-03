export const SYNC_TICK_MS = 50;
export const SYNC_PROTOCOL = 1;
export const SYNC_LEASE_MS = 300;
export const MAX_SYNC_DELAY_MS = 150;
export const MAX_DRIFT_SECONDS = 0.15;
export const ALIGN_TOLERANCE_SECONDS = 0.08;

export function reportedPosition(playback, now) {
  const elapsed = playback.paused || playback.buffering || !playback.ready ? 0 : Math.max(0, now - playback.sampledAt) / 1000;
  return playback.position + elapsed;
}

export function memberSyncIssue(member, state, now, starting = false) {
  const playback = member.playback;
  if (!playback || playback.mediaUrl !== state.mediaUrl) return "等待片源";
  if (now - member.statusAt > SYNC_LEASE_MS || now - playback.sampledAt > MAX_SYNC_DELAY_MS || playback.sampledAt > now + 100 || playback.syncRttMs > MAX_SYNC_DELAY_MS) return "同步信号延迟";
  if (!playback.ready || playback.buffering) return "等待缓冲";
  if (playback.sequence !== state.sequence) return "等待进度确认";
  if (starting && (!playback.paused || Math.abs(playback.position - state.position) > ALIGN_TOLERANCE_SECONDS)) return "等待进度对齐";
  if (!starting && (playback.paused || Math.abs(reportedPosition(playback, now) - state.position) > MAX_DRIFT_SECONDS)) return "播放进度偏差";
  return "";
}
