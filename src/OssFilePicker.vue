<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue";
import { CloudUpload, FileVideo, X } from "lucide-vue-next";
import { requestJson } from "./api.js";

const props = defineProps({ config: Object, token: String });
const emit = defineEmits(["select", "close"]);
const dialog = ref(null);
const prefix = ref("videos/");
const files = ref([]);
const nextToken = ref("");
const busy = ref(false);
const error = ref("");
const controller = new AbortController();
let loadedPrefix = "";

function sizeLabel(size) {
  return size >= 1073741824 ? `${(size / 1073741824).toFixed(2)} GB` : `${(size / 1048576).toFixed(1)} MB`;
}

async function load(token = "") {
  if (!props.config.enabled || busy.value) return;
  busy.value = true; error.value = "";
  if (!token) { files.value = []; nextToken.value = ""; loadedPrefix = prefix.value; }
  try {
    const data = await requestJson(`/api/admin/oss/files?${new URLSearchParams({ prefix: loadedPrefix, token })}`, props.token, { signal: controller.signal });
    files.value = token ? [...files.value, ...data.files] : data.files;
    nextToken.value = data.nextToken;
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause.message;
  } finally { busy.value = false; }
}

function select(file) { emit("select", file); dialog.value.close(); }
onMounted(() => { dialog.value.showModal(); load(); });
onBeforeUnmount(() => controller.abort());
</script>

<template>
  <dialog ref="dialog" class="resource-detail-dialog oss-picker-dialog" aria-labelledby="oss-picker-heading" @close="emit('close')">
    <div class="dialog-heading"><h2 id="oss-picker-heading"><CloudUpload :size="22" />从 OSS 选择视频</h2><button class="icon-button" type="button" aria-label="关闭 OSS 选择" @click="dialog.close()"><X :size="20" /></button></div>
    <template v-if="config.enabled">
      <p class="admin-muted">{{ config.bucket }} · {{ config.region }}</p>
      <form class="storage-search" @submit.prevent="load()"><input v-model="prefix" aria-label="OSS 文件前缀" placeholder="文件前缀，留空查看全部" :disabled="busy" /><button class="secondary-button" type="submit" :disabled="busy">筛选</button></form>
      <p v-if="error" class="admin-error" role="alert">{{ error }}</p>
      <div class="oss-picker-files">
        <div v-for="file in files" :key="file.key" class="admin-row">
          <div class="file-row"><FileVideo :size="24" /><div><strong>{{ file.key }}</strong><small>{{ sizeLabel(file.size) }}</small></div></div>
          <button class="secondary-button" type="button" :aria-label="`选择 ${file.key}`" @click="select(file)">选择</button>
        </div>
        <p v-if="busy" class="empty-note" role="status">正在加载视频文件…</p>
        <p v-else-if="!files.length && !error" class="empty-note">当前页没有视频文件，可调整前缀或查看下一页。</p>
      </div>
      <button v-if="nextToken" class="secondary-button" type="button" :disabled="busy" @click="load(nextToken)">加载更多</button>
    </template>
    <div v-else class="empty-state"><CloudUpload :size="36" /><h3>尚未配置 OSS</h3><p>在服务器 .env 中填写以下配置并重启后端，即可选择桶内视频。</p><div class="config-keys"><code>OSS_REGION</code><code>OSS_BUCKET</code><code>OSS_ACCESS_KEY_ID</code><code>OSS_ACCESS_KEY_SECRET</code><code>OSS_PUBLIC_URL</code></div></div>
  </dialog>
</template>
