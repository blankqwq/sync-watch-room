<script setup>
import { computed, onBeforeUnmount, ref } from "vue";
import ResourceBrowser from "./ResourceBrowser.vue";
import OssManager from "./OssManager.vue";
import OssFilePicker from "./OssFilePicker.vue";
import OssUploadDialog from "./OssUploadDialog.vue";
import SiteSettings from "./SiteSettings.vue";
import { CloudUpload, Film, LayoutDashboard, Radio, RefreshCw, Settings } from "lucide-vue-next";
import { requestJson } from "./api.js";

const emit = defineEmits(["settings-updated"]);
const siteSettings = ref({ name: "同频放映室", icon: "/couple-tv-icon.png" });

const token = ref(sessionStorage.getItem("watch-admin-token") || "");
const unlocked = ref(false);
const error = ref("");
const busy = ref(false);
const rooms = ref([]);
const presets = ref([]);
const ossConfig = ref({ enabled: false });
const activeSection = ref("rooms");
const sections = [
  { id: "rooms", label: "在线房间", icon: LayoutDashboard },
  { id: "resources", label: "资源库", icon: Film },
  { id: "sources", label: "资源来源", icon: Radio },
  { id: "oss", label: "OSS 管理", icon: CloudUpload },
  { id: "settings", label: "应用设置", icon: Settings },
];
const resources = ref([]);
const sources = ref([]);
const enabledSources = computed(() => sources.value.filter((source) => source.enabled));
const publishedUrls = computed(() => resources.value.map((resource) => resource.url));
const sourceDraft = ref({ name: "", url: "", public: false, enabled: true });
const sourceEditingId = ref("");
const editingResource = ref(null);
const resourceForm = ref(null);
const title = ref("");
const url = ref("");
const ossPickerOpen = ref(false);
const ossUploadOpen = ref(false);
const selectedOssUrl = ref("");
const poster = ref("");
const description = ref("");
let roomTimer = null;

async function request(path, options = {}) {
  return requestJson(path, token.value, options);
}

async function run(action) {
  if (busy.value) return;
  error.value = "";
  busy.value = true;
  try {
    await action();
  } catch (cause) {
    error.value = cause.message;
  } finally {
    busy.value = false;
  }
}

async function refresh() {
  const [roomData, resourceData, sourceData, presetData, settingsData] = await Promise.all([
    request("/api/admin/rooms"), request("/api/admin/resources"), request("/api/admin/sources"), request("/api/admin/source-presets"), request("/api/admin/settings"),
  ]);
  rooms.value = roomData.rooms;
  resources.value = resourceData.resources;
  sources.value = sourceData.sources;
  ossConfig.value = sourceData.oss;
  presets.value = presetData.presets;
  siteSettings.value = settingsData.settings;
}

function updateSettings(settings) {
  siteSettings.value = settings;
  emit("settings-updated", settings);
}

async function login() {
  await run(async () => {
    await refresh();
    sessionStorage.setItem("watch-admin-token", token.value);
    unlocked.value = true;
    clearInterval(roomTimer);
    roomTimer = setInterval(() => request("/api/admin/rooms").then((data) => { rooms.value = data.rooms; }).catch(() => {}), 10000);
  });
}

async function saveResource() {
  await run(async () => {
    await request(editingResource.value ? `/api/admin/resources/${editingResource.value.id}` : "/api/admin/resources", {
      method: editingResource.value ? "PUT" : "POST",
      body: JSON.stringify({ ...editingResource.value, title: title.value, url: url.value, poster: poster.value, description: description.value, source: selectedOssUrl.value === url.value && selectedOssUrl.value ? "OSS" : editingResource.value?.source || "manual" }),
    });
    clearResourceForm();
    await refresh();
  });
}

function clearResourceForm() {
  editingResource.value = null;
  title.value = "";
  url.value = "";
  selectedOssUrl.value = "";
  poster.value = "";
  description.value = "";
}

function editResource(resource) {
  editingResource.value = resource;
  selectedOssUrl.value = "";
  title.value = resource.title;
  url.value = resource.url;
  poster.value = resource.poster;
  description.value = resource.description;
  resourceForm.value?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function selectOssFile(file) {
  url.value = file.url;
  selectedOssUrl.value = file.url;
  if (!title.value.trim()) title.value = file.key.split("/").pop().replace(/\.(mp4|webm|m3u8)$/i, "").slice(0, 120);
}

function uploadedOssFile(file) { selectOssFile({ url: file.url, key: file.fileName }); }

async function toggleResource(resource) {
  await run(async () => {
    await request(`/api/admin/resources/${resource.id}`, { method: "PUT", body: JSON.stringify({ ...resource, enabled: !resource.enabled }) });
    await refresh();
  });
}

async function deleteResource(resource) {
  if (!confirm(`删除「${resource.title}」？`)) return;
  await run(async () => {
    await request(`/api/admin/resources/${resource.id}`, { method: "DELETE" });
    await refresh();
  });
}

async function closeRoom(room) {
  if (!confirm(`关闭房间 ${room.id}？房间内的用户会断开连接。`)) return;
  await run(async () => {
    await request(`/api/admin/rooms/${room.id}`, { method: "DELETE" });
    await refresh();
  });
}

async function saveSource() {
  await run(async () => {
    await request(sourceEditingId.value ? `/api/admin/sources/${sourceEditingId.value}` : "/api/admin/sources", {
      method: sourceEditingId.value ? "PUT" : "POST", body: JSON.stringify(sourceDraft.value),
    });
    resetSource();
    await refresh();
  });
}

function resetSource() {
  sourceEditingId.value = "";
  sourceDraft.value = { name: "", url: "", public: false, enabled: true };
}

function editSource(source) {
  sourceEditingId.value = source.id;
  sourceDraft.value = { ...source };
}

async function toggleSource(source, field) {
  await run(async () => {
    await request(`/api/admin/sources/${source.id}`, { method: "PUT", body: JSON.stringify({ ...source, [field]: !source[field] }) });
    await refresh();
  });
}

async function deleteSource(source) {
  if (!confirm(`删除资源来源「${source.name}」？已入库的资源会保留。`)) return;
  await run(async () => {
    await request(`/api/admin/sources/${source.id}`, { method: "DELETE" });
    if (sourceEditingId.value === source.id) resetSource();
    await refresh();
  });
}

async function importResource(resource) {
  await run(async () => {
    await request("/api/admin/resources", { method: "POST", body: JSON.stringify(resource) });
    await refresh();
  });
}

async function importSeries(resources) {
  await run(async () => {
    await request("/api/admin/resources/import", { method: "POST", body: JSON.stringify({ resources }) });
    await refresh();
  });
}

async function addPreset(preset) {
  await run(async () => {
    await request("/api/admin/sources", { method: "POST", body: JSON.stringify({ name: preset.name, url: preset.url, public: false }) });
    await refresh();
  });
}

onBeforeUnmount(() => clearInterval(roomTimer));
</script>

<template>
  <section class="admin-view">
    <div class="page-heading"><div><span class="eyebrow">工作空间</span><h1>管理控制台</h1><p>把资源整理好，让每次一起看都更简单。</p></div><span class="workspace-badge">{{ siteSettings.name }} · ADMIN</span></div>
    <form v-if="!unlocked" class="admin-card admin-login" @submit.prevent="login">
      <LayoutDashboard :size="30" /><h2>进入你的控制台</h2><p class="admin-muted">使用管理员令牌管理房间、资源和存储。</p>
      <label><span>管理员令牌</span><input v-model="token" type="password" autocomplete="off" required /></label>
      <button class="primary-button" type="submit" :disabled="busy">进入后台</button>
    </form>
    <p v-if="error" class="admin-error" role="alert">{{ error }}</p>
    <template v-if="unlocked">
      <div class="dashboard-stats">
        <div><span>在线房间</span><strong>{{ rooms.length }}</strong><small>{{ rooms.reduce((count, room) => count + room.members.length, 0) }} 位观众在线</small></div>
        <div><span>资源库</span><strong>{{ resources.length }}</strong><small>{{ resources.filter(item => item.enabled).length }} 个已公开</small></div>
        <div><span>资源来源</span><strong>{{ sources.length }}</strong><small>{{ ossConfig.enabled ? 'OSS 已配置' : 'OSS 待配置' }}</small></div>
      </div>
      <nav class="workspace-tabs" aria-label="后台功能">
        <button v-for="section in sections" :key="section.id" type="button" :class="{ active: activeSection === section.id }" @click="activeSection = section.id"><component :is="section.icon" :size="17" />{{ section.label }}</button>
      </nav>
      <section v-if="activeSection === 'rooms'" class="admin-card">
        <div class="admin-heading"><div><h2>在线放映室</h2><p class="admin-muted">查看正在一起观看的房间，按需结束放映。</p></div><button class="secondary-button icon-text" type="button" :disabled="busy" @click="run(refresh)"><RefreshCw :size="15" />刷新</button></div>
        <div v-if="!rooms.length" class="empty-state"><LayoutDashboard :size="38" /><h3>此刻还没有人开房</h3><p>朋友们进入放映室后，会显示在这里。</p></div>
        <div v-for="room in rooms" :key="room.id" class="room-admin-card"><span class="room-avatar"><Film :size="22" /></span><div><strong>房间 {{ room.id }}</strong><p>{{ room.mediaTitle || '等待片源' }}</p><small>{{ room.members.length }} 人 · {{ room.members.map(member => member.name).join('、') }}</small></div><button class="secondary-button" type="button" :disabled="busy" @click="closeRoom(room)">结束房间</button></div>
      </section>
      <div v-if="activeSection === 'resources'" class="admin-section-grid">
        <section class="admin-card">
          <div class="section-title"><Film :size="20" /><h2>{{ editingResource ? '编辑资源' : '添加视频资源' }}</h2></div>
          <form ref="resourceForm" class="admin-form" @submit.prevent="saveResource">
            <label><span>名称</span><input v-model="title" maxlength="120" placeholder="给视频取个名字" required /></label>
            <div class="resource-url-field"><label for="resource-video-url">视频地址</label><div class="resource-url-actions"><button class="text-button icon-text" type="button" :disabled="busy" @click="ossUploadOpen = true"><CloudUpload :size="15" />上传文件</button><button class="text-button" type="button" :disabled="busy" @click="ossPickerOpen = true">从 OSS 选择</button></div><input id="resource-video-url" v-model="url" type="url" placeholder="MP4 / WebM / M3U8 链接" required /></div>
            <label><span>海报地址（可选）</span><input v-model="poster" type="url" /></label>
            <label><span>简介（可选）</span><textarea v-model="description" maxlength="500" rows="3"></textarea></label>
            <div class="admin-actions"><button class="primary-button" type="submit" :disabled="busy">保存资源</button><button v-if="editingResource" class="secondary-button" type="button" @click="clearResourceForm">取消</button></div>
          </form>
        </section>
        <section class="admin-card"><div class="section-title"><h2>资源列表</h2><span class="count-badge">{{ resources.length }}</span></div>
          <p v-if="!resources.length" class="empty-note">添加链接、上传视频，或从网络来源采集。</p>
          <div class="resource-picker"><div v-for="resource in resources" :key="resource.id" class="admin-row"><div><strong>{{ resource.title }}</strong><small>{{ resource.source }} · {{ resource.enabled ? '已公开' : '已停用' }}</small></div><div class="admin-actions"><button class="secondary-button" type="button" :disabled="busy" @click="editResource(resource)">编辑</button><button class="secondary-button" type="button" :disabled="busy" @click="toggleResource(resource)">{{ resource.enabled ? '停用' : '公开' }}</button><button class="text-button danger-text" type="button" :disabled="busy" @click="deleteResource(resource)">删除</button></div></div></div>
        </section>
      </div>
      <template v-if="activeSection === 'sources'">
        <section class="admin-card"><div class="section-title"><Radio :size="20" /><h2>快捷添加资源站</h2></div><p class="admin-muted">添加后可在后台检索。公开资源可免登录浏览，登录后即可开房。</p>
          <div class="preset-grid"><article v-for="preset in presets" :key="preset.url" class="preset-card"><span class="source-avatar"><Radio :size="22" /></span><div><strong>{{ preset.name }}</strong><small>{{ preset.description }}</small></div><button class="secondary-button" type="button" :disabled="busy || sources.some(source => source.url === preset.url)" @click="addPreset(preset)">{{ sources.some(source => source.url === preset.url) ? '已添加' : '一键添加' }}</button></article></div>
        </section>
        <div class="admin-section-grid">
          <section class="admin-card"><h2>{{ sourceEditingId ? '编辑来源' : '自定义来源' }}</h2><form class="admin-form" @submit.prevent="saveSource"><label><span>来源名称</span><input v-model="sourceDraft.name" maxlength="40" required /></label><label><span>苹果 CMS V10 接口地址</span><input v-model="sourceDraft.url" type="url" maxlength="2048" placeholder="https://example.com/api.php/provide/vod/" required /></label><label class="admin-checkbox"><input v-model="sourceDraft.public" type="checkbox" /><span>公开资源检索</span></label><div class="admin-actions"><button class="primary-button" type="submit" :disabled="busy">{{ sourceEditingId ? '保存来源' : '添加来源' }}</button><button v-if="sourceEditingId" class="secondary-button" type="button" @click="resetSource">取消</button></div></form></section>
          <section class="admin-card"><h2>已添加的来源</h2><div v-for="source in sources" :key="source.id" class="admin-row"><div><strong>{{ source.name }}</strong><small>{{ source.enabled ? '已启用' : '已停用' }} · {{ source.public ? '资源已公开' : '仅后台' }}</small></div><div class="admin-actions"><button class="secondary-button" type="button" :disabled="busy" @click="editSource(source)">编辑</button><button class="secondary-button" type="button" :disabled="busy" @click="toggleSource(source, 'public')">{{ source.public ? '隐藏' : '公开' }}</button><button class="secondary-button" type="button" :disabled="busy" @click="toggleSource(source, 'enabled')">{{ source.enabled ? '停用' : '启用' }}</button><button class="text-button danger-text" type="button" :disabled="busy" @click="deleteSource(source)">删除</button></div></div></section>
        </div>
        <section class="admin-card"><ResourceBrowser :sources="enabledSources" :published-urls="publishedUrls" admin :admin-token="token" :disabled="busy" @select="importResource" @import-series="importSeries" /></section>
      </template>
      <OssManager v-if="activeSection === 'oss'" :config="ossConfig" :token="token" :resources="resources" @changed="run(refresh)" />
      <SiteSettings v-if="activeSection === 'settings'" :settings="siteSettings" :token="token" @changed="updateSettings" />
      <OssFilePicker v-if="ossPickerOpen" :config="ossConfig" :token="token" @select="selectOssFile" @close="ossPickerOpen = false" />
      <OssUploadDialog v-if="ossUploadOpen" :config="ossConfig" :token="token" @uploaded="uploadedOssFile" @close="ossUploadOpen = false" />
    </template>
  </section>
</template>
