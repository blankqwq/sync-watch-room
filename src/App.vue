<script setup>
import { computed, nextTick, onMounted, ref, watch } from "vue";
import {
  ArrowRight,
  Clapperboard,
  Copy,
  Download,
  LoaderCircle,
  Maximize,
  MessageCircle,
  Mic,
  Pause,
  Play,
  Plus,
  Send,
  SlidersHorizontal,
  Users,
  Volume2,
  VolumeX,
  Wifi,
  X,
  Film,
  ListVideo,
  LayoutGrid,
  List,
  Radio,
  SkipForward,
  UserRound,
  History,
  Trash2,
} from "lucide-vue-next";
import { useWatchRoom } from "./composables/useWatchRoom.js";
import AdminPanel from "./AdminPanel.vue";
import ResourceBrowser from "./ResourceBrowser.vue";
import RecommendationBanner from "./RecommendationBanner.vue";
import AccountDialog from "./AccountDialog.vue";
import CoverImage from "./CoverImage.vue";
import AppIcon from "./AppIcon.vue";
import { requestJson } from "./api.js";
import { checkMediaAvailability, isMediaUnavailable, isResourceUnavailable } from "./media-availability.js";

const {
  activeTab,
  bufferBarValue,
  canControl,
  changeMicrophoneGain,
  changeVolume,
  chatText,
  clientId,
  connected,
  connectionLabel,
  copyRoomLink,
  currentTime,
  displayedTime,
  duration,
  noiseSuppressionEnabled,
  enterFullscreen,
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
  mediaLoadError,
  retryMedia,
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
  autoplayBlocked,
  allowPlayback,
  playlist,
  playlistTitle,
  playlistIndex,
  autoAdvance,
  selectPlaylistItem,
  handlePlaybackEnded,
  changeAutoAdvance,
  showToast,
  availableLines,
  linesLoading,
  lineLabel,
  qualityLevels,
  selectedQuality,
  currentQualityLabel,
  qualitySummary,
  changeQuality,
  requestLines,
  switchLine,
} = useWatchRoom();

const mediaDialog = ref(null);
const lineDialog = ref(null);
const joinDialog = ref(null);
const sharedRoomInvite = ref(false);
const accountDialog = ref(null);
const account = ref(null);
const watchHistory = ref([]);
const historyBusy = ref(false);
const historyError = ref("");
const unavailableHistory = computed(() => watchHistory.value.filter((item) => item.available === false));
let historyRevision = 0;
const accountReady = ref(false);
const siteSettings = ref({ name: "同频放映室", icon: "/couple-tv-icon.png" });

function updateSiteSettings(settings) {
  siteSettings.value = settings;
  document.title = `${settings.name} · 一起看`;
  const icon = document.querySelector('link[rel="icon"]');
  if (icon) { icon.href = settings.icon; icon.removeAttribute("type"); }
}

async function loadSiteSettings() {
  try { updateSiteSettings((await requestJson("/api/settings")).settings); }
  catch { updateSiteSettings(siteSettings.value); }
}
let pendingJoin = false;
let accountRevision = 0;
const microphoneDialog = ref(null);
const mediaName = ref("");
const mediaSource = ref("");
const messagesContainer = ref(null);
const adminOpen = ref(false);
const resources = ref([]);
const resourceGroups = ref([]);
const homeTab = ref("resources");
const libraryLayout = ref("grid");
const seriesDialog = ref(null);
const selectedSeries = ref(null);
const networkSources = ref([]);
const networkBrowser = ref(null);
const networkRecommendations = ref([]);
const recommendationItems = computed(() => {
  const library = resourceGroups.value.filter(group => group.items.some(item => [item, ...(item.alternatives || [])].some(line => !isMediaUnavailable(line.url))));
  const items = library.length ? library : networkRecommendations.value.filter(item => !isResourceUnavailable(item.id));
  return [...items].sort((a, b) => Number(Boolean(b.poster)) - Number(Boolean(a.poster))).slice(0, 5).map(item => ({ ...item, kind: library.length ? "library" : "network" }));
});
const resourceError = ref("");
const libraryKeyword = ref("");
const checkingResource = ref(false);
const filteredGroups = computed(() => resourceGroups.value.map(group => ({ ...group, items: group.items.filter(item => [item, ...(item.alternatives || [])].some(line => !isMediaUnavailable(line.url))) })).filter(group => group.items.length).filter((group) =>
  `${group.title} ${group.description} ${group.items.map(item => item.title).join(' ')}`.toLowerCase().includes(libraryKeyword.value.trim().toLowerCase())));

async function loadResources() {
  try {
    const [response, sourceResponse] = await Promise.all([fetch("/api/resources"), fetch("/api/sources")]);
    if (!response.ok || !sourceResponse.ok) throw new Error("资源目录暂时不可用");
    const library = await response.json();
    resources.value = library.resources;
    resourceGroups.value = library.groups || library.resources.map(item => ({ ...item, kind: "library", items: [item] }));
    networkSources.value = (await sourceResponse.json()).sources;
    if (!resourceGroups.value.length && networkSources.value.length && homeTab.value === "resources") homeTab.value = "network";
    if (!networkSources.value.length && homeTab.value === "network") homeTab.value = "resources";
    resourceError.value = "";
  } catch (error) {
    resourceError.value = error.message;
  }
}

function openResource(resource) {
  selectResource(resource);
  if (!account.value) { pendingJoin = true; accountDialog.value?.open(); return; }
  if (!joinName.value.trim()) joinName.value = account.value.name;
  joinRoom();
}

function enterRoom() {
  joinDialog.value?.close();
  if (!account.value) { pendingJoin = true; accountDialog.value?.open(); return; }
  if (!joinName.value.trim()) joinName.value = account.value.name;
  joinRoom();
}

function openJoinDialog() {
  selectedResource.value = null;
  joinDialog.value?.showModal();
}

function createEmptyRoom() {
  joinRoomId.value = "";
  selectedResource.value = null;
  enterRoom();
}

async function loadHistory() {
  if (!account.value) return;
  const owner = account.value.id;
  const revision = ++historyRevision;
  try {
    const history = (await requestJson("/api/history")).history;
    if (account.value?.id === owner && revision === historyRevision) watchHistory.value = history;
  }
  catch (error) { showToast(error.message); }
}

async function removeHistory(item = null) {
  if (!account.value || historyBusy.value) return;
  const owner = account.value.id;
  historyBusy.value = true;
  historyError.value = "";
  historyRevision += 1;
  try {
    if (item) await requestJson(`/api/history/${encodeURIComponent(item.key)}`, "", { method: "DELETE" });
    else await requestJson("/api/history/cleanup", "", { method: "POST" });
    if (account.value?.id === owner) await loadHistory();
  } catch (error) { if (account.value?.id === owner) historyError.value = error.message; }
  finally { historyBusy.value = false; }
}

async function loadAccount() {
  const revision = accountRevision;
  try {
    const user = (await requestJson("/api/account")).user;
    if (revision !== accountRevision) return;
    account.value = user;
    if (account.value && !joinName.value) joinName.value = account.value.name;
    await loadHistory();
  } catch (error) { resourceError.value = error.message; } finally { accountReady.value = true; }
}

async function authenticated(user) {
  accountRevision += 1;
  account.value = user;
  historyError.value = "";
  joinName.value = user.name;
  await loadHistory();
  if (pendingJoin) { pendingJoin = false; joinRoom(); }
}

async function logout() {
  await requestJson("/api/auth/logout", "", { method: "POST" });
  accountRevision += 1;
  account.value = null; watchHistory.value = [];
  historyError.value = "";
  if (joined.value) location.assign("/");
}

async function resumeHistory(item) {
  try { openResource((await requestJson("/api/history/resume", "", { method: "POST", body: JSON.stringify({ key: item.key }) })).selection); }
  catch (error) { showToast(error.message); }
}

function inspectSeries(series) {
  selectedSeries.value = series;
  seriesDialog.value?.showModal();
}

async function openSeries(series, index = 0) {
  if (joining.value || checkingResource.value) return;
  const item = series.items[index];
  if (!item) return showToast("这个剧集暂时没有可观看的分集");
  checkingResource.value = true;
  let selected = null;
  try {
    for (const line of [item, ...(item.alternatives || [])]) {
      try { await checkMediaAvailability(line.url); selected = line; break; } catch { /* Try another line for this episode. */ }
    }
  } finally { checkingResource.value = false; }
  if (!selected) { showToast("这个分集没有可加载的线路，已跳过"); return; }
  seriesDialog.value?.close();
  openResource({ title: item.title, url: selected.url, libraryGroupId: series.id, collectionResourceId: selected.id, playlistIndex: index });
}

function toggleAdmin() {
  adminOpen.value = !adminOpen.value;
  if (!adminOpen.value) loadResources();
}

async function selectRecommendation(item) {
  if (item.kind === "library") {
    if (item.items.length > 1) inspectSeries(item);
    else openSeries(item);
    return;
  }
  homeTab.value = "network";
  await nextTick();
  networkBrowser.value?.inspectResource(item);
}

onMounted(loadResources);
onMounted(loadAccount);
onMounted(loadSiteSettings);
onMounted(() => {
  const code = joinRoomId.value.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,8}$/.test(code)) return;
  joinRoomId.value = code;
  sharedRoomInvite.value = true;
  openJoinDialog();
});
watch(requiresLogin, (value) => {
  if (!value) return;
  account.value = null;
  pendingJoin = true;
  accountDialog.value?.open();
  requiresLogin.value = false;
});
watch(joined, (value, previous) => {
  if (!value && previous) { loadResources(); if (!accountSignedOut.value) loadHistory(); }
});
watch(accountSignedOut, (value) => {
  if (!value) return;
  accountRevision += 1;
  account.value = null; watchHistory.value = [];
  pendingJoin = false;
  accountSignedOut.value = false;
});
const currentMember = computed(() => memberList.value.find((member) => member.id === clientId.value));
const mobileBufferLabel = computed(() => {
  const playback = currentMember.value?.playback;
  if (!playback || playback.mediaUrl !== mediaUrl.value) return "缓存 --";
  const percent = Math.round(playback.loadedPercent || 0);
  if (percent > 0) return `缓存 ${percent}%`;
  if (playback.bufferedAhead > 0) return `可播 ${playback.bufferedAhead.toFixed(1)}s`;
  return playback.buffering ? "缓冲中" : "缓存检测中";
});

function openMediaDialog() {
  mediaName.value = mediaTitle.value === "尚未添加视频" ? "" : mediaTitle.value;
  mediaSource.value = mediaUrl.value;
  mediaDialog.value?.showModal();
}

function openLines() {
  lineDialog.value?.showModal();
  requestLines();
}

function chooseLine(line) {
  switchLine(line);
  lineDialog.value?.close();
}

function closeMediaDialog() {
  mediaDialog.value?.close();
}

function openMicrophoneDialog() {
  microphoneDialog.value?.showModal();
}

function closeMicrophoneDialog() {
  microphoneDialog.value?.close();
}

function closeMicrophoneDialogOnBackdrop(event) {
  if (event.target === microphoneDialog.value) closeMicrophoneDialog();
}

function useDemoMedia() {
  mediaName.value = "同步演示片";
  mediaSource.value = `${location.origin}/demo.mp4`;
}

function submitMedia() {
  const url = mediaSource.value.trim();
  const title = mediaName.value.trim() || new URL(url).pathname.split("/").pop() || "未命名视频";
  loadMedia(url, title);
  closeMediaDialog();
}

function formatChatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

watch(
  () => messages.value.length,
  async () => {
    await nextTick();
    if (messagesContainer.value) messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
  },
);
</script>

<template>
  <main class="app-shell">
    <header class="topbar" :class="{ 'home-topbar': !joined && !adminOpen }">
      <a class="brand" href="/" :aria-label="`${siteSettings.name}首页`">
        <span class="brand-mark brand-image"><AppIcon :src="siteSettings.icon" /></span>
        <span class="brand-name">{{ siteSettings.name }} <small>WATCH TOGETHER</small></span>
      </a>
      <div v-if="joined" class="room-meta">
        <span class="status-dot" :class="{ connected }"></span>
        <span>{{ connectionLabel }}</span>
        <button class="room-code" type="button" title="复制房间链接" @click="copyRoomLink">
          <Copy :size="13" />
          <span>房间 {{ roomId }}</span>
        </button>
        <a class="room-home-link" href="/">返回资源库</a>
      </div>
      <div v-else class="topbar-actions"><template v-if="account"><span class="account-name"><UserRound :size="15" />{{ account.name }}</span><button class="text-button" type="button" @click="logout">退出</button></template><button v-else class="secondary-button icon-text" type="button" @click="pendingJoin = false; accountDialog.open()"><UserRound :size="15" />登录</button><button class="text-button" type="button" @click="toggleAdmin">{{ adminOpen ? '返回首页' : '管理后台' }}</button></div>
    </header>

    <div v-if="!joined && !adminOpen" class="home-layout">
      <section class="home-main">
        <h1 class="visually-hidden">影片</h1>
        <div class="home-toolbar">
        <nav class="workspace-tabs library-tabs" aria-label="浏览资源">
          <button v-if="resourceGroups.length || !networkSources.length" type="button" :class="{ active: homeTab === 'resources' }" @click="homeTab = 'resources'">资源库</button>
          <button v-if="networkSources.length" type="button" :class="{ active: homeTab === 'network' }" @click="homeTab = 'network'">找影片</button>
          <button type="button" :class="{ active: homeTab === 'history' }" @click="homeTab = 'history'; loadHistory()">观看历史</button>
        </nav>
        <button class="secondary-button icon-text join-trigger" type="button" :disabled="joining" @click="openJoinDialog"><Users :size="16" />{{ joining ? '连接中…' : '加入房间' }}</button>
        </div>
        <RecommendationBanner v-if="homeTab !== 'history' && recommendationItems.length" :items="recommendationItems" :disabled="joining || checkingResource" @select="selectRecommendation" />
        <p v-if="resourceError" class="admin-error" role="alert">{{ resourceError }}</p>
        <p v-if="checkingResource" class="notice" role="status">正在检查播放线路…</p><p v-if="toastVisible" class="notice" role="status">{{ toast }}</p>
        <template v-if="homeTab === 'resources'">
          <div class="library-toolbar"><input v-model="libraryKeyword" type="search" placeholder="搜索影片或剧集" aria-label="搜索资源库" /><button class="icon-button" type="button" :aria-label="libraryLayout === 'grid' ? '列表视图' : '卡片视图'" @click="libraryLayout = libraryLayout === 'grid' ? 'list' : 'grid'"><List v-if="libraryLayout === 'grid'" :size="17" /><LayoutGrid v-else :size="17" /></button><button class="icon-button" type="button" aria-label="刷新资源" @click="loadResources"><Download :size="17" /></button></div>
          <div v-if="!resources.length" class="empty-state"><Film :size="32" /><h2>暂无资源</h2><p>管理员添加资源后会显示在这里。</p></div>
          <div class="catalog-grid" :class="{ 'catalog-list': libraryLayout === 'list' }">
            <article v-for="(resource, index) in filteredGroups" :key="resource.id" class="catalog-card">
              <div class="catalog-cover" :class="`cover-tone-${index % 4}`"><CoverImage :src="resource.poster" :title="resource.title" /><span class="cover-label">{{ resource.items.length > 1 ? `${resource.items.length} 集` : '影片' }}</span></div>
              <div class="catalog-card-body"><h3 :title="resource.title">{{ resource.title }}</h3><p v-if="resource.description" :title="resource.description">{{ resource.description }}</p><div class="resource-actions"><button class="primary-button icon-text" type="button" :disabled="joining || checkingResource" @click="openSeries(resource)"><Play :size="14" />一起看</button><button v-if="resource.items.length > 1" class="secondary-button" type="button" @click="inspectSeries(resource)">选集</button></div></div>
            </article>
          </div>
          <p v-if="resources.length && !filteredGroups.length" class="empty-note">没有匹配的资源，换个关键词试试。</p>
        </template>
        <template v-if="homeTab === 'history'">
          <div v-if="account && watchHistory.length" class="history-toolbar admin-actions"><button v-if="unavailableHistory.length" class="secondary-button icon-text" type="button" :disabled="historyBusy" @click="removeHistory()"><Trash2 :size="14" />清理失效记录（{{ unavailableHistory.length }}）</button><button class="secondary-button" type="button" :disabled="historyBusy" @click="loadHistory">刷新</button></div>
          <p v-if="historyError" class="admin-error" role="alert">{{ historyError }}</p>
          <div v-if="!account" class="empty-state"><History :size="32" /><h3>登录后查看观看历史</h3><button class="primary-button" type="button" @click="accountDialog.open()">登录账户</button></div>
          <p v-else-if="!watchHistory.length" class="empty-note">暂无观看记录。</p>
          <div class="catalog-grid history-grid"><article v-for="(item, index) in watchHistory" :key="item.key" class="catalog-card"><div class="catalog-cover" :class="`cover-tone-${index % 4}`"><CoverImage :src="item.poster" :title="item.title" /><span class="cover-label">{{ formatTime(item.position) }}</span></div><div class="catalog-card-body"><small>{{ new Date(item.updatedAt).toLocaleDateString() }}</small><h3 :title="item.title">{{ item.title }}</h3><p :title="item.episodeTitle">{{ item.episodeTitle }}</p><p v-if="item.available === false" class="history-unavailable">资源已失效，可删除此记录</p><div class="history-progress"><span :style="{ width: `${item.duration ? Math.min(100, item.position / item.duration * 100) : 0}%` }"></span></div><button class="primary-button icon-text" type="button" :disabled="historyBusy || item.available === false" @click="resumeHistory(item)"><Play :size="14" />{{ item.available === false ? '资源不可用' : item.completed ? item.playlistIndex + 1 < item.playlistLength ? '观看下一集' : '重新观看' : '继续观看' }}</button><button class="text-button danger-text history-delete icon-text" type="button" :aria-label="`删除观看记录：${item.title}`" :disabled="historyBusy" @click="removeHistory(item)"><Trash2 :size="14" />删除记录</button></div></article></div>
        </template>
        <ResourceBrowser v-if="homeTab === 'network'" ref="networkBrowser" :sources="networkSources" :disabled="joining" @select="openResource" @recommendations="networkRecommendations = $event" />
        <div v-if="homeTab === 'network' && !networkSources.length" class="empty-state"><Radio :size="42" /><h3>还没有开放的网络来源</h3><p>管理员添加并公开来源后，就能在这里搜索。</p></div>
      </section>
    </div>

    <section v-if="joined" class="room-view">
      <div class="watch-stage">
        <div ref="videoFrame" class="video-frame">
          <video
            ref="videoElement"
            playsinline
            preload="auto"
            @error="handleMediaError"
            @timeupdate="updatePlayerState"
            @loadedmetadata="updatePlayerState(); handlePlaybackReady()"
            @resize="updatePlayerState"
            @loadstart="handlePlaybackBuffering"
            @progress="handlePlaybackReady"
            @canplay="handlePlaybackReady"
            @playing="handlePlaybackReady"
            @waiting="handlePlaybackBuffering"
            @seeked="handlePlaybackReady"
            @stalled="handlePlaybackBuffering"
            @play="updatePlayerState"
            @pause="updatePlayerState"
            @ended="handlePlaybackEnded"
          ></video>
          <button v-if="autoplayBlocked" class="autoplay-unlock primary-button icon-text" type="button" @click="allowPlayback"><Play :size="18" />允许同步播放</button>
          <div v-if="mediaLoadError" class="video-empty" role="alert"><strong>片源无法加载</strong><span>{{ mediaLoadError }}</span><div class="admin-actions"><button class="primary-button" type="button" @click="retryMedia">重试加载</button><button v-if="isHost" class="secondary-button" type="button" @click="openLines">切换线路</button></div></div>
          <div v-else-if="!mediaUrl" class="video-empty">
            <Play class="empty-icon" :size="25" fill="currentColor" />
            <strong>等待片源</strong>
            <span>{{ isHost ? "添加 OSS 或 CDN 视频地址后开始" : "房主添加视频后即可开始" }}</span>
          </div>
          <div v-if="mediaUrl && currentMember" class="mobile-player-metrics" aria-label="当前用户播放状态">
            <span class="mobile-metric user-metric" :title="currentMember.name">
              <span class="metric-avatar">{{ currentMember.name.slice(0, 1).toUpperCase() }}</span>
              <span>{{ currentMember.name }}</span>
            </span>
            <span class="mobile-metric" title="房间人数">
              <Users :size="11" />{{ memberList.length }}
            </span>
            <span class="mobile-metric" :class="networkTone(currentMember)" title="当前延迟">
              <Wifi :size="11" />{{ networkLabel(currentMember) }}
            </span>
            <span class="mobile-metric" title="当前缓存">
              <Download :size="11" />{{ mobileBufferLabel }}
            </span>
          </div>
          <div class="sync-toast" :class="{ show: toastVisible }" role="status">{{ toast }}</div>
        </div>

        <div class="player-controls">
          <button
            class="icon-button"
            type="button"
            :disabled="!canControl"
            :title="waitingForPeers ? '等待缓冲' : playerPaused ? '播放' : '暂停'"
            :aria-label="waitingForPeers ? '等待缓冲' : playerPaused ? '播放' : '暂停'"
            @click="togglePlay"
          >
            <LoaderCircle v-if="waitingForPeers" class="spin" :size="17" />
            <Play v-else-if="playerPaused" :size="17" fill="currentColor" />
            <Pause v-else :size="17" fill="currentColor" />
          </button>
          <span class="time">{{ formatTime(displayedTime) }}</span>
          <input
            class="progress"
            type="range"
            min="0"
            :max="duration || 100"
            :value="displayedTime"
            step="0.01"
            aria-label="播放进度"
            :disabled="!canControl"
            @input="previewSeek"
            @change="seek"
          />
          <span class="time">{{ formatTime(duration) }}</span>
          <button class="icon-button" type="button" :title="videoMuted ? '取消静音' : '静音'" :aria-label="videoMuted ? '取消静音' : '静音'" @click="toggleVideoMute">
            <VolumeX v-if="videoMuted" :size="17" />
            <Volume2 v-else :size="17" />
          </button>
          <input class="volume" type="range" min="0" max="1" :value="volume" step="0.05" aria-label="音量" @input="changeVolume" />
          <button id="fullscreenButton" class="icon-button" type="button" title="全屏" aria-label="全屏" @click="enterFullscreen">
            <Maximize :size="17" />
          </button>
        </div>

        <div class="media-bar">
          <div class="media-actions">
            <div class="voice-control">
              <span class="voice-status" :class="{ active: voiceJoined && !voiceError, error: voiceError }">{{ voiceStatus }}</span>
              <label v-if="voiceJoined" class="mic-switch">
                <input type="checkbox" :checked="!voiceMuted" @change="toggleMicrophone" />
                <span class="switch-track" aria-hidden="true"></span>
                <span>麦克风</span>
              </label>
              <button class="icon-button mic-settings-button" type="button" title="麦克风设置" aria-label="麦克风设置" @click="openMicrophoneDialog">
                <SlidersHorizontal :size="16" />
              </button>
              <button class="secondary-button icon-text" type="button" :disabled="voiceStarting" @click="toggleVoice">
                <Mic :size="15" />
                <span>{{ voiceJoined ? "退出语音" : "加入语音" }}</span>
              </button>
            </div>
            <button v-if="isHost" class="secondary-button icon-text" type="button" @click="openMediaDialog">
              <Plus :size="15" />
              <span>添加片源</span>
            </button>
          </div>
          <div class="media-title">
            <span class="media-label">正在播放</span>
            <div class="media-name-row"><span v-if="mediaUrl" class="playing-cover"><CoverImage :src="mediaPoster" :title="mediaTitle" compact /></span>
              <strong>{{ mediaTitle }}</strong>
              <span v-if="mediaUrl" class="format-badge">{{ mediaFormat }}</span>
            </div>
            <div class="media-status-row">
              <div class="room-health" :class="roomHealth.tone">
                <Wifi :size="12" />
                <span>{{ roomHealth.label }}</span>
              </div>
              <div v-if="mediaUrl" class="room-buffer-summary" :title="roomBufferSummary">
                <Download :size="12" />
                <span>{{ roomBufferSummary }}</span>
              </div>
            </div>
          </div>
        </div>
        <section v-if="mediaUrl" class="room-playlist">
          <div class="playlist-heading"><div><ListVideo :size="17" /><strong>{{ playlist.length > 1 ? playlistTitle || '选集' : '播放设置' }}</strong><span v-if="playlist.length > 1">{{ playlistIndex + 1 }} / {{ playlist.length }}</span></div><div class="playlist-tools"><label v-if="qualityLevels.length > 1" class="quality-picker"><span>画质</span><select :value="selectedQuality" aria-label="播放画质" @change="changeQuality"><option :value="-1">自动</option><option v-for="level in qualityLevels" :key="level.index" :value="level.index">{{ level.label }}</option></select><small v-if="currentQualityLabel">当前 {{ currentQualityLabel }}</small></label><span v-else class="quality-note">{{ qualitySummary }}</span><button class="secondary-button icon-text" type="button" :disabled="!isHost" @click="openLines"><Radio :size="15" />{{ lineLabel }} · 切换</button><label v-if="playlist.length > 1" class="admin-checkbox"><input v-model="autoAdvance" type="checkbox" :disabled="!isHost" @change="changeAutoAdvance" /><span>自动续播</span></label><button v-if="playlist.length > 1" class="secondary-button icon-text" type="button" :disabled="!isHost || playlistIndex >= playlist.length - 1" @click="selectPlaylistItem(playlistIndex + 1, !playerPaused)"><SkipForward :size="14" />下一集</button></div></div>
          <div v-if="playlist.length > 1" class="playlist-strip"><button v-for="(item, index) in playlist" :key="index" type="button" :class="{ active: index === playlistIndex }" :disabled="!isHost || isMediaUnavailable(item.url)" :title="item.title" @click="selectPlaylistItem(index, !playerPaused)"><span>{{ index + 1 }}</span>{{ item.title }}</button></div>
        </section>
      </div>

      <aside class="side-panel">
        <div class="panel-tabs">
          <button class="tab" :class="{ active: activeTab === 'chat' }" type="button" @click="activeTab = 'chat'">
            <MessageCircle :size="15" />
            <span>聊天</span>
          </button>
          <button class="tab" :class="{ active: activeTab === 'members' }" type="button" @click="activeTab = 'members'">
            <Users :size="15" />
            <span>成员 {{ memberList.length }}</span>
          </button>
        </div>

        <div v-show="activeTab === 'chat'" class="tab-panel active">
          <div ref="messagesContainer" class="messages">
            <article
              v-for="message in messages"
              :key="message.id"
              class="message"
              :class="{ own: message.senderId === clientId, system: message.type === 'system' }"
            >
              <template v-if="message.type === 'system'">
                <span>{{ message.text }}</span>
                <time>{{ formatChatTime(message.sentAt) }}</time>
              </template>
              <template v-else>
                <div class="message-heading">
                  <strong>{{ message.senderName }}</strong>
                  <span>{{ formatChatTime(message.sentAt) }}</span>
                </div>
                <p>{{ message.text }}</p>
              </template>
            </article>
          </div>
          <div class="typing">{{ typingText }}</div>
          <form class="chat-form" @submit.prevent="sendChat">
            <input v-model="chatText" maxlength="500" autocomplete="off" placeholder="说点什么…" @input="notifyTyping" />
            <button type="submit" title="发送" aria-label="发送"><Send :size="18" /></button>
          </form>
        </div>

        <div v-show="activeTab === 'members'" class="tab-panel active members">
          <div>
            <div v-for="member in memberList" :key="member.id" class="member">
              <span class="avatar">{{ member.name.slice(0, 1).toUpperCase() }}</span>
              <div class="member-details">
                <div class="member-heading-row">
                  <span class="member-name">{{ member.id === clientId ? `${member.name}（你）` : member.name }}</span>
                  <span v-if="member.id === hostId" class="host-badge">房主</span>
                  <span v-if="member.voiceEnabled" class="voice-badge" :class="{ muted: member.voiceMuted }">
                    {{ member.voiceMuted ? "已静音" : "语音中" }}
                  </span>
                </div>
                <div class="member-metrics">
                  <span>{{ playbackLabel(member) }}</span>
                  <span class="network-metric" :class="networkTone(member)">
                    <Wifi :size="11" />{{ networkLabel(member) }}
                  </span>
                  <span v-if="member.network?.packetLoss >= 1">丢包 {{ Math.round(member.network.packetLoss) }}%</span>
                </div>
                <div v-if="mediaUrl" class="buffer-meter" aria-hidden="true">
                  <span :style="{ width: `${bufferBarValue(member)}%` }"></span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </section>
    <AdminPanel v-if="!joined && adminOpen" @settings-updated="updateSiteSettings" />
  </main>

  <div ref="remoteAudioContainer" hidden></div>
  <AccountDialog ref="accountDialog" @authenticated="authenticated" />
  <dialog ref="joinDialog" class="room-entry-dialog" @close="sharedRoomInvite = false" @click="event => { if (event.target === joinDialog) joinDialog.close(); }"><form @submit.prevent="enterRoom"><div class="dialog-heading"><h2>加入房间</h2><button class="icon-button" type="button" aria-label="关闭加入房间" @click="joinDialog.close()"><X :size="18" /></button></div><p v-if="sharedRoomInvite" class="form-note">是否加入房间 {{ joinRoomId }}？确认后将与房间成员同步观看。</p><label><span>房间码</span><input v-model="joinRoomId" maxlength="8" pattern="[A-Za-z0-9]{1,8}" autocomplete="off" placeholder="输入朋友分享的房间码" required /></label><label><span>昵称</span><input v-model="joinName" maxlength="20" autocomplete="nickname" required /></label><button class="primary-button" type="submit" :disabled="joining">{{ joining ? '连接中…' : '加入房间' }}</button><button v-if="sharedRoomInvite" class="secondary-button" type="button" @click="joinDialog.close()">暂不加入</button><button v-else class="text-button" type="button" :disabled="joining" @click="createEmptyRoom">创建空房间</button></form></dialog>
  <dialog ref="lineDialog" class="resource-detail-dialog" @click="event => { if (event.target === lineDialog) lineDialog.close(); }"><div class="resource-detail"><div class="dialog-heading"><div><span class="eyebrow">保留进度，继续观看</span><h2>切换播放线路</h2></div><button class="icon-button" type="button" aria-label="关闭线路选择" @click="lineDialog.close()"><X :size="18" /></button></div><p class="admin-muted">分集顺序不变，所有房间成员会一起切换。</p><p v-if="linesLoading" class="empty-note">正在寻找可用线路…</p><p v-else-if="!availableLines.length" class="empty-note">暂时没有其他可用线路。</p><div class="episode-grid"><button v-for="line in availableLines" :key="line.id" class="episode-button" type="button" :disabled="line.current" @click="chooseLine(line)">{{ line.name }}{{ line.current ? ' · 当前' : '' }}<ArrowRight :size="14" /></button></div></div></dialog>

  <dialog ref="seriesDialog" class="resource-detail-dialog" @click="event => { if (event.target === seriesDialog) seriesDialog.close(); }"><div v-if="selectedSeries" class="resource-detail"><div class="dialog-heading"><div><span class="eyebrow">选集</span><h2>{{ selectedSeries.title }}</h2></div><button class="icon-button" type="button" aria-label="关闭选集" @click="seriesDialog.close()"><X :size="18" /></button></div><p class="admin-muted">{{ selectedSeries.description || '选择一集，开启你的放映室。' }}</p><span class="series-detail-cover"><CoverImage :src="selectedSeries.poster" :title="selectedSeries.title" compact /></span><div class="episode-grid"><button v-for="(item, index) in selectedSeries.items" :key="item.id" class="episode-button" type="button" :disabled="joining || checkingResource" @click="openSeries(selectedSeries, index)"><span>{{ index + 1 }}</span>{{ item.title }}</button></div></div></dialog>


  <dialog ref="microphoneDialog" class="mic-settings-dialog" @click="closeMicrophoneDialogOnBackdrop">
    <form method="dialog" @submit.prevent="closeMicrophoneDialog">
      <div class="dialog-heading">
        <div>
          <span class="eyebrow">音频处理</span>
          <h2><Mic :size="20" />麦克风设置</h2>
        </div>
        <button class="icon-button" type="button" title="关闭" aria-label="关闭麦克风设置" @click="closeMicrophoneDialog"><X :size="18" /></button>
      </div>
      <label class="settings-toggle">
        <span class="setting-copy">
          <strong>麦克风降噪</strong>
          <small>RNNoise 实时处理</small>
        </span>
        <span class="setting-switch">
          <input
            type="checkbox"
            :checked="noiseSuppressionEnabled"
            :disabled="voiceProcessing"
            @change="toggleNoiseSuppression"
          />
          <span class="switch-track" aria-hidden="true"></span>
        </span>
      </label>
      <label class="gain-control">
        <span class="gain-heading">
          <span>麦克风音量</span>
          <output>{{ microphoneGain === 0 ? "静音" : `${microphoneGain}%` }}</output>
        </span>
        <input
          type="range"
          min="0"
          max="250"
          step="10"
          :value="microphoneGain"
          aria-label="麦克风音量"
          :aria-valuetext="microphoneGain === 0 ? '静音' : `${microphoneGain}%`"
          @input="changeMicrophoneGain"
        />
        <span class="gain-scale" aria-hidden="true">
          <small>静音</small>
          <small>原始</small>
          <small>放大</small>
        </span>
      </label>
      <div class="dialog-actions">
        <button class="primary-button" type="submit">完成</button>
      </div>
    </form>
  </dialog>

  <dialog ref="mediaDialog">
    <form method="dialog" @submit.prevent="submitMedia">
      <div class="dialog-heading">
        <div>
          <span class="eyebrow">片源设置</span>
          <h2><Clapperboard :size="20" />添加视频片源</h2>
        </div>
        <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="closeMediaDialog"><X :size="18" /></button>
      </div>
      <label>
        <span>视频名称</span>
        <input v-model="mediaName" maxlength="120" placeholder="今晚一起看的电影" />
      </label>
      <label>
        <span>OSS 或 CDN 地址</span>
        <input v-model="mediaSource" type="url" placeholder="https://media.example.com/video.mp4 或 stream.m3u8" required />
      </label>
      <p class="form-note">支持 MP4、WebM 和 HLS（M3U8）。片源需使用 HTTPS，并允许跨域访问；实际编码仍须由当前浏览器支持。</p>
      <button class="text-button" type="button" @click="useDemoMedia">使用内置演示片源</button>
      <div class="dialog-actions">
        <button class="secondary-button" type="button" @click="closeMediaDialog">取消</button>
        <button class="primary-button" type="submit">载入视频</button>
      </div>
    </form>
  </dialog>
</template>
