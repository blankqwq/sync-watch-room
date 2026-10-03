<script setup>
import { ref } from "vue";
import { X, UserRound } from "lucide-vue-next";
import { requestJson } from "./api.js";

const emit = defineEmits(["authenticated"]);
const dialog = ref(null);
const mode = ref("login");
const username = ref("");
const name = ref("");
const password = ref("");
const error = ref("");
const busy = ref(false);
function open() { error.value = ""; dialog.value?.showModal(); }
function close() { dialog.value?.close(); password.value = ""; }
async function submit() {
  busy.value = true; error.value = "";
  try {
    const data = await requestJson(`/api/auth/${mode.value}`, "", { method: "POST", body: JSON.stringify({ username: username.value, password: password.value, name: name.value }) });
    close(); emit("authenticated", data.user);
  } catch (cause) { error.value = cause.message; } finally { busy.value = false; }
}
defineExpose({ open, close });
</script>

<template>
  <dialog ref="dialog" class="account-dialog" @click="event => { if (event.target === dialog) close(); }">
    <form class="account-form" @submit.prevent="submit"><div class="dialog-heading"><span class="join-symbol"><UserRound :size="25" /></span><button class="icon-button" type="button" aria-label="关闭账户登录" @click="close"><X :size="18" /></button></div><div><h2>{{ mode === 'login' ? '欢迎回来' : '开始你的同频时光' }}</h2><p class="admin-muted">登录后，观看记录和进度会跟着你。</p></div><div class="workspace-tabs"><button type="button" :class="{ active: mode === 'login' }" @click="mode = 'login'; error = ''">登录</button><button type="button" :class="{ active: mode === 'register' }" @click="mode = 'register'; error = ''">创建账户</button></div><label><span>用户名</span><input v-model="username" autocomplete="username" minlength="2" maxlength="24" placeholder="2–24 位字母、数字或中文" required /></label><label v-if="mode === 'register'"><span>昵称（可选）</span><input v-model="name" autocomplete="nickname" maxlength="24" placeholder="朋友们怎么称呼你" /></label><label><span>密码</span><input v-model="password" type="password" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" minlength="8" maxlength="128" placeholder="至少 8 位" required /></label><p v-if="error" class="admin-error" role="alert">{{ error }}</p><button class="primary-button" type="submit" :disabled="busy">{{ busy ? '请稍候…' : mode === 'login' ? '登录并继续' : '创建账户' }}</button></form>
  </dialog>
</template>
