<script setup lang="ts">
import type { ApiMeasurement } from '~/types'
import { fetchMeasurementVideo } from '~/utils/api'

const props = defineProps<{
  measurement: ApiMeasurement
}>()

const videoUrl = ref<string | null>(null)
const isLoadingVideo = ref(false)

let unmounted = false

async function loadVideo() {
  if (!props.measurement.video_url) return
  isLoadingVideo.value = true
  try {
    const url = await fetchMeasurementVideo(props.measurement.id)
    if (unmounted) {
      if (url) URL.revokeObjectURL(url)
      return
    }
    videoUrl.value = url
  } finally {
    if (!unmounted) isLoadingVideo.value = false
  }
}

/** MediaRecorder で録った webm は長さの情報を持たず `duration === Infinity` になり、
 * シークバーが効かない。既知の回避: 一度末尾近くまで seek すると duration が確定する。 */
function onVideoLoadedMetadata(e: Event) {
  const video = e.target as HTMLVideoElement
  if (video.duration === Infinity) {
    video.currentTime = 1e101
  }
}

function onVideoTimeUpdate(e: Event) {
  const video = e.target as HTMLVideoElement
  if (video.currentTime > 1e100) {
    video.currentTime = 0
  }
}

onMounted(() => {
  loadVideo()
})

onUnmounted(() => {
  unmounted = true
  if (videoUrl.value) {
    URL.revokeObjectURL(videoUrl.value)
  }
})
</script>

<template>
  <div v-if="measurement.video_url" class="space-y-2">
    <p class="text-xs text-gray-400 font-medium">録画</p>
    <div v-if="isLoadingVideo" class="text-sm text-gray-400">読み込み中…</div>
    <video
      v-else-if="videoUrl"
      :src="videoUrl"
      controls
      playsinline
      preload="metadata"
      class="w-full aspect-video rounded-lg bg-black"
      @loadedmetadata="onVideoLoadedMetadata"
      @timeupdate="onVideoTimeUpdate"
    />
    <div v-else class="text-sm text-gray-400">録画を読み込めませんでした</div>
  </div>
</template>
