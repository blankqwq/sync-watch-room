<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue";
import { CloudUpload, X } from "lucide-vue-next";
import { uploadOssFile } from "./oss-upload.js";

const props = defineProps({ config: Object, token: String });
const emit = defineEmits(["uploaded", "close"]);
const dialog = ref(null);
const fileInput = ref(null);
const busy = ref(false);
const progress = ref(0);
const error = ref("");
const controller = new AbortController();

async function upload() {
  const file = fileInput.value?.files[0];
  if (!file || busy.value) return;
  busy.value = true; error.value = ""; progress.value = 0;
  try {
    const uploaded = await uploadOssFile(file, props.token, { publish: false, signal: controller.signal, onProgress: (value) => { progress.value = value; } });
    if (controller.signal.aborted) return;
    emit("uploaded", uploaded);
    dialog.value.close();
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause.message;
  } finally { busy.value = false; }
}
onMounted(() => dialog.value.showModal());
onBeforeUnmount(() => controller.abort());
</script>

<template>
  <dialog ref="dialog" class="resource-detail-dialog oss-picker-dialog" aria-labelledby="oss-upload-heading" @close="emit('close')">
    <div class="dialog-heading"><h2 id="oss-upload-heading"><CloudUpload :size="22" />上传视频文件</h2><button class="icon-button" type="button" aria-label="关闭上传" @click="dialog.close()"><X :size="20" /></button></div>
    <template v-if="config.enabled">
      <p class="admin-muted">上传到 {{ config.bucket }}，完成后自动填入视频地址。</p>
      <form class="upload-form" @submit.prevent="upload">
        <label class="upload-drop"><CloudUpload :size="28" /><span>选择 MP4 / WebM 视频，最多 1 GiB</span><input ref="fileInput" aria-label="视频文件" type="file" accept=".mp4,.webm" required :disabled="busy" @change="error = ''" /></label>
        <div v-if="busy" class="upload-progress" role="status"><progress :value="progress" max="100" aria-label="上传进度"></progress><span>{{ progress < 100 ? `正在上传 ${progress}%` : '上传完成，正在确认文件…' }}</span></div>
        <p v-if="error" class="admin-error" role="alert">{{ error }}</p>
        <div class="admin-actions"><button class="primary-button" type="submit" :disabled="busy">{{ busy ? '上传中…' : '上传并使用' }}</button><button class="secondary-button" type="button" @click="dialog.close()">{{ busy ? '取消上传' : '取消' }}</button></div>
      </form>
    </template>
    <div v-else class="empty-state"><CloudUpload :size="36" /><h3>尚未配置 OSS</h3><p>在服务器 .env 中填写 OSS 配置并重启后端，即可直接上传文件。</p><div class="config-keys"><code>OSS_REGION</code><code>OSS_BUCKET</code><code>OSS_ACCESS_KEY_ID</code><code>OSS_ACCESS_KEY_SECRET</code><code>OSS_PUBLIC_URL</code></div></div>
  </dialog>
</template>
