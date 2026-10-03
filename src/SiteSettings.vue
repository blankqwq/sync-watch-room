<script setup>
import { ref } from "vue";
import { RotateCcw, Save } from "lucide-vue-next";
import AppIcon from "./AppIcon.vue";
import { requestJson } from "./api.js";

const props = defineProps({ token: String, settings: Object });
const emit = defineEmits(["changed"]);
const draft = ref({ ...props.settings });
const busy = ref(false);
const error = ref("");
const saved = ref(false);

function changed() { saved.value = false; error.value = ""; }

async function chooseIcon(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  changed();
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 512 * 1024) {
    error.value = "请选择不超过 512 KB 的 PNG、JPEG 或 WebP 图片";
    return;
  }
  busy.value = true;
  try {
    draft.value.icon = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("图片读取失败，请重新选择"));
      reader.readAsDataURL(file);
    });
  } catch (cause) { error.value = cause.message; }
  finally { busy.value = false; }
}

function resetIcon() { changed(); draft.value.icon = "/couple-tv-icon.png"; }

async function save() {
  if (busy.value) return;
  changed();
  busy.value = true;
  try {
    const result = await requestJson("/api/admin/settings", props.token, { method: "PUT", body: JSON.stringify(draft.value) });
    draft.value = result.settings;
    saved.value = true;
    emit("changed", result.settings);
  } catch (cause) { error.value = cause.message; }
  finally { busy.value = false; }
}
</script>

<template>
  <section class="admin-card site-settings">
    <div class="admin-heading"><div><h2>应用名称与图标</h2><p class="admin-muted">让放映室有自己的名字，保存后会更新首页和浏览器页签。</p></div></div>
    <div class="site-brand-preview"><AppIcon :src="draft.icon" /><strong>{{ draft.name || '你的放映室' }}</strong><small>效果预览</small></div>
    <form class="admin-form" @submit.prevent="save">
      <label><span>应用名称</span><input v-model="draft.name" maxlength="24" required :disabled="busy" @input="changed" /></label>
      <label><span>上传图标</span><input type="file" accept="image/png,image/jpeg,image/webp" :disabled="busy" @change="chooseIcon" /><small class="admin-muted">建议正方形图片，支持 PNG、JPEG、WebP，最大 512 KB。</small></label>
      <label v-if="!draft.icon?.startsWith('data:')"><span>图标图片地址</span><input v-model="draft.icon" placeholder="https://example.com/icon.png" :disabled="busy" @input="changed" /></label>
      <p v-else class="admin-muted">已选择上传的图标，可重新上传或恢复默认图标。</p>
      <p v-if="error" class="admin-error" role="alert">{{ error }}</p>
      <p v-if="saved" class="notice" role="status">设置已保存</p>
      <div class="admin-actions"><button class="primary-button icon-text" type="submit" :disabled="busy"><Save :size="15" />{{ busy ? '保存中…' : '保存设置' }}</button><button class="secondary-button icon-text" type="button" :disabled="busy" @click="resetIcon"><RotateCcw :size="15" />恢复默认图标</button></div>
    </form>
  </section>
</template>
