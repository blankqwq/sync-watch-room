<script setup>
import { ref, watch } from "vue";
const props = defineProps({ src: String });
const failed = ref(false);
watch(() => props.src, () => { failed.value = false; });
</script>

<template>
  <img class="app-icon" :src="failed || !src ? '/couple-tv-icon.png' : src" alt="" referrerpolicy="no-referrer" @error="failed = true" />
</template>
