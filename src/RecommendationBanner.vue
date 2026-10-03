<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ChevronLeft, ChevronRight, Pause, Play, Sparkles } from "lucide-vue-next";
import CoverImage from "./CoverImage.vue";

const props = defineProps({ items: { type: Array, default: () => [] }, disabled: Boolean });
const emit = defineEmits(["select"]);
const index = ref(0);
const paused = ref(false);
const hovered = ref(false);
const focused = ref(false);
const active = computed(() => props.items[index.value] || props.items[0]);
const metadata = computed(() => [active.value?.year, active.value?.category, active.value?.remarks || (active.value?.items?.length > 1 ? `${active.value.items.length} 集` : "")].filter(Boolean).join(" · "));
let timer = null;

function move(offset) { index.value = (index.value + offset + props.items.length) % props.items.length; }
watch(() => props.items.map(item => `${item.kind}:${item.id}`).join("|"), () => { index.value = 0; });
onMounted(() => {
  paused.value = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  timer = setInterval(() => {
    if (props.items.length > 1 && !paused.value && !hovered.value && !focused.value && !props.disabled && document.visibilityState === "visible") move(1);
  }, 6000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <section v-if="active" class="recommendation-banner" aria-label="资源推荐" aria-roledescription="轮播" @mouseenter="hovered = true" @mouseleave="hovered = false" @focusin="focused = true" @focusout="event => { focused = event.currentTarget.contains(event.relatedTarget); }" @keydown.left.prevent="move(-1)" @keydown.right.prevent="move(1)">
    <div class="recommendation-backdrop" aria-hidden="true"><CoverImage :src="active.poster" :title="active.title" compact /></div>
    <div class="recommendation-shade"></div>
    <div class="recommendation-copy">
      <span class="recommendation-tag"><Sparkles :size="13" />精选推荐</span>
      <h2 :title="active.title">{{ active.title }}</h2>
      <p v-if="metadata" class="recommendation-meta" :title="metadata">{{ metadata }}</p>
      <p v-if="active.description" class="recommendation-description" :title="active.description">{{ active.description }}</p>
      <button class="primary-button icon-text" type="button" :disabled="disabled" @click="emit('select', active)"><Play :size="15" fill="currentColor" />{{ active.kind === 'library' && active.items.length === 1 ? '一起看' : '选集观看' }}</button>
    </div>
    <div class="recommendation-poster"><CoverImage :src="active.poster" :title="active.title" compact /></div>
    <template v-if="items.length > 1">
      <div class="recommendation-dots"><button v-for="(item, position) in items" :key="`${item.kind}:${item.id}`" type="button" :class="{ active: index === position }" :aria-label="`推荐 ${position + 1}：${item.title}`" :aria-current="index === position ? 'true' : undefined" @click="index = position"></button></div>
      <div class="recommendation-controls"><span>{{ index + 1 }} / {{ items.length }}</span><button type="button" :aria-label="paused ? '开启自动轮播' : '暂停自动轮播'" :aria-pressed="paused" @click="paused = !paused"><Play v-if="paused" :size="14" /><Pause v-else :size="14" /></button><button type="button" aria-label="上一条推荐" @click="move(-1)"><ChevronLeft :size="18" /></button><button type="button" aria-label="下一条推荐" @click="move(1)"><ChevronRight :size="18" /></button></div>
    </template>
  </section>
</template>
