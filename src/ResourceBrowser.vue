<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { X, Film, ListVideo, Play, LayoutGrid, List } from "lucide-vue-next";
import CoverImage from "./CoverImage.vue";
import { requestJson } from "./api.js";
import { checkMediaAvailability, isMediaUnavailable, isResourceUnavailable, registerMediaResource } from "./media-availability.js";

const props = defineProps({
  sources: { type: Array, default: () => [] },
  publishedUrls: { type: Array, default: () => [] },
  admin: Boolean,
  adminToken: String,
  disabled: Boolean,
});
const emit = defineEmits(["select", "import-series", "recommendations"]);
const layout = ref("grid");
const selectedLine = ref("");
const lines = computed(() => [...new Set(detail.value?.episodes.filter(episode => !isMediaUnavailable(episode.url)).map((episode) => episode.source) || [])]);
const episodes = computed(() => detail.value?.episodes.filter((episode) => episode.source === selectedLine.value && !isMediaUnavailable(episode.url)) || []);
const selectedSource = ref("");
const keyword = ref("");
const results = ref([]);
const visibleResults = computed(() => results.value.filter(item => !isResourceUnavailable(item.id)));
const checkingEpisode = ref(false);
const page = ref(1);
const pagecount = ref(1);
const detail = ref(null);
const detailDialog = ref(null);
const error = ref("");
const busy = ref(false);
let controller = null;
let disposed = false;

async function load(parameters) {
  controller?.abort();
  const requestController = new AbortController();
  controller = requestController;
  busy.value = true;
  error.value = "";
  try {
    const params = new URLSearchParams({ source: selectedSource.value, ...parameters });
    const data = await requestJson(`${props.admin ? '/api/admin/maccms' : '/api/discover'}?${params}`, props.admin ? props.adminToken : "", { signal: requestController.signal });
    if (requestController.signal.aborted) return;
    if (parameters.id) {
      detail.value = data.list[0] || null;
      if (!detail.value) throw new Error("未找到资源详情");
      registerMediaResource(detail.value.id, detail.value.episodes.map(episode => episode.url));
      const firstEpisodes = [...new Set(detail.value.episodes.map(episode => episode.source))].map(line => detail.value.episodes.find(episode => episode.source === line));
      await Promise.all(firstEpisodes.map(episode => checkMediaAvailability(episode.url).catch(() => {})));
      if (requestController.signal.aborted || disposed) return;
      if (!lines.value.length) throw new Error("这个资源没有可加载的线路，已跳过");
      selectedLine.value = lines.value[0] || "";
      await nextTick();
      detailDialog.value?.showModal();
    } else {
      results.value = data.list;
      if (!props.admin && !parameters.keyword && Number(parameters.page || 1) === 1) emit("recommendations", data.list.slice(0, 5));
      page.value = data.page;
      pagecount.value = data.pagecount;
    }
  } catch (cause) {
    if (!requestController.signal.aborted) error.value = cause.message;
  } finally {
    if (controller === requestController) busy.value = false;
  }
}

function search(nextPage = 1) {
  if (!selectedSource.value) return;
  load({ keyword: keyword.value, page: String(nextPage) });
}

function inspectResource(item) { return load({ id: item.id }); }
defineExpose({ inspectResource });

async function selectEpisode(episode) {
  if (checkingEpisode.value) return;
  const selectedDetail = detail.value;
  checkingEpisode.value = true; error.value = "";
  try { await checkMediaAvailability(episode.url); }
  catch (cause) { error.value = cause.message; selectedLine.value = lines.value.includes(selectedLine.value) ? selectedLine.value : lines.value[0] || ""; return; }
  finally { checkingEpisode.value = false; }
  if (disposed || detail.value !== selectedDetail) return;
  emit("select", {
    title: `${detail.value.title} · ${episode.label}`,
    url: episode.url,
    poster: detail.value.poster,
    description: detail.value.description,
    source: props.sources.find((source) => source.id === selectedSource.value)?.name || "MacCMS",
    selectionId: detail.value.playlists?.find((playlist) => playlist.line === selectedLine.value)?.selectionId,
    playlistIndex: detail.value.episodes.filter(item => item.source === selectedLine.value).findIndex((item) => item.url === episode.url),
    seriesTitle: detail.value.title,
    year: detail.value.year,
    episodeLabel: episode.label,
    episodeCount: detail.value.episodes.filter(item => item.source === selectedLine.value).length,
    doubanId: detail.value.doubanId,
    networkReferences: detail.value.reference ? [detail.value.reference] : [],
  });
  if (!props.admin) detailDialog.value?.close();
}

async function importSeries() {
  if (checkingEpisode.value) return;
  checkingEpisode.value = true; error.value = "";
  const selected = [...episodes.value];
  const selectedDetail = detail.value;
  const available = new Set();
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
    while (index < selected.length && !disposed && detail.value === selectedDetail) {
      const episode = selected[index++];
      try { await checkMediaAvailability(episode.url); available.add(episode.url); } catch { /* Skip broken HLS episodes. */ }
    }
  }));
  checkingEpisode.value = false;
  if (disposed || detail.value !== selectedDetail) return;
  const valid = selected.filter(episode => available.has(episode.url));
  if (!valid.length) { error.value = "没有可入库的有效片源"; return; }
  emit("import-series", valid.map((episode) => ({
      title: `${detail.value.title} · ${episode.label}`, url: episode.url, poster: detail.value.poster,
      description: detail.value.description,
      source: props.sources.find((source) => source.id === selectedSource.value)?.name || "MacCMS",
      seriesTitle: detail.value.title, year: detail.value.year, episodeLabel: episode.label,
      episodeCount: selected.length, doubanId: detail.value.doubanId,
      networkReferences: detail.value.reference ? [detail.value.reference] : [],
    })));
  detailDialog.value?.close();
}

watch(() => props.sources.map((source) => `${source.id}:${source.url || ''}:${source.updatedAt || 0}`).join("|"), () => {
  const sources = props.sources;
  if (!sources.some((source) => source.id === selectedSource.value)) selectedSource.value = sources[0]?.id || "";
  else {
    detail.value = null;
    detailDialog.value?.close();
    results.value = [];
    search();
  }
}, { immediate: true });

watch(selectedSource, () => {
  controller?.abort();
  results.value = [];
  detail.value = null;
  detailDialog.value?.close();
  search();
}, { immediate: true });

onBeforeUnmount(() => { disposed = true; controller?.abort(); });
</script>

<template>
  <section v-if="sources.length" class="resource-browser">
    <div v-if="admin" class="section-intro"><div><h2>检索与采集</h2><p>选择分集或整部入库，资源库会自动归并剧集。</p></div><div class="view-switch"><button class="icon-button" :class="{ active: layout === 'list' }" type="button" aria-label="片源列表视图" @click="layout = 'list'"><List :size="17" /></button><button class="icon-button" :class="{ active: layout === 'grid' }" type="button" aria-label="片源卡片视图" @click="layout = 'grid'"><LayoutGrid :size="17" /></button></div></div>
    <form class="admin-search" :class="{ 'unified-search': !admin }" @submit.prevent="search(1)"><label v-if="admin"><span>资源来源</span><select v-model="selectedSource"><option v-for="source in sources" :key="source.id" :value="source.id">{{ source.name }}</option></select></label><label><span v-if="admin">片名</span><input v-model="keyword" type="search" maxlength="100" :aria-label="admin ? '片名' : '搜索片名'" :placeholder="admin ? '搜索片名，留空浏览最新' : '搜索影片或剧集'" /></label><button class="primary-button" type="submit" :disabled="busy">{{ busy ? '加载中…' : '搜索' }}</button><button v-if="!admin" class="icon-button" type="button" :aria-label="layout === 'list' ? '片源卡片视图' : '片源列表视图'" :title="layout === 'list' ? '切换为卡片视图' : '切换为列表视图'" @click="layout = layout === 'list' ? 'grid' : 'list'"><LayoutGrid v-if="layout === 'list'" :size="17" /><List v-else :size="17" /></button></form>
    <p v-if="error" class="admin-error" role="alert">{{ error }}</p><p v-else-if="!busy && !visibleResults.length" class="empty-note">没有匹配的片源，换一个名字试试。</p>
    <div class="network-results" :class="{ 'network-grid': layout === 'grid' }">
      <article v-for="(item, index) in visibleResults" :key="item.id" class="network-item"><div class="network-poster" :class="`cover-tone-${index % 4}`"><CoverImage :src="item.poster" :title="item.title" compact /></div><div class="network-copy"><h3 :title="item.title">{{ item.title }}</h3><span :title="[item.year, item.category, item.remarks].filter(Boolean).join(' · ')">{{ [item.year, item.category, item.remarks].filter(Boolean).join(' · ') || '可选择分集与线路' }}</span></div><button class="secondary-button icon-text" type="button" :disabled="busy" @click="load({ id: item.id })"><ListVideo :size="15" />选集</button></article>
    </div>
    <div v-if="visibleResults.length" class="resource-pagination admin-actions"><button class="secondary-button" type="button" :disabled="busy || page <= 1" @click="search(page - 1)">上一页</button><span>第 {{ page }} / {{ pagecount }} 页</span><button class="secondary-button" type="button" :disabled="busy || page >= pagecount" @click="search(page + 1)">下一页</button></div>
    <dialog ref="detailDialog" class="resource-detail-dialog" @click="event => { if (event.target === detailDialog) detailDialog.close(); }"><div v-if="detail" class="resource-detail">
      <div class="dialog-heading"><div><span class="eyebrow">{{ admin ? '整理你的片源' : '一起看这部' }}</span><h2>{{ detail.title }}</h2></div><button class="icon-button" type="button" aria-label="关闭资源详情" @click="detailDialog.close()"><X :size="18" /></button></div><div class="detail-cover-row"><span class="detail-poster"><CoverImage :src="detail.poster" :title="detail.title" compact /></span><p class="admin-muted">{{ detail.description || '选好一集，接下来的故事一起看。' }}</p></div>
      <div v-if="lines.length" class="episode-toolbar"><label><span>播放线路</span><select v-model="selectedLine" :disabled="checkingEpisode"><option v-for="line in lines" :key="line" :value="line">{{ line || '默认线路' }}</option></select></label><span>{{ episodes.length }} 集</span><button v-if="admin" class="primary-button icon-text" type="button" :disabled="disabled || checkingEpisode || !episodes.length || episodes.length > 300" @click="importSeries"><ListVideo :size="15" />整部入库</button><button v-else class="primary-button icon-text" type="button" :disabled="disabled || checkingEpisode || !episodes.length" @click="selectEpisode(episodes[0])"><Play :size="15" />开始观看</button></div>
      <p v-if="!episodes.length" class="empty-note">暂无可直接播放的分集。</p><p v-if="admin && episodes.length > 300" class="admin-muted">此线路超过 300 集，请分批逐集入库。</p>
      <p v-if="error" class="admin-error" role="alert">{{ error }}</p><p v-if="checkingEpisode" class="admin-muted" role="status">正在检查片源可用性…</p><div class="episode-grid"><button v-for="episode in episodes" :key="episode.url" class="episode-button" type="button" :disabled="disabled || checkingEpisode || (admin && publishedUrls.includes(episode.url))" @click="selectEpisode(episode)"><span>{{ episode.label }}</span><small>{{ admin ? publishedUrls.includes(episode.url) ? '已入库' : '加入资源库' : '一起看' }}</small></button></div>
    </div></dialog>
  </section>
</template>
