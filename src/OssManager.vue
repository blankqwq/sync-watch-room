<script setup>
import { onMounted, ref } from "vue";
import { CloudUpload, Copy, FileVideo, RefreshCw } from "lucide-vue-next";
import { requestJson } from "./api.js";
import { uploadOssFile } from "./oss-upload.js";

const props = defineProps({ config: Object, token: String, resources: Array });
const emit = defineEmits(["changed"]);
const files = ref([]);
const prefix = ref("videos/");
const nextToken = ref("");
const busy = ref(false);
const error = ref("");
const notice = ref("");
const uploadFile = ref(null);
const uploadTitle = ref("");
const uploadProgress = ref(0);

function sizeLabel(size) {
  return size >= 1073741824 ? `${(size / 1073741824).toFixed(2)} GB` : `${(size / 1048576).toFixed(1)} MB`;
}
function published(file) { return props.resources.some((resource) => resource.url === file.url); }
async function load(token = "") {
  if (!props.config.enabled) return;
  busy.value = true; error.value = "";
  try {
    const data = await requestJson(`/api/admin/oss/files?${new URLSearchParams({ prefix: prefix.value, token })}`, props.token);
    files.value = token ? [...files.value, ...data.files] : data.files;
    nextToken.value = data.nextToken;
  } catch (cause) { error.value = cause.message; } finally { busy.value = false; }
}
async function publish(file) {
  try {
    await requestJson("/api/admin/resources", props.token, { method: "POST", body: JSON.stringify({ title: file.key.split("/").pop(), url: file.url, source: "OSS" }) });
    notice.value = "已加入资源库，可在资源页面编辑名称和封面";
    emit("changed");
  } catch (cause) { error.value = cause.message; }
}
async function remove(file) {
  if (!confirm(`从 OSS 删除「${file.key}」？文件删除后可能无法恢复。`)) return;
  try {
    await requestJson(`/api/admin/oss/files?${new URLSearchParams({ key: file.key })}`, props.token, { method: "DELETE" });
    await load();
  } catch (cause) { error.value = cause.message; }
}
async function copy(file) {
  await navigator.clipboard.writeText(file.url);
  notice.value = "播放地址已复制";
}
async function upload() {
  const file = uploadFile.value?.files[0];
  if (!file || busy.value) return;
  busy.value = true; error.value = ""; notice.value = ""; uploadProgress.value = 0;
  try {
    await uploadOssFile(file, props.token, { title: uploadTitle.value.trim() || file.name, onProgress: (value) => { uploadProgress.value = value; } });
    uploadFile.value.value = ""; uploadTitle.value = "";
    notice.value = "上传完成，已发布到资源库";
    emit("changed");
    await load();
  } catch (cause) { error.value = cause.message; } finally { busy.value = false; }
}
onMounted(() => load());
</script>

<template>
  <section v-if="!config.enabled" class="admin-card empty-state">
    <CloudUpload :size="42" /><h2>连接阿里云 OSS</h2><p>配置后即可上传视频、浏览桶内文件、复制播放地址或发布到资源库。</p>
    <div class="config-keys"><code>OSS_REGION</code><code>OSS_BUCKET</code><code>OSS_ACCESS_KEY_ID</code><code>OSS_ACCESS_KEY_SECRET</code><code>OSS_PUBLIC_URL</code></div>
    <small>在服务器 .env 中填写这些配置，并重启后端。</small>
  </section>
  <template v-else>
    <div class="storage-status"><CloudUpload :size="24" /><div><strong>{{ config.bucket }}</strong><span>{{ config.region }} · 阿里云 OSS</span></div><span class="status-pill">已配置</span></div>
    <p v-if="error" class="admin-error" role="alert">{{ error }}</p><p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <section class="admin-card">
      <h2>上传视频</h2>
      <form class="upload-form" @submit.prevent="upload">
        <label><span>视频名称（可选）</span><input v-model="uploadTitle" maxlength="120" placeholder="留空使用文件名" /></label>
        <label class="upload-drop"><CloudUpload :size="28" /><span>选择 MP4 / WebM 视频，最多 1 GiB</span><input ref="uploadFile" type="file" accept=".mp4,.webm" required /></label>
        <button class="primary-button" type="submit" :disabled="busy">{{ busy ? `处理中 ${uploadProgress}%` : '上传并发布' }}</button>
      </form>
    </section>
    <section class="admin-card">
      <div class="admin-heading"><h2>视频文件</h2><button class="secondary-button icon-text" type="button" :disabled="busy" @click="load()"><RefreshCw :size="14" />刷新</button></div>
      <form class="storage-search" @submit.prevent="load()"><input v-model="prefix" placeholder="文件名前缀，留空查看全部" aria-label="OSS 文件前缀" /><button class="secondary-button" type="submit" :disabled="busy">筛选</button></form>
      <div v-for="file in files" :key="file.key" class="admin-row">
        <div class="file-row"><FileVideo :size="24" /><div><strong>{{ file.key }}</strong><small>{{ sizeLabel(file.size) }} · {{ new Date(file.modifiedAt).toLocaleString() }}</small></div></div>
        <div class="admin-actions"><button class="icon-button" type="button" aria-label="复制播放地址" @click="copy(file)"><Copy :size="16" /></button><button class="secondary-button" type="button" :disabled="published(file)" @click="publish(file)">{{ published(file) ? '已入库' : '加入资源库' }}</button><button class="text-button danger-text" type="button" :disabled="published(file)" @click="remove(file)">删除文件</button></div>
      </div>
      <p v-if="!files.length && !busy" class="empty-note">当前页没有视频文件，可调整前缀或查看下一页。</p>
      <button v-if="nextToken" class="secondary-button" type="button" :disabled="busy" @click="load(nextToken)">加载更多</button>
    </section>
  </template>
</template>
