<script setup>
import { ref, watch } from "vue";
import { Film } from "lucide-vue-next";
const props = defineProps({ src: String, title: String, compact: Boolean });
const failed = ref(false);
watch(() => props.src, () => { failed.value = false; });
</script>
<template>
  <img v-if="src && !failed" :src="src" :alt="title" loading="lazy" referrerpolicy="no-referrer" @error="failed = true" />
  <template v-else><Film :size="compact ? 22 : 35" /><span v-if="!compact" :title="title">{{ title }}</span></template>
</template>
