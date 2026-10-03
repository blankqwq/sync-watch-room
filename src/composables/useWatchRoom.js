import { computed, nextTick, onBeforeUnmount, reactive, ref } from "vue";
import { SYNC_TICK_MS, SYNC_LEASE_MS, SYNC_PROTOCOL, MAX_SYNC_DELAY_MS, MAX_DRIFT_SECONDS, ALIGN_TOLERANCE_SECONDS } from "../../shared/sync.js";
import { checkMediaAvailability, clearMediaFailure, markMediaAvailable, markMediaUnavailable } from "../media-availability.js";
import { describeHlsError } from "../media-errors.js";

const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const COMMAND_DELAY_MS = 350;
const MIN_BUFFER_AHEAD_SECONDS = 1.5;

function resolveIceServers() {
  const configuredServers = import.meta.env.VITE_ICE_SERVERS;
  if (!configuredServers) return DEFAULT_ICE_SERVERS;
  try {
    const servers = JSON.parse(configuredServers);
    if (Array.isArray(servers) && servers.length) return servers;
  } catch {
    console.warn("VITE_ICE_SERVERS must be a valid JSON array; using the default STUN server.");
  }
  return DEFAULT_ICE_SERVERS;
}

function resolveWebSocketUrl() {
  const configuredUrl = import.meta.env.VITE_WS_URL?.trim() || "/ws";
  const url = new URL(configuredUrl, location.href);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  return url.toString();
}

const BUILD_TIME_ICE_SERVERS = resolveIceServers();

export function useWatchRoom() {
  const videoElement = ref(null);
  const videoFrame = ref(null);
  const remoteAudioContainer = ref(null);

  const joined = ref(false);
  const joinName = ref(localStorage.getItem("watch-name") || "");
  const joinRoomId = ref(new URLSearchParams(location.search).get("room") || "");
  const selectedResource = ref(null);
  const playlist = ref([]);
  const playlistTitle = ref("");
  const playlistIndex = ref(-1);
  const autoAdvance = ref(true);
  const availableLines = ref([]);
  const linesLoading = ref(false);
  const lineLabel = ref("默认线路");
  const qualityLevels = ref([]);
  const selectedQuality = ref(-1);
  const currentQuality = ref(-1);
  const qualityMode = ref("original");
  const videoHeight = ref(0);
  const currentQualityLabel = computed(() => {
    const level = qualityLevels.value.find((item) => item.index === currentQuality.value);
    return videoHeight.value ? `${videoHeight.value}p` : level?.label || "";
  });
  const qualitySummary = computed(() => `${qualityMode.value === "native" ? "自动画质" : "原画"}${currentQualityLabel.value ? ` · ${currentQualityLabel.value}` : ""}`);
  const joining = ref(false);
  const requiresLogin = ref(false);
  const accountSignedOut = ref(false);
  let reconnectTimer = null;
  let disposed = false;
  let playbackGeneration = 0;
  const clientId = ref(null);
  const hostId = ref(null);
  const roomId = ref(null);
  const connected = ref(false);
  const connectionLabel = ref("连接中");

  const members = reactive(new Map());
  const messages = ref([]);
  const chatText = ref("");
  const typingPeers = reactive(new Map());
  const activeTab = ref("chat");

  const mediaUrl = ref("");
  const mediaLoadError = ref("");
  const mediaTitle = ref("尚未添加视频");
  const mediaPoster = ref("");
  const currentTime = ref(0);
  const duration = ref(0);
  const seekPreview = ref(null);
  const playerPaused = ref(true);
  const waitingForPeers = ref(false);
  const syncBlocked = ref(false);
  const autoplayBlocked = ref(false);
  const syncPauseReason = ref("");
  const volume = ref(1);
  const videoMuted = ref(false);

  const toast = ref("");
  const toastVisible = ref(false);
  const voiceJoined = ref(false);
  const voiceMuted = ref(false);
  const voiceStarting = ref(false);
  const voiceProcessing = ref(false);
  const voiceError = ref("");
  const savedNoiseSuppression = localStorage.getItem("watch-noise-suppression")
    ?? localStorage.getItem("watch-enhanced-noise");
  const noiseSuppressionEnabled = ref(savedNoiseSuppression !== "false");
  const savedMicrophoneGain = localStorage.getItem("watch-mic-gain");
  const storedMicrophoneGain = savedMicrophoneGain === null ? Number.NaN : Number(savedMicrophoneGain);
  const microphoneGain = ref(Number.isFinite(storedMicrophoneGain)
    ? Math.min(250, Math.max(0, storedMicrophoneGain))
    : 100);

  let socket = null;
  let hls = null;
  let loadedMediaUrl = "";
  let lineRequestVersion = 0;
  let sourceGeneration = 0;
  let sequence = -1;
  let iceServers = BUILD_TIME_ICE_SERVERS;
  let serverOffset = 0;
  let bestClockRtt = Infinity;
  let clockRtt = Infinity;
  let authorityState = null;
  let lastAuthorityAt = 0;
  let rawVoiceStream = null;
  let localVoiceStream = null;
  let voicePipeline = null;
  let rnnoiseResourcesPromise = null;
  let playbackBuffering = false;
  let pendingPlaybackBarrier = null;
  let lastPublishedStatus = "";
  let lastHeartbeatServerTime = 0;
  let lastEndedSequence = -1;
  let smoothedDrift = null;
  let localNetwork = { latencyMs: null, packetLoss: null, connectionState: "new", path: "checking" };
  let applyingRemote = false;
  let typingTimer = null;
  let lastTypingSent = false;
  let toastTimer = null;

  const peers = new Map();
  const pendingCommands = new Set();
  const scheduledCommands = new Set();
  const typingTimers = new Map();
  const remoteAudios = new Map();

  const memberList = computed(() => [...members.values()]);
  const isHost = computed(() => Boolean(clientId.value && clientId.value === hostId.value));
  const canControl = computed(() => isHost.value && Boolean(mediaUrl.value));
  const displayedTime = computed(() => seekPreview.value ?? currentTime.value);
  const mediaFormat = computed(() => {
    if (isHlsMedia(mediaUrl.value)) return "HLS";
    const extension = mediaUrl.value.split(/[?#]/)[0].split(".").pop()?.toUpperCase();
    return ["MP4", "WEBM", "OGG"].includes(extension) ? extension : "VIDEO";
  });
  const typingText = computed(() => {
    const names = [...typingPeers.values()];
    return names.length ? `${names.slice(0, 2).join("、")} 正在输入…` : "";
  });
  const voiceStatus = computed(() => {
    if (voiceError.value) return voiceError.value;
    if (voiceStarting.value) return "正在请求麦克风权限…";
    if (voiceProcessing.value) return "正在应用语音设置…";
    if (!voiceJoined.value) return "语音未加入";
    if (voiceMuted.value) return "语音中 · 已静音";
    return noiseSuppressionEnabled.value ? "语音中 · RNNoise" : "语音中";
  });
  const roomHealth = computed(() => {
    if (!mediaUrl.value) return { label: "等待片源", tone: "idle" };
    if (syncPauseReason.value) return { label: syncPauseReason.value, tone: "waiting" };
    if (syncBlocked.value) return { label: "同步信号不稳定，已保护暂停", tone: "waiting" };
    if (autoplayBlocked.value) return { label: "点击画面允许同步播放", tone: "waiting" };
    const memberValues = [...members.values()];
    const bufferingMembers = memberValues.filter((member) => member.playback?.mediaUrl !== mediaUrl.value
      || member.playback.buffering
      || !member.playback.ready);
    if (waitingForPeers.value || bufferingMembers.length) {
      const names = bufferingMembers.map((member) => member.id === clientId.value ? "你" : member.name).slice(0, 2);
      return { label: names.length ? `等待 ${names.join("、")} 缓冲` : "已暂停，等待全员同步", tone: "waiting" };
    }
    const poorNetwork = memberValues.some((member) => networkTone(member) === "poor");
    if (poorNetwork) return { label: "网络波动，正在保持同步", tone: "poor" };
    return { label: "全员已同步", tone: "good" };
  });
  const roomBufferSummary = computed(() => {
    if (!mediaUrl.value) return "";
    const summaries = [...members.values()].map((member) => {
      const name = member.id === clientId.value ? "你" : member.name;
      return `${name} ${bufferMetric(member)}`;
    });
    const visible = summaries.slice(0, 3).join(" · ");
    return summaries.length > 3 ? `缓存：${visible} · +${summaries.length - 3}` : `缓存：${visible}`;
  });

  function randomRoomId() {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  function send(payload) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }

  function estimatedServerTime() {
    return Date.now() + serverOffset;
  }

  function localTimeFromServer(serverTime) {
    return serverTime - serverOffset;
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return "00:00";
    const value = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const secs = value % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
      : `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  function bufferedAhead(video, position = video.currentTime) {
    for (let index = 0; index < video.buffered.length; index += 1) {
      if (video.buffered.start(index) <= position + 0.1 && video.buffered.end(index) >= position) {
        return Math.max(0, video.buffered.end(index) - position);
      }
    }
    return 0;
  }

  function createPlaybackStatus() {
    const video = videoElement.value;
    if (!video || !mediaUrl.value) {
      return { mediaUrl: "", position: 0, ready: true, buffering: false, bufferedAhead: 0, loadedPercent: 0 };
    }

    const position = video.currentTime || 0;
    const ahead = bufferedAhead(video, position);
    let loadedPercent = 0;
    if (Number.isFinite(video.duration) && video.duration > 0 && video.buffered.length) {
      loadedPercent = Math.min(100, (video.buffered.end(video.buffered.length - 1) / video.duration) * 100);
    }
    const nearEnd = Number.isFinite(video.duration) && video.duration - position < MIN_BUFFER_AHEAD_SECONDS;
    const hasPlayableBuffer = video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && (ahead >= MIN_BUFFER_AHEAD_SECONDS || nearEnd);
    const ready = navigator.onLine && !playbackBuffering && !video.seeking && !syncBlocked.value && !autoplayBlocked.value && document.visibilityState === "visible" && hasPlayableBuffer;

    return {
      mediaUrl: mediaUrl.value,
      position,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      ready,
      buffering: playbackBuffering,
      bufferedAhead: ahead,
      loadedPercent,
      paused: video.paused,
      sequence,
      sampledAt: estimatedServerTime(),
      syncRttMs: Number.isFinite(clockRtt) ? clockRtt : 10000,
    };
  }

  function networkTone(member) {
    const network = member?.network;
    if (!network || ["new", "connecting"].includes(network.connectionState)) return "checking";
    if (["disconnected", "failed", "closed"].includes(network.connectionState)) return "poor";
    if ((network.latencyMs ?? 0) >= 300 || (network.packetLoss ?? 0) >= 8) return "poor";
    if ((network.latencyMs ?? 0) >= 150 || (network.packetLoss ?? 0) >= 3) return "fair";
    return "good";
  }

  function networkLabel(member) {
    const network = member?.network;
    if (!network || network.latencyMs == null) return "检测中";
    if (["disconnected", "failed", "closed"].includes(network.connectionState)) return "连接异常";
    const pathLabel = network.path === "relay" ? "TURN" : network.path === "direct" ? "P2P" : "";
    return `${pathLabel ? `${pathLabel} · ` : ""}${network.latencyMs} ms`;
  }

  function playbackLabel(member) {
    const playback = member?.playback;
    if (!mediaUrl.value || !playback?.mediaUrl) return "等待片源";
    if (playback.mediaUrl !== mediaUrl.value) return "载入片源";
    if (playback.buffering || !playback.ready) {
      if (playback.loadedPercent > 0) return `缓冲 ${Math.round(playback.loadedPercent)}%`;
      if (playback.bufferedAhead > 0) return `缓冲 ${playback.bufferedAhead.toFixed(1)}s`;
      return "正在缓冲";
    }
    const percent = Math.round(playback.loadedPercent || 0);
    const ahead = Number(playback.bufferedAhead || 0).toFixed(1);
    return percent > 0 ? `缓存 ${percent}% · 可播 ${ahead}s` : `可播 ${ahead}s`;
  }

  function bufferMetric(member) {
    const playback = member?.playback;
    if (!playback || playback.mediaUrl !== mediaUrl.value) return "等待";
    const percent = Math.round(playback.loadedPercent || 0);
    if (percent > 0) return `${percent}%`;
    if (playback.bufferedAhead > 0) return `${playback.bufferedAhead.toFixed(1)}s`;
    return "载入中";
  }

  function bufferBarValue(member) {
    const playback = member?.playback;
    if (!playback || playback.mediaUrl !== mediaUrl.value) return 0;
    if (playback.loadedPercent > 0) return playback.loadedPercent;
    return Math.min(100, (playback.bufferedAhead / 30) * 100);
  }

  function publishMemberStatus(force = false) {
    if (!joined.value || !clientId.value) return;
    const status = { playback: createPlaybackStatus(), network: localNetwork };
    const member = members.get(clientId.value);
    if (member) {
      member.playback = status.playback;
      member.network = status.network;
    }
    const signature = JSON.stringify({
      ...status,
      playback: {
        ...status.playback,
        position: Math.round(status.playback.position * 2) / 2,
        bufferedAhead: Math.round(status.playback.bufferedAhead * 2) / 2,
        loadedPercent: Math.round(status.playback.loadedPercent),
      },
    });
    if (force || signature !== lastPublishedStatus) {
      lastPublishedStatus = signature;
      send({ type: "member-status", ...status });
    }
    if (isHost.value) evaluatePlaybackBarrier();
  }

  function showToast(message, duration = 1600) {
    toast.value = message;
    toastVisible.value = true;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastVisible.value = false;
    }, duration);
  }

  function updateConnectionStatus() {
    connected.value = socket?.readyState === WebSocket.OPEN;
    const p2pConnected = [...peers.values()].some((peer) => peer.reliable?.readyState === "open");
    connectionLabel.value = connected.value ? `已连接${p2pConnected ? " · P2P" : ""}` : "连接已断开";
  }

  function renderMessage(message) {
    if (messages.value.some((item) => item.id === message.id)) return;
    messages.value.push(message);
  }

  function isHlsMedia(url) {
    return String(url || "").split(/[?#]/)[0].toLowerCase().endsWith(".m3u8");
  }

  function destroyHls() {
    hls?.destroy();
    hls = null;
    qualityLevels.value = [];
    selectedQuality.value = -1;
    currentQuality.value = -1;
    qualityMode.value = "original";
    videoHeight.value = 0;
  }

  function updateQualityLevels(controller) {
    if (hls !== controller) return;
    qualityLevels.value = controller.levels.map((level, index) => {
      const bitrate = level.bitrate >= 1000000 ? `${(level.bitrate / 1000000).toFixed(1)} Mbps` : `${Math.round(level.bitrate / 1000)} kbps`;
      const duplicateHeight = level.height && controller.levels.filter((item) => item.height === level.height).length > 1;
      const label = level.height ? `${level.height}p${duplicateHeight ? ` · ${bitrate}` : ""}` : level.bitrate ? bitrate : `画质 ${index + 1}`;
      return { index, label, height: level.height || 0, bitrate: level.bitrate || 0, audioOnly: !level.videoCodec && Boolean(level.audioCodec) && !level.height };
    }).filter((level) => !level.audioOnly).sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);
    selectedQuality.value = controller.autoLevelEnabled ? -1 : controller.manualLevel;
  }

  function changeQuality(event) {
    const index = Number(event.target.value);
    if (!hls || !Number.isInteger(index) || (index !== -1 && !qualityLevels.value.some((level) => level.index === index))) return;
    selectedQuality.value = index;
    hls.nextLevel = index;
    showToast(index === -1 ? "已切换为自动画质" : `已选择 ${qualityLevels.value.find((level) => level.index === index).label}`);
  }

  async function loadVideoSource(video, url, skipCheck = false) {
    const generation = ++sourceGeneration;
    destroyHls();
    mediaLoadError.value = "";
    playbackBuffering = true;
    loadedMediaUrl = url;
    video.pause();
    video.removeAttribute("src");
    publishMemberStatus(true);

    if (isHlsMedia(url)) {
      try { if (!skipCheck) await checkMediaAvailability(url); }
      catch (cause) { if (generation === sourceGeneration && !disposed) failMedia(url, cause.message, cause.unavailable); return; }
      if (generation !== sourceGeneration || disposed) return;
      const canPlayNative = Boolean(video.canPlayType("application/vnd.apple.mpegurl"));
      const { default: Hls } = await import("hls.js");
      if (generation !== sourceGeneration || disposed || loadedMediaUrl !== url || mediaUrl.value !== url) return;
      if (Hls.isSupported()) {
        const controller = new Hls({ enableWorker: true, lowLatencyMode: true, backBufferLength: 90 });
        hls = controller;
        qualityMode.value = "hls";
        let mediaRecoveries = 0;
        let crossOriginNotified = false;
        controller.on(Hls.Events.FRAG_LOADED, () => { if (hls === controller) markMediaAvailable(url); });
        controller.on(Hls.Events.MANIFEST_PARSED, () => updateQualityLevels(controller));
        controller.on(Hls.Events.LEVELS_UPDATED, () => updateQualityLevels(controller));
        controller.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
          if (hls !== controller) return;
          currentQuality.value = data.level;
          selectedQuality.value = controller.autoLevelEnabled ? -1 : controller.manualLevel;
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (hls !== controller) return;
          const failedUrl = data.url || data.context?.url || data.frag?.url || url;
          const reason = describeHlsError(data, failedUrl, location.origin, navigator.onLine);
          if (!data.fatal) {
            if (!crossOriginNotified && ["cors", "cross-origin"].includes(reason.kind)) {
              crossOriginNotified = true;
              showToast(reason.message, 5000);
            }
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 1) {
            showToast("HLS 解码异常，正在恢复");
            hls?.recoverMediaError();
          } else {
            failMedia(url, reason.message, true);
          }
        });
        hls.loadSource(url);
        hls.attachMedia(video);
        return;
      }

      if (canPlayNative) {
        qualityMode.value = "native";
        video.src = url;
        video.load();
        return;
      }

      failMedia(url, "当前浏览器不支持 HLS 播放，请选择其他资源", true);
      return;
    }

    video.src = url;
    video.load();
  }

  function failMedia(url, message, unavailable = false) {
    if (url !== mediaUrl.value) return;
    if (unavailable && navigator.onLine) markMediaUnavailable(url);
    mediaLoadError.value = message;
    playbackBuffering = true;
    destroyHls();
    pauseForSafety(message);
    videoElement.value?.removeAttribute("src");
    videoElement.value?.load();
    publishMemberStatus(true);
    showToast(message);
  }

  function retryMedia() {
    const video = videoElement.value;
    if (!video || !mediaUrl.value) return;
    pauseForSafety("重新加载片源，等待全员同步");
    clearMediaFailure(mediaUrl.value);
    showToast("正在重新加载片源");
    loadVideoSource(video, mediaUrl.value, true);
  }

  function ensureMedia(url, title) {
    if (title) mediaTitle.value = title;
    if (!url) return;
    mediaUrl.value = url;
    const video = videoElement.value;
    if (video && loadedMediaUrl !== url) loadVideoSource(video, url);
  }

  function handleMediaError() {
    if (!mediaUrl.value || hls || mediaLoadError.value) return;
    if (isHlsMedia(mediaUrl.value)) {
      const type = videoElement.value?.error?.code === MediaError.MEDIA_ERR_NETWORK ? "networkError" : "mediaError";
      const reason = describeHlsError({ type }, mediaUrl.value, location.origin, navigator.onLine);
      return failMedia(mediaUrl.value, reason.message, true);
    }
    playbackBuffering = true;
    publishMemberStatus(true);
    showToast("视频加载失败，请检查格式、编码或跨域配置");
  }

  function handlePlaybackBuffering() {
    if (!mediaUrl.value || playbackBuffering) return;
    const video = videoElement.value;
    if (!video) return;
    playbackBuffering = true;
    if (!video.paused) pauseForSafety("正在缓冲，暂停等待全员");
    publishMemberStatus(true);
  }

  function handlePlaybackReady() {
    const video = videoElement.value;
    if (!video) return;
    const ahead = bufferedAhead(video);
    const nearEnd = Number.isFinite(video.duration) && video.duration - video.currentTime < MIN_BUFFER_AHEAD_SECONDS;
    if (video.seeking || video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA || (ahead < MIN_BUFFER_AHEAD_SECONDS && !nearEnd)) return;
    const wasBuffering = playbackBuffering;
    playbackBuffering = false;
    publishMemberStatus(wasBuffering);
  }

  function waitForMetadata() {
    const video = videoElement.value;
    if (!video || video.readyState >= 1) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        video.removeEventListener("loadedmetadata", done);
        video.removeEventListener("error", done);
        resolve();
      };
      const timer = setTimeout(done, 8000);
      video.addEventListener("loadedmetadata", done, { once: true });
      video.addEventListener("error", done, { once: true });
    });
  }

  function clearScheduledCommands() {
    for (const timer of scheduledCommands) clearTimeout(timer);
    scheduledCommands.clear();
  }

  async function executeCommand(command) {
    const generation = playbackGeneration;
    if (command.paused) videoElement.value?.pause();
    ensureMedia(command.mediaUrl, command.mediaTitle);
    await nextTick();
    if (!command.mediaUrl || !videoElement.value) return;
    ensureMedia(command.mediaUrl, command.mediaTitle);
    const video = videoElement.value;
    await waitForMetadata();
    if (generation !== playbackGeneration || videoElement.value !== video || mediaUrl.value !== command.mediaUrl || command.sequence !== sequence) return;
    applyingRemote = true;
    smoothedDrift = null;
    video.playbackRate = 1;
    const elapsed = Math.max(0, (estimatedServerTime() - command.executeAt) / 1000);
    const requestedPosition = Math.max(0, command.position + (command.paused ? 0 : elapsed));
    const targetPosition = Number.isFinite(video.duration) ? Math.min(video.duration, requestedPosition) : requestedPosition;
    const seekTolerance = Math.max(0.08, Number(command.seekTolerance) || 0.08);
    if (Number.isFinite(targetPosition) && Math.abs(video.currentTime - targetPosition) > seekTolerance) {
      video.currentTime = targetPosition;
    }

    try {
      if (command.paused) video.pause();
      else {
        if (!syncFresh() || syncBlocked.value || autoplayBlocked.value || document.visibilityState !== "visible") { pauseForSafety("等待同步确认"); return; }
        await video.play();
        if (generation !== playbackGeneration || command.sequence !== sequence || !syncFresh()) video.pause();
      }
    } catch (error) {
      if (generation !== playbackGeneration || command.sequence !== sequence) return;
      if (error.name === "NotAllowedError") autoplayBlocked.value = true;
      else playbackBuffering = true;
      pauseForSafety(autoplayBlocked.value ? "浏览器需要点击画面后才能播放" : "等待视频恢复缓冲");
    } finally {
      applyingRemote = false;
      updatePlayerState();
      publishMemberStatus(true);
    }
  }

  function applyCommand(command, source = "ws") {
    if (!command || command.sequence <= sequence || pendingCommands.has(command.id)) return;
    sequence = command.sequence;
    if (Number.isInteger(command.playlistIndex)) playlistIndex.value = command.playlistIndex;
    if (command.mediaPoster !== undefined) mediaPoster.value = command.mediaPoster;
    else if (playlist.value[playlistIndex.value]?.poster) mediaPoster.value = playlist.value[playlistIndex.value].poster;
    if (typeof command.autoAdvance === "boolean") autoAdvance.value = command.autoAdvance;
    if (command.lineLabel) lineLabel.value = command.lineLabel;
    pendingCommands.add(command.id);
    if (pendingCommands.size > 50) pendingCommands.delete(pendingCommands.values().next().value);

    clearScheduledCommands();
    ensureMedia(command.mediaUrl, command.mediaTitle);
    const delay = Math.max(0, localTimeFromServer(command.executeAt) - Date.now());
    const timer = setTimeout(() => {
      scheduledCommands.delete(timer);
      executeCommand(command);
    }, delay);
    scheduledCommands.add(timer);
    if (source === "rtc") showToast("已通过低延迟通道同步");
  }

  function createCommand({ paused, position, url = mediaUrl.value, title = mediaTitle.value, index = playlistIndex.value }, delayMs = COMMAND_DELAY_MS) {
    return {
      id: crypto.randomUUID(),
      sequence: sequence + 1,
      paused,
      position: Math.max(0, position),
      executeAt: estimatedServerTime() + delayMs,
      mediaUrl: url,
      mediaTitle: title,
      playlistIndex: playlist.value[index]?.url === url ? index : -1,
      autoAdvance: autoAdvance.value,
    };
  }

  function broadcastData(payload, channelName = "reliable") {
    const encoded = JSON.stringify(payload);
    for (const peer of peers.values()) {
      const channel = peer[channelName];
      if (channel?.readyState === "open") channel.send(encoded);
    }
  }

  function publishCommand(command) {
    send({ type: "sync-command", command });
  }

  function memberReadyForBarrier(member, barrier) {
    const playback = member.playback;
    return playback?.mediaUrl === barrier.mediaUrl
      && playback.ready
      && !playback.buffering
      && playback.paused
      && playback.sequence === sequence
      && estimatedServerTime() - playback.sampledAt <= MAX_SYNC_DELAY_MS
      && playback.syncRttMs <= MAX_SYNC_DELAY_MS
      && Math.abs(playback.position - barrier.position) < ALIGN_TOLERANCE_SECONDS;
  }

  function evaluatePlaybackBarrier() {
    if (!isHost.value || !pendingPlaybackBarrier) return;
    if (sequence < pendingPlaybackBarrier.sequence) return;
    const memberValues = [...members.values()];
    if (!memberValues.length || !memberValues.every((member) => memberReadyForBarrier(member, pendingPlaybackBarrier))) return;

    const barrier = pendingPlaybackBarrier;
    pendingPlaybackBarrier = null;
    waitingForPeers.value = false;
    const maxLatency = Math.max(0, ...memberValues.map((member) => member.network?.latencyMs || 0));
    const delay = Math.max(COMMAND_DELAY_MS, Math.min(500, maxLatency * 2 + 200));
    publishCommand(createCommand({
      paused: false,
      position: barrier.position,
      url: barrier.mediaUrl,
      title: barrier.mediaTitle,
    }, delay));
    showToast(`全员已就绪，${Math.round(delay)}ms 后播放`);
  }

  function beginPlaybackBarrier(position, reason = "等待缓冲") {
    if (!isHost.value || !mediaUrl.value || pendingPlaybackBarrier) return;
    pendingPlaybackBarrier = {
      id: crypto.randomUUID(),
      sequence: sequence + 1,
      position: Math.max(0, position),
      mediaUrl: mediaUrl.value,
      mediaTitle: mediaTitle.value,
    };
    waitingForPeers.value = true;
    publishCommand(createCommand({ paused: true, position: pendingPlaybackBarrier.position }));
    publishMemberStatus(true);
    showToast(`${reason}，已暂停等待全员`);
  }

  function cancelPlaybackBarrier() {
    pendingPlaybackBarrier = null;
    waitingForPeers.value = false;
  }

  function updatePlayerState() {
    const video = videoElement.value;
    if (!video) return;
    currentTime.value = video.currentTime || 0;
    duration.value = Number.isFinite(video.duration) ? video.duration : 0;
    playerPaused.value = video.paused;
    videoHeight.value = video.videoHeight || 0;
  }

  function togglePlay() {
    const video = videoElement.value;
    if (!canControl.value || !video) return;
    syncPauseReason.value = "";
    const position = video.ended ? 0 : video.currentTime;
    if (!video.paused) {
      cancelPlaybackBarrier();
      publishCommand(createCommand({ paused: true, position }));
      return;
    }
    if (pendingPlaybackBarrier) {
      showToast("正在等待所有成员缓冲");
      return;
    }
    beginPlaybackBarrier(position);
  }

  function syncFresh() {
    return navigator.onLine && socket?.readyState === WebSocket.OPEN && authorityState && estimatedServerTime() < authorityState.validUntil && performance.now() - lastAuthorityAt < SYNC_LEASE_MS;
  }

  function pauseForSafety(reason) {
    if (!joined.value || !mediaUrl.value) return;
    const video = videoElement.value;
    video?.pause();
    if (syncBlocked.value) return;
    syncBlocked.value = true;
    waitingForPeers.value = true;
    playbackGeneration += 1;
    clearScheduledCommands();
    send({ type: "sync-hold" });
    publishMemberStatus(true);
    showToast(reason);
  }

  function allowPlayback() {
    autoplayBlocked.value = false;
    publishMemberStatus(true);
  }

  function visibilityChanged() {
    if ((!navigator.onLine || document.visibilityState !== "visible") && joined.value && mediaUrl.value && (!videoElement.value?.paused || authorityState?.paused === false)) pauseForSafety("页面进入后台或断网，已暂停同步播放");
    else publishMemberStatus(true);
  }

  function seek(event) {
    if (!isHost.value || !videoElement.value) return;
    const video = videoElement.value;
    const position = Number(event.target.value);
    const paused = video.paused;
    seekPreview.value = null;
    video.pause();
    if (paused) publishCommand(createCommand({ paused: true, position }));
    else beginPlaybackBarrier(position, "正在同步新进度");
  }

  function previewSeek(event) {
    if (!isHost.value) return;
    seekPreview.value = Number(event.target.value);
  }

  function changeVolume(event) {
    const value = Number(event.target.value);
    volume.value = value;
    if (!videoElement.value) return;
    videoElement.value.volume = value;
    videoElement.value.muted = value === 0;
    videoMuted.value = videoElement.value.muted;
  }

  function toggleVideoMute() {
    if (!videoElement.value) return;
    videoElement.value.muted = !videoElement.value.muted;
    videoMuted.value = videoElement.value.muted;
  }

  async function enterFullscreen() {
    try {
      if (videoFrame.value?.requestFullscreen) {
        await videoFrame.value.requestFullscreen();
        return;
      }
      if (videoElement.value?.webkitEnterFullscreen) {
        videoElement.value.webkitEnterFullscreen();
        return;
      }
      videoElement.value?.webkitRequestFullscreen?.();
    } catch {
      videoElement.value?.webkitEnterFullscreen?.();
    }
  }

  async function loadMedia(url, title) {
    if (!isHost.value) return;
    const room = roomId.value;
    try { await checkMediaAvailability(url); } catch (cause) { showToast(cause.message); return; }
    if (!isHost.value || roomId.value !== room || disposed) return;
    cancelPlaybackBarrier();
    playlist.value = [];
    playlistTitle.value = "";
    playlistIndex.value = -1;
    mediaPoster.value = "";
    publishCommand(createCommand({ paused: true, position: 0, url, title, index: -1 }));
  }

  async function selectPlaylistItem(index, autoplay = false) {
    const item = playlist.value[index];
    if (!isHost.value || !item) return;
    const room = roomId.value;
    try { await checkMediaAvailability(item.url); } catch (cause) { showToast(cause.message); return; }
    if (!isHost.value || roomId.value !== room || playlist.value[index] !== item || disposed) return;
    cancelPlaybackBarrier();
    playlistIndex.value = index;
    if (autoplay) {
      pendingPlaybackBarrier = { id: crypto.randomUUID(), sequence: sequence + 1, position: 0, mediaUrl: item.url, mediaTitle: item.title };
      waitingForPeers.value = true;
    }
    publishCommand(createCommand({ paused: true, position: 0, url: item.url, title: item.title, index }));
    showToast(`已切换到第 ${index + 1} 集`);
  }

  function handlePlaybackEnded() {
    if (!isHost.value || lastEndedSequence === sequence) return;
    lastEndedSequence = sequence;
    if (isHost.value && autoAdvance.value && playlistIndex.value + 1 < playlist.value.length) {
      selectPlaylistItem(playlistIndex.value + 1, true);
    } else {
      cancelPlaybackBarrier();
      const duration = videoElement.value?.duration;
      publishCommand(createCommand({ paused: true, position: Number.isFinite(duration) ? duration : currentTime.value }));
    }
  }

  function changeAutoAdvance() {
    if (!isHost.value) return;
    publishCommand(createCommand({ paused: playerPaused.value, position: currentTime.value }));
  }

  function requestLines() {
    if (!connected.value) return showToast("连接已断开，请重新进入房间");
    linesLoading.value = true;
    availableLines.value = [];
    lineRequestVersion += 1;
    send({ type: "request-lines" });
  }

  async function switchLine(line) {
    if (!isHost.value) return;
    const room = roomId.value;
    try { await checkMediaAvailability(line.url); } catch (cause) { showToast(cause.message); return; }
    if (!isHost.value || roomId.value !== room || disposed) return;
    cancelPlaybackBarrier();
    send({ type: "switch-line", id: line.id, position: videoElement.value?.currentTime || currentTime.value });
    showToast("正在切换线路，将保留观看进度");
  }

  function reconcilePlayback(heartbeat) {
    const video = videoElement.value;
    if (!mediaUrl.value || applyingRemote || !video || heartbeat.sequence !== sequence || heartbeat.mediaUrl !== mediaUrl.value) return;
    if (heartbeat.serverTime <= lastHeartbeatServerTime) return;
    lastHeartbeatServerTime = heartbeat.serverTime;

    if (estimatedServerTime() < heartbeat.executeAt) return;
    if (!heartbeat.paused && (syncBlocked.value || !syncFresh() || playbackBuffering || autoplayBlocked.value)) { video.pause(); return; }
    if (heartbeat.paused !== video.paused) {
      smoothedDrift = null;
      executeCommand(heartbeat);
      return;
    }
    if (heartbeat.paused || playbackBuffering) {
      smoothedDrift = null;
      video.playbackRate = 1;
      if (heartbeat.paused && video.readyState >= 1 && !video.seeking && Math.abs(video.currentTime - heartbeat.position) > 0.08) video.currentTime = heartbeat.position;
      if (heartbeat.paused && Number.isFinite(video.duration) && heartbeat.position >= video.duration - 0.01 && autoAdvance.value && playlistIndex.value + 1 < playlist.value.length) handlePlaybackEnded();
      return;
    }

    const elapsed = Math.max(0, (estimatedServerTime() - heartbeat.serverTime) / 1000);
    const expected = heartbeat.position + (heartbeat.paused ? 0 : elapsed);
    const drift = expected - video.currentTime;
    smoothedDrift = smoothedDrift == null ? drift : smoothedDrift * 0.65 + drift * 0.35;
    const absoluteDrift = Math.abs(drift);

    if (absoluteDrift > MAX_DRIFT_SECONDS) {
      pauseForSafety("播放偏差较大，暂停对齐进度");
      video.currentTime = expected;
      video.playbackRate = 1;
      smoothedDrift = null;
      showToast(`已校准 ${Math.round(absoluteDrift * 1000)}ms`);
    } else if (absoluteDrift > 0.08 && !heartbeat.paused) {
      const adjustment = Math.min(0.025, Math.max(0.005, absoluteDrift * 0.04));
      video.playbackRate = smoothedDrift > 0 ? 1 + adjustment : 1 - adjustment;
    } else {
      video.playbackRate = 1;
    }
  }

  function handleDataMessage(peerId, event) {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    const peer = peers.get(peerId);
    if (payload.type === "p2p-ping") {
      if (peer?.reliable?.readyState === "open") {
        peer.reliable.send(JSON.stringify({ type: "p2p-pong", requestId: payload.requestId, sentAt: payload.sentAt }));
      }
      return;
    }
    if (payload.type === "p2p-pong") {
      if (peer) {
        peer.latencyMs = Math.max(0, Date.now() - Number(payload.sentAt));
        peer.lastPongAt = Date.now();
        refreshLocalNetwork();
        publishMemberStatus();
      }
      return;
    }
    if (payload.type === "typing") handleTyping(payload);
  }

  function registerChannel(peer, channel) {
    const key = channel.label === "sync-state" ? "state" : "reliable";
    peer[key] = channel;
    channel.addEventListener("message", (event) => handleDataMessage(peer.id, event));
    channel.addEventListener("open", () => {
      updateConnectionStatus();
      measurePeerLatency(peer);
    });
    channel.addEventListener("close", () => {
      updateConnectionStatus();
      refreshLocalNetwork();
      publishMemberStatus(true);
    });
  }

  function measurePeerLatency(peer) {
    if (peer.reliable?.readyState !== "open") return;
    peer.lastPingAt = Date.now();
    try {
      peer.reliable.send(JSON.stringify({ type: "p2p-ping", requestId: crypto.randomUUID(), sentAt: peer.lastPingAt }));
    } catch {
      peer.latencyMs = null;
    }
  }

  async function samplePeerPacketLoss(peer) {
    try {
      const reports = await peer.connection.getStats();
      let received = 0;
      let lost = 0;
      let selectedPair = null;
      reports.forEach((report) => {
        if (report.type === "transport" && report.selectedCandidatePairId) {
          selectedPair = reports.get(report.selectedCandidatePairId) || selectedPair;
        }
        if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) {
          selectedPair = selectedPair || report;
        }
        if (report.type !== "inbound-rtp" || report.kind !== "audio" || report.isRemote) return;
        received += report.packetsReceived || 0;
        lost += report.packetsLost || 0;
      });
      peer.packetLoss = received + lost > 0 ? (lost / (received + lost)) * 100 : null;
      if (selectedPair) {
        const localCandidate = reports.get(selectedPair.localCandidateId);
        const remoteCandidate = reports.get(selectedPair.remoteCandidateId);
        peer.path = [localCandidate?.candidateType, remoteCandidate?.candidateType].includes("relay")
          ? "relay"
          : "direct";
      }
    } catch {
      peer.packetLoss = null;
    }
  }

  function refreshLocalNetwork() {
    const peerValues = [...peers.values()];
    if (!peerValues.length) {
      localNetwork = { latencyMs: null, packetLoss: null, connectionState: "new", path: "checking" };
      return;
    }

    const now = Date.now();
    const states = peerValues.map((peer) => {
      if (peer.lastPingAt && now - peer.lastPongAt > 6000) return "disconnected";
      return peer.connection.connectionState;
    });
    const connectionState = states.includes("failed")
      ? "failed"
      : states.includes("disconnected")
        ? "disconnected"
        : states.every((state) => state === "connected")
          ? "connected"
          : "connecting";
    const latencies = peerValues.map((peer) => peer.latencyMs).filter(Number.isFinite);
    const losses = peerValues.map((peer) => peer.packetLoss).filter(Number.isFinite);
    const paths = peerValues.map((peer) => peer.path);
    localNetwork = {
      latencyMs: latencies.length ? Math.round(Math.max(...latencies)) : null,
      packetLoss: losses.length ? Math.max(...losses) : null,
      connectionState,
      path: paths.includes("relay") ? "relay" : paths.includes("direct") ? "direct" : "checking",
    };
  }

  async function updateNetworkStats() {
    const peerValues = [...peers.values()];
    for (const peer of peerValues) measurePeerLatency(peer);
    await Promise.allSettled(peerValues.map(samplePeerPacketLoss));
    refreshLocalNetwork();
    publishMemberStatus(true);
  }

  function addLocalVoiceTracks(peer) {
    if (!localVoiceStream) return;
    const senderTrackIds = new Set(peer.connection.getSenders().map((sender) => sender.track?.id));
    for (const track of localVoiceStream.getAudioTracks()) {
      if (!senderTrackIds.has(track.id)) peer.connection.addTrack(track, localVoiceStream);
    }
  }

  function attachRemoteVoice(peerId, stream) {
    let audio = remoteAudios.get(peerId);
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.playsInline = true;
      audio.dataset.peerId = peerId;
      remoteAudioContainer.value?.append(audio);
      remoteAudios.set(peerId, audio);
    }
    audio.srcObject = stream;
    audio.muted = !voiceJoined.value;
    if (voiceJoined.value) audio.play().catch(() => {
      voiceError.value = "点击页面后恢复语音";
    });
  }

  function removeRemoteVoice(peerId) {
    const audio = remoteAudios.get(peerId);
    if (!audio) return;
    audio.srcObject = null;
    audio.remove();
    remoteAudios.delete(peerId);
  }

  async function sendLocalDescription(peer) {
    try {
      peer.makingOffer = true;
      await peer.connection.setLocalDescription();
      send({ type: "signal", target: peer.id, data: { description: peer.connection.localDescription } });
    } catch (error) {
      console.warn("WebRTC negotiation failed", error);
    } finally {
      peer.makingOffer = false;
    }
  }

  function createPeer(peerId, initiator = false) {
    if (peers.has(peerId)) return peers.get(peerId);
    const connection = new RTCPeerConnection({ iceServers });
    const peer = {
      id: peerId,
      connection,
      reliable: null,
      state: null,
      pendingCandidates: [],
      latencyMs: null,
      packetLoss: null,
      path: "checking",
      lastPingAt: 0,
      lastPongAt: Date.now(),
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      polite: String(clientId.value) > String(peerId),
    };
    peers.set(peerId, peer);

    connection.addEventListener("icecandidate", ({ candidate }) => {
      if (candidate) send({ type: "signal", target: peerId, data: { candidate } });
    });
    connection.addEventListener("negotiationneeded", () => sendLocalDescription(peer));
    connection.addEventListener("track", (event) => {
      attachRemoteVoice(peerId, event.streams[0] || new MediaStream([event.track]));
    });
    connection.addEventListener("datachannel", ({ channel }) => registerChannel(peer, channel));
    connection.addEventListener("connectionstatechange", () => {
      updateConnectionStatus();
      refreshLocalNetwork();
      publishMemberStatus(true);
      if (connection.connectionState === "failed") showToast(`${members.get(peerId)?.name || "对方"}的 P2P 连接异常`);
      if (connection.connectionState === "closed" && peers.has(peerId)) closePeer(peerId);
    });

    addLocalVoiceTracks(peer);
    if (initiator) {
      registerChannel(peer, connection.createDataChannel("sync-reliable", { ordered: true }));
      registerChannel(peer, connection.createDataChannel("sync-state", { ordered: false, maxRetransmits: 0 }));
    }
    return peer;
  }

  function closePeer(peerId) {
    const peer = peers.get(peerId);
    if (!peer) return;
    peer.connection.close();
    peers.delete(peerId);
    removeRemoteVoice(peerId);
    updateConnectionStatus();
    refreshLocalNetwork();
    publishMemberStatus(true);
  }

  async function handleSignal(message) {
    const peer = createPeer(message.from, false);
    const { description, candidate } = message.data;
    try {
      if (description) {
        const readyForOffer = !peer.makingOffer
          && (peer.connection.signalingState === "stable" || peer.settingRemoteAnswer);
        const offerCollision = description.type === "offer" && !readyForOffer;
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;

        peer.settingRemoteAnswer = description.type === "answer";
        await peer.connection.setRemoteDescription(description);
        peer.settingRemoteAnswer = false;
        for (const pendingCandidate of peer.pendingCandidates.splice(0)) {
          await peer.connection.addIceCandidate(pendingCandidate);
        }
        if (description.type === "offer") {
          await peer.connection.setLocalDescription();
          send({ type: "signal", target: message.from, data: { description: peer.connection.localDescription } });
        }
      } else if (candidate) {
        if (peer.connection.remoteDescription) await peer.connection.addIceCandidate(candidate);
        else peer.pendingCandidates.push(candidate);
      }
    } catch (error) {
      peer.settingRemoteAnswer = false;
      if (peer.ignoreOffer && candidate) return;
      console.warn("WebRTC signaling failed", error);
    }
  }

  function updateMemberVoice(peerId, enabled, muted) {
    const member = members.get(peerId);
    if (!member) return;
    member.voiceEnabled = enabled;
    member.voiceMuted = enabled && muted;
    if (!enabled && peerId !== clientId.value) removeRemoteVoice(peerId);
  }

  function publishVoiceState(enabled, muted) {
    updateMemberVoice(clientId.value, enabled, muted);
    send({ type: "voice-state", enabled, muted });
  }

  async function loadRnnoiseResources() {
    if (!rnnoiseResourcesPromise) {
      rnnoiseResourcesPromise = Promise.all([
        import("@sapphi-red/web-noise-suppressor"),
        import("@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url"),
        import("@sapphi-red/web-noise-suppressor/rnnoise.wasm?url"),
        import("@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url"),
      ]).then(async ([library, worklet, wasm, simdWasm]) => ({
        RnnoiseWorkletNode: library.RnnoiseWorkletNode,
        wasmBinary: await library.loadRnnoise({ url: wasm.default, simdUrl: simdWasm.default }),
        workletUrl: worklet.default,
      }));
      rnnoiseResourcesPromise.catch(() => {
        rnnoiseResourcesPromise = null;
      });
    }
    return rnnoiseResourcesPromise;
  }

  function destroyVoicePipeline(pipeline) {
    if (!pipeline) return;
    pipeline.suppressor?.destroy();
    pipeline.source.disconnect();
    pipeline.suppressor?.disconnect();
    pipeline.gain.disconnect();
    pipeline.stream.getTracks().forEach((track) => track.stop());
    pipeline.context.close().catch(() => {});
  }

  async function createVoicePipeline(stream, useNoiseSuppression) {
    const context = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
    const source = context.createMediaStreamSource(stream);
    const gain = context.createGain();
    const destination = context.createMediaStreamDestination();
    const pipeline = { context, source, suppressor: null, gain, destination, stream: destination.stream };

    try {
      await context.resume();
      let output = source;
      if (useNoiseSuppression) {
        const resources = await loadRnnoiseResources();
        await context.audioWorklet.addModule(resources.workletUrl);
        pipeline.suppressor = new resources.RnnoiseWorkletNode(context, {
          maxChannels: 1,
          wasmBinary: resources.wasmBinary,
        });
        source.connect(pipeline.suppressor);
        output = pipeline.suppressor;
      }
      output.connect(gain);
      gain.connect(destination);
      gain.gain.value = microphoneGain.value / 100;
      return pipeline;
    } catch (error) {
      destroyVoicePipeline(pipeline);
      throw error;
    }
  }

  async function configureRawVoiceTrack() {
    const track = rawVoiceStream?.getAudioTracks()[0];
    if (!track) return;
    await track.applyConstraints({
      autoGainControl: false,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: false,
      sampleRate: 48000,
    }).catch(() => {});
  }

  async function rebuildVoicePipeline() {
    if (!rawVoiceStream) return;
    voiceProcessing.value = true;
    const previousPipeline = voicePipeline;
    const previousTrack = localVoiceStream?.getAudioTracks()[0] || null;
    let nextPipeline;

    try {
      await configureRawVoiceTrack();
      try {
        nextPipeline = await createVoicePipeline(rawVoiceStream, noiseSuppressionEnabled.value);
      } catch (error) {
        if (!noiseSuppressionEnabled.value) throw error;
        noiseSuppressionEnabled.value = false;
        localStorage.setItem("watch-noise-suppression", "false");
        await configureRawVoiceTrack();
        nextPipeline = await createVoicePipeline(rawVoiceStream, false);
        showToast("RNNoise 不可用，麦克风降噪已关闭");
      }

      const nextTrack = nextPipeline.stream.getAudioTracks()[0];
      nextTrack.enabled = !voiceMuted.value;
      const replacements = [];
      for (const peer of peers.values()) {
        const sender = peer.connection.getSenders().find((item) => item.track === previousTrack || item.track?.kind === "audio");
        if (sender) replacements.push(sender.replaceTrack(nextTrack));
        else peer.connection.addTrack(nextTrack, nextPipeline.stream);
      }
      await Promise.allSettled(replacements);

      voicePipeline = nextPipeline;
      localVoiceStream = nextPipeline.stream;
      destroyVoicePipeline(previousPipeline);
    } finally {
      voiceProcessing.value = false;
    }
  }

  function stopVoiceCapture() {
    destroyVoicePipeline(voicePipeline);
    voicePipeline = null;
    localVoiceStream = null;
    rawVoiceStream?.getTracks().forEach((track) => track.stop());
    rawVoiceStream = null;
  }

  async function joinVoice() {
    if (voiceStarting.value || voiceJoined.value) return;
    voiceStarting.value = true;
    voiceError.value = "";
    try {
      rawVoiceStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          autoGainControl: false,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: false,
          sampleRate: 48000,
        },
      });
      await rebuildVoicePipeline();
      voiceJoined.value = true;
      voiceMuted.value = false;
      for (const peer of peers.values()) addLocalVoiceTracks(peer);
      for (const audio of remoteAudios.values()) {
        audio.muted = false;
        audio.play().catch(() => {});
      }
      publishVoiceState(true, false);
    } catch (error) {
      stopVoiceCapture();
      voiceError.value = error.name === "NotAllowedError" ? "麦克风权限被拒绝" : "无法启动麦克风";
    } finally {
      voiceStarting.value = false;
    }
  }

  function leaveVoice() {
    if (!voiceJoined.value) return;
    const tracks = localVoiceStream?.getTracks() || [];
    for (const peer of peers.values()) {
      for (const sender of peer.connection.getSenders()) {
        if (sender.track && tracks.includes(sender.track)) peer.connection.removeTrack(sender);
      }
    }
    tracks.forEach((track) => track.stop());
    stopVoiceCapture();
    voiceJoined.value = false;
    voiceMuted.value = false;
    voiceError.value = "";
    for (const audio of remoteAudios.values()) audio.muted = true;
    publishVoiceState(false, false);
  }

  function toggleVoice() {
    if (voiceJoined.value) leaveVoice();
    else joinVoice();
  }

  function toggleMicrophone(event) {
    const enabled = event.target.checked;
    for (const track of localVoiceStream?.getAudioTracks() || []) track.enabled = enabled;
    voiceMuted.value = !enabled;
    publishVoiceState(true, !enabled);
  }

  function changeMicrophoneGain(event) {
    const requestedValue = Number(event.target.value);
    const value = Number.isFinite(requestedValue) ? Math.min(250, Math.max(0, requestedValue)) : 100;
    microphoneGain.value = value;
    localStorage.setItem("watch-mic-gain", String(value));
    const gain = voicePipeline?.gain.gain;
    if (gain) gain.setTargetAtTime(value / 100, voicePipeline.context.currentTime, 0.02);
  }

  async function toggleNoiseSuppression(event) {
    if (voiceProcessing.value) return;
    const previous = noiseSuppressionEnabled.value;
    noiseSuppressionEnabled.value = event.target.checked;
    localStorage.setItem("watch-noise-suppression", String(noiseSuppressionEnabled.value));
    if (!voiceJoined.value) return;

    try {
      await rebuildVoicePipeline();
      showToast(noiseSuppressionEnabled.value ? "麦克风降噪已开启" : "麦克风降噪已关闭");
    } catch {
      noiseSuppressionEnabled.value = previous;
      localStorage.setItem("watch-noise-suppression", String(previous));
      await configureRawVoiceTrack();
      showToast("麦克风设置更新失败");
    }
  }

  function handleTyping(payload) {
    if (payload.peerId === clientId.value) return;
    if (payload.active) {
      typingPeers.set(payload.peerId, payload.name || members.get(payload.peerId)?.name || "有人");
      clearTimeout(typingTimers.get(payload.peerId));
      typingTimers.set(payload.peerId, setTimeout(() => typingPeers.delete(payload.peerId), 2200));
    } else {
      typingPeers.delete(payload.peerId);
    }
  }

  function clockPing() {
    const clientSentAt = Date.now();
    send({ type: "clock-ping", requestId: crypto.randomUUID(), clientSentAt });
  }

  function handleMemberStatus(message) {
    const member = members.get(message.peerId);
    if (!member) return;
    member.playback = message.playback;
    member.network = message.network;

    const video = videoElement.value;
    if (isHost.value
      && video
      && !video.paused
      && message.playback?.mediaUrl === mediaUrl.value
      && (message.playback.buffering || !message.playback.ready)) {
      beginPlaybackBarrier(video.currentTime, `${member.name}正在缓冲`);
    }
    evaluatePlaybackBarrier();
  }

  function resetRoom(reason) {
    sourceGeneration += 1;
    lineRequestVersion += 1;
    mediaLoadError.value = "";
    playbackGeneration += 1;
    showToast(reason || "房间已由管理员关闭");
    clearScheduledCommands();
    cancelPlaybackBarrier();
    pendingCommands.clear();
    sequence = -1;
    lastHeartbeatServerTime = 0;
    lastEndedSequence = -1;
    authorityState = null;
    syncBlocked.value = false;
    autoplayBlocked.value = false;
    syncPauseReason.value = "";
    smoothedDrift = null;
    destroyHls();
    loadedMediaUrl = "";
    videoElement.value?.pause();
    videoElement.value?.removeAttribute("src");
    videoElement.value?.load();
    leaveVoice();
    for (const peerId of [...peers.keys()]) closePeer(peerId);
    members.clear();
    messages.value = [];
    typingPeers.clear();
    for (const timer of typingTimers.values()) clearTimeout(timer);
    typingTimers.clear();
    mediaUrl.value = "";
    mediaTitle.value = "尚未添加视频";
    mediaPoster.value = "";
    playlist.value = [];
    playlistTitle.value = "";
    playlistIndex.value = -1;
    currentTime.value = 0;
    duration.value = 0;
    seekPreview.value = null;
    playerPaused.value = true;
    applyingRemote = false;
    clientId.value = null;
    hostId.value = null;
    roomId.value = null;
    joined.value = false;
    joinRoomId.value = "";
    history.replaceState(null, "", location.pathname);
    socket?.close();
  }

  function handleSocketMessage(event) {
    const message = JSON.parse(event.data);
    if (message.type === "account-logout") { accountSignedOut.value = true; resetRoom("账户已退出"); return; }
    if (message.type === "join-error") {
      joining.value = false;
      resetRoom(message.error);
      if (message.code === 401) requiresLogin.value = true;
      return;
    }
    if (message.type === "room-closed") { resetRoom(message.error); return; }
    if (message.type === "clock-pong") {
      const receivedAt = Date.now();
      const rtt = receivedAt - message.clientSentAt;
      clockRtt = rtt;
      if (rtt < bestClockRtt) {
        bestClockRtt = rtt;
        serverOffset = message.serverAt - (message.clientSentAt + rtt / 2);
      }
      return;
    }

    if (message.type === "sync-state") {
      const state = message.state;
      if (state.sequence < sequence) return;
      authorityState = state;
      lastAuthorityAt = performance.now();
      hostId.value = message.hostId;
      if (state.paused && syncFresh() && document.visibilityState === "visible") syncBlocked.value = false;
      if (state.syncWaiting && isHost.value && !pendingPlaybackBarrier) {
        pendingPlaybackBarrier = { sequence: state.sequence, position: state.position, mediaUrl: state.mediaUrl, mediaTitle: state.mediaTitle };
      }
      waitingForPeers.value = Boolean(state.syncWaiting || syncBlocked.value || pendingPlaybackBarrier);
      if (!state.paused) syncPauseReason.value = "";
      if (state.sequence > sequence) applyCommand({ id: `state-${state.sequence}`, ...state });
      else reconcilePlayback(state);
      return;
    }

    if (message.type === "joined") {
      playbackGeneration += 1;
      authorityState = null;
      bestClockRtt = Infinity;
      clockRtt = Infinity;
      lastHeartbeatServerTime = 0;
      lastEndedSequence = -1;
      syncPauseReason.value = "";
      clearScheduledCommands();
      pendingCommands.clear();
      for (const peerId of [...peers.keys()]) closePeer(peerId);
      joining.value = false;
      if (Array.isArray(message.iceServers) && message.iceServers.length) iceServers = message.iceServers;
      clientId.value = message.clientId;
      hostId.value = message.hostId;
      roomId.value = message.roomId;
      sequence = message.state.sequence - 1;
      members.clear();
      message.members.forEach((member) => members.set(member.id, member));
      messages.value = [...message.messages];
      playlist.value = message.playlist || [];
      playlistTitle.value = message.playlistTitle || "";
      mediaPoster.value = message.mediaPoster || "";
      availableLines.value = [];
      linesLoading.value = false;
      lineLabel.value = message.state.lineLabel || "默认线路";
      joined.value = true;
      history.replaceState(null, "", `?room=${roomId.value}`);
      applyCommand({ id: `initial-${message.state.sequence}`, ...message.state, executeAt: message.state.serverTime });
      clockPing();
      publishMemberStatus(true);
      if (voiceJoined.value) publishVoiceState(true, voiceMuted.value);
      return;
    }

    if (message.type === "peer-joined") {
      if (Array.isArray(message.iceServers) && message.iceServers.length) iceServers = message.iceServers;
      members.set(message.peer.id, message.peer);
      createPeer(message.peer.id, true);
      return;
    }
    if (message.type === "peer-left") {
      members.delete(message.peerId);
      typingPeers.delete(message.peerId);
      closePeer(message.peerId);
      evaluatePlaybackBarrier();
      return;
    }
    if (message.type === "host-changed") {
      playbackGeneration += 1;
      hostId.value = message.hostId;
      cancelPlaybackBarrier();
      if (message.state) {
        sequence = message.state.sequence;
        clearScheduledCommands();
        executeCommand({
          id: `host-change-${message.state.sequence}`,
          ...message.state,
          executeAt: message.state.serverTime,
          seekTolerance: 0.5,
        });
      }
      showToast(isHost.value ? "你现在是房主，播放已接管" : "房主已变更");
      return;
    }
    if (message.type === "signal") handleSignal(message);
    if (message.type === "available-lines" && message.roomId === roomId.value) {
      const version = lineRequestVersion;
      const url = mediaUrl.value;
      lineLabel.value = message.lines.find(line => line.current)?.name || lineLabel.value;
      Promise.all(message.lines.map(async line => {
        try { await checkMediaAvailability(line.url); return line; } catch { return null; }
      })).then(lines => {
        if (version !== lineRequestVersion || url !== mediaUrl.value || message.roomId !== roomId.value || disposed) return;
        availableLines.value = lines.filter(Boolean); linesLoading.value = false;
      });
    }
    if (message.type === "line-error") { linesLoading.value = false; showToast(message.error); }
    if (message.type === "playlist") {
      playlist.value = message.items || [];
      playlistTitle.value = message.title || "";
      if (!playlist.value.length) playlistIndex.value = -1;
    }
    if (message.type === "sync-command") {
      if (message.command.requireHostResume) { cancelPlaybackBarrier(); syncPauseReason.value = message.command.syncReason; }
      if (message.command.resumePlay && isHost.value) {
        cancelPlaybackBarrier();
        pendingPlaybackBarrier = { id: crypto.randomUUID(), sequence: message.command.sequence, position: message.command.position, mediaUrl: message.command.mediaUrl, mediaTitle: message.command.mediaTitle };
        waitingForPeers.value = true;
      }
      applyCommand(message.command, "ws");
    }
    if (message.type === "room-state") {
      hostId.value = message.hostId;
      applyCommand({ id: `state-${message.state.sequence}`, ...message.state }, "ws");
    }
    if (message.type === "chat") renderMessage(message.message);
    if (message.type === "typing") handleTyping(message);
    if (message.type === "member-status") handleMemberStatus(message);
    if (message.type === "voice-state") updateMemberVoice(message.peerId, message.enabled, message.muted);
  }

  async function joinRoom(reconnect = false) {
    reconnect = reconnect === true;
    if (joining.value || (joined.value && !reconnect)) return;
    const name = joinName.value.trim();
    const requestedRoomId = reconnect ? roomId.value : joinRoomId.value.trim().toUpperCase() || randomRoomId();
    if (!name) return;
    joining.value = true;
    if (!reconnect && selectedResource.value?.url) {
      try { await checkMediaAvailability(selectedResource.value.url); }
      catch (cause) { joining.value = false; showToast(cause.message); return; }
      if (disposed) return;
    }
    localStorage.setItem("watch-name", name);
    connectionLabel.value = "连接中";
    clearTimeout(reconnectTimer);
    const connection = new WebSocket(resolveWebSocketUrl());
    socket = connection;
    socket.addEventListener("open", () => {
      updateConnectionStatus();
      const resource = selectedResource.value;
      send({ type: "join", syncProtocol: SYNC_PROTOCOL, roomId: requestedRoomId, name, reconnect,
        resourceId: resource?.id || "", media: resource?.id ? null : resource,
        selectionId: resource?.selectionId || "", playlistIndex: resource?.playlistIndex || 0,
        collectionResourceId: resource?.collectionResourceId || "",
        libraryGroupId: resource?.libraryGroupId || "",
        resumePosition: resource?.resumePosition || 0,
      });
      for (let index = 0; index < 5; index += 1) setTimeout(clockPing, index * 350);
    });
    socket.addEventListener("message", handleSocketMessage);
    socket.addEventListener("close", () => {
      if (socket !== connection) return;
      pauseForSafety("连接断开，已保护暂停");
      joining.value = false;
      updateConnectionStatus();
      if (joined.value && !disposed) reconnectTimer = setTimeout(() => joinRoom(true), 1500);
    });
  }

  function sendChat() {
    const text = chatText.value.trim();
    if (!text) return;
    send({ type: "chat", text });
    chatText.value = "";
    sendTyping(false);
  }

  function selectResource(resource) {
    selectedResource.value = resource;
    joinRoomId.value = "";
  }

  function sendTyping(active) {
    send({ type: "typing", active });
    broadcastData({ type: "typing", peerId: clientId.value, name: joinName.value, active }, "state");
    lastTypingSent = active;
  }

  function notifyTyping() {
    const active = chatText.value.length > 0;
    if (active !== lastTypingSent) sendTyping(active);
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => sendTyping(false), 1500);
  }

  async function copyRoomLink() {
    await navigator.clipboard.writeText(location.href);
    showToast("房间链接已复制");
  }

  function resumeRemoteAudio() {
    if (!voiceJoined.value) return;
    voiceError.value = "";
    for (const audio of remoteAudios.values()) audio.play().catch(() => {});
  }

  document.addEventListener("pointerdown", resumeRemoteAudio, { capture: true });

  document.addEventListener("visibilitychange", visibilityChanged);
  window.addEventListener("offline", visibilityChanged);
  const heartbeatInterval = setInterval(() => {
    if (!joined.value || !mediaUrl.value) return;
    if (!syncFresh() && (!videoElement.value?.paused || authorityState?.paused === false)) pauseForSafety("同步信号超时，已保护暂停");
    publishMemberStatus(true);
  }, SYNC_TICK_MS);
  const networkStatsInterval = setInterval(updateNetworkStats, 2000);
  const clockInterval = setInterval(clockPing, 500);

  onBeforeUnmount(() => {
    disposed = true;
    clearTimeout(reconnectTimer);
    clearInterval(heartbeatInterval);
    clearInterval(networkStatsInterval);
    clearInterval(clockInterval);
    clearScheduledCommands();
    clearTimeout(typingTimer);
    clearTimeout(toastTimer);
    destroyHls();
    document.removeEventListener("pointerdown", resumeRemoteAudio, { capture: true });
    document.removeEventListener("visibilitychange", visibilityChanged);
    window.removeEventListener("offline", visibilityChanged);
    stopVoiceCapture();
    for (const peerId of [...peers.keys()]) closePeer(peerId);
    socket?.close();
  });

  return {
    qualityLevels,
    mediaLoadError,
    retryMedia,
    selectedQuality,
    currentQualityLabel,
    qualitySummary,
    changeQuality,
    autoplayBlocked,
    allowPlayback,
    playlist,
    playlistTitle,
    playlistIndex,
    autoAdvance,
    selectPlaylistItem,
    handlePlaybackEnded,
    changeAutoAdvance,
    availableLines,
    linesLoading,
    lineLabel,
    requestLines,
    switchLine,
    activeTab,
    bufferBarValue,
    canControl,
    chatText,
    clientId,
    connected,
    connectionLabel,
    copyRoomLink,
    currentTime,
    changeMicrophoneGain,
    displayedTime,
    duration,
    enterFullscreen,
    noiseSuppressionEnabled,
    formatTime,
    handleMediaError,
    handlePlaybackBuffering,
    handlePlaybackReady,
    hostId,
    isHost,
    joined,
    joinName,
    joinRoom,
    joinRoomId,
    selectedResource,
    joining,
    requiresLogin,
    accountSignedOut,
    selectResource,
    loadMedia,
    mediaTitle,
    mediaPoster,
    mediaFormat,
    mediaUrl,
    memberList,
    messages,
    microphoneGain,
    networkLabel,
    networkTone,
    notifyTyping,
    playerPaused,
    playbackLabel,
    previewSeek,
    remoteAudioContainer,
    roomId,
    roomBufferSummary,
    roomHealth,
    seek,
    sendChat,
    showToast,
    toast,
    toastVisible,
    toggleMicrophone,
    toggleNoiseSuppression,
    togglePlay,
    toggleVideoMute,
    toggleVoice,
    typingText,
    updatePlayerState,
    videoElement,
    videoFrame,
    videoMuted,
    voiceError,
    voiceJoined,
    voiceMuted,
    voiceProcessing,
    voiceStarting,
    voiceStatus,
    volume,
    waitingForPeers,
    changeVolume,
  };
}
