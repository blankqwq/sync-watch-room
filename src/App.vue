<script setup>
import { computed, nextTick, ref, watch } from "vue";
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
} from "lucide-vue-next";
import { useWatchRoom } from "./composables/useWatchRoom.js";

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
  loadMedia,
  mediaTitle,
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
} = useWatchRoom();

const mediaDialog = ref(null);
const microphoneDialog = ref(null);
const mediaName = ref("");
const mediaSource = ref("");
const messagesContainer = ref(null);
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
    <header class="topbar">
      <a class="brand" href="/" aria-label="同频放映室首页">
        <span class="brand-mark">S</span>
        <span>同频放映室</span>
      </a>
      <div v-if="joined" class="room-meta">
        <span class="status-dot" :class="{ connected }"></span>
        <span>{{ connectionLabel }}</span>
        <button class="room-code" type="button" title="复制房间链接" @click="copyRoomLink">
          <Copy :size="13" />
          <span>房间 {{ roomId }}</span>
        </button>
      </div>
    </header>

    <section v-if="!joined" class="join-view">
      <div class="join-copy">
        <span class="eyebrow">一起看视频</span>
        <h1>每一秒，都在同一刻。</h1>
        <p>创建一个放映室，邀请朋友同步播放、聊天与语音。</p>
      </div>
      <form class="join-form" @submit.prevent="joinRoom">
        <label>
          <span>你的昵称</span>
          <input v-model="joinName" maxlength="20" autocomplete="nickname" placeholder="例如：小明" required />
        </label>
        <label>
          <span>房间码</span>
          <input v-model="joinRoomId" maxlength="8" autocomplete="off" placeholder="留空则创建新房间" />
        </label>
        <button class="primary-button icon-text" type="submit">
          <span>进入放映室</span>
          <ArrowRight :size="16" />
        </button>
      </form>
    </section>

    <section v-else class="room-view">
      <div class="watch-stage">
        <div ref="videoFrame" class="video-frame">
          <video
            ref="videoElement"
            playsinline
            preload="auto"
            @error="handleMediaError"
            @timeupdate="updatePlayerState"
            @loadedmetadata="updatePlayerState(); handlePlaybackReady()"
            @loadstart="handlePlaybackBuffering"
            @progress="handlePlaybackReady"
            @canplay="handlePlaybackReady"
            @playing="handlePlaybackReady"
            @waiting="handlePlaybackBuffering"
            @stalled="handlePlaybackBuffering"
            @play="updatePlayerState"
            @pause="updatePlayerState"
          ></video>
          <div v-if="!mediaUrl" class="video-empty">
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
          <div class="media-title">
            <span class="media-label">正在播放</span>
            <div class="media-name-row">
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
        </div>
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
  </main>

  <div ref="remoteAudioContainer" hidden></div>

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
