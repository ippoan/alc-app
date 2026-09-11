<script setup lang="ts">
import type { ApiMeasurement } from '~/types'
import { fetchFacePhoto, fetchMeasurementVideo } from '~/utils/api'

const props = defineProps<{
  measurement: ApiMeasurement
  employeeName: string
}>()

const emit = defineEmits<{
  close: []
}>()

const facePhotoUrl = ref<string | null>(null)
const isLoadingPhoto = ref(false)

const videoUrl = ref<string | null>(null)
const isLoadingVideo = ref(false)

async function loadFacePhoto() {
  if (!props.measurement.face_photo_url) return
  isLoadingPhoto.value = true
  try {
    facePhotoUrl.value = await fetchFacePhoto(props.measurement.id)
  } finally {
    isLoadingPhoto.value = false
  }
}

async function loadVideo() {
  if (!props.measurement.video_url) return
  isLoadingVideo.value = true
  try {
    videoUrl.value = await fetchMeasurementVideo(props.measurement.id)
  } finally {
    isLoadingVideo.value = false
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
  loadFacePhoto()
  loadVideo()
  document.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  if (facePhotoUrl.value) {
    URL.revokeObjectURL(facePhotoUrl.value)
  }
  if (videoUrl.value) {
    URL.revokeObjectURL(videoUrl.value)
  }
  document.removeEventListener('keydown', onKeydown)
})

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

function onBackdropClick(e: MouseEvent) {
  if (e.target === e.currentTarget) emit('close')
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function resultLabel(type: string) {
  switch (type) {
    case 'normal': return '正常'
    case 'over': return '基準超'
    case 'error': return 'エラー'
    default: return type
  }
}

function resultColor(type: string) {
  switch (type) {
    case 'normal': return 'bg-green-100 text-green-800'
    case 'over': return 'bg-red-100 text-red-800'
    case 'error': return 'bg-yellow-100 text-yellow-800'
    default: return 'bg-gray-100 text-gray-800'
  }
}

function statusLabel(m: ApiMeasurement) {
  if (m.status === 'completed') return '完了'
  if (m.face_photo_url) return '顔認証済'
  return '開始'
}

function statusColor(m: ApiMeasurement) {
  if (m.status === 'completed') return 'bg-green-100 text-green-800'
  if (m.face_photo_url) return 'bg-blue-100 text-blue-800'
  return 'bg-gray-100 text-gray-600'
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    @click="onBackdropClick"
  >
    <div class="bg-white rounded-2xl shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
      <!-- ヘッダー -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <h2 class="text-lg font-semibold text-gray-800">測定詳細</h2>
        <button
          class="p-1 text-gray-400 hover:text-gray-600 transition-colors"
          @click="emit('close')"
        >
          <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="p-6 space-y-5">
        <!-- 顔写真 -->
        <div class="flex justify-center">
          <div v-if="isLoadingPhoto" class="w-32 h-32 rounded-xl bg-gray-200 animate-pulse" />
          <img
            v-else-if="facePhotoUrl"
            :src="facePhotoUrl"
            alt="認証時の顔写真"
            class="w-32 h-32 rounded-xl object-cover shadow-sm"
          >
          <div
            v-else
            class="w-32 h-32 rounded-xl bg-gray-100 flex items-center justify-center text-gray-400"
          >
            <svg class="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" />
            </svg>
          </div>
        </div>

        <!-- 基本情報 -->
        <div class="space-y-3">
          <div class="flex justify-between items-center">
            <span class="text-sm text-gray-500">乗務員</span>
            <span class="font-medium text-gray-800">{{ employeeName }}</span>
          </div>
          <div class="flex justify-between items-center">
            <span class="text-sm text-gray-500">測定日時</span>
            <span class="text-sm text-gray-700">{{ formatDate(measurement.measured_at) }}</span>
          </div>
          <div class="flex justify-between items-center">
            <span class="text-sm text-gray-500">状態</span>
            <span
              class="inline-block px-2 py-1 rounded-full text-xs font-medium"
              :class="statusColor(measurement)"
            >
              {{ statusLabel(measurement) }}
            </span>
          </div>
        </div>

        <!-- 録画 -->
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

        <!-- アルコール検査 -->
        <div class="bg-gray-50 rounded-xl p-4 space-y-3">
          <p class="text-xs text-gray-400 font-medium">アルコール検査</p>
          <div class="flex justify-between items-center">
            <span class="text-sm text-gray-500">アルコール値</span>
            <span class="font-mono font-bold text-lg text-gray-800">
              {{ measurement.alcohol_value != null ? measurement.alcohol_value.toFixed(3) + ' mg/L' : '-' }}
            </span>
          </div>
          <div class="flex justify-between items-center">
            <span class="text-sm text-gray-500">結果</span>
            <span
              v-if="measurement.result_type"
              class="inline-block px-2 py-1 rounded-full text-xs font-medium"
              :class="resultColor(measurement.result_type)"
            >
              {{ resultLabel(measurement.result_type) }}
            </span>
            <span v-else class="text-gray-400 text-xs">-</span>
          </div>
          <div class="flex justify-between items-center">
            <span class="text-sm text-gray-500">使用回数</span>
            <span class="font-mono text-gray-700">{{ measurement.device_use_count }} 回</span>
          </div>
        </div>

        <!-- 医療データ -->
        <div
          v-if="measurement.temperature != null || measurement.systolic != null || measurement.pulse != null"
          class="bg-gray-50 rounded-xl p-4 space-y-3"
        >
          <p class="text-xs text-gray-400 font-medium">医療データ</p>
          <div v-if="measurement.temperature != null" class="flex justify-between items-center">
            <span class="text-sm text-gray-500">体温</span>
            <span class="font-mono font-medium text-gray-700">{{ measurement.temperature.toFixed(1) }} &#8451;</span>
          </div>
          <div v-if="measurement.systolic != null" class="flex justify-between items-center">
            <span class="text-sm text-gray-500">血圧</span>
            <span class="font-mono font-medium text-gray-700">{{ measurement.systolic }}/{{ measurement.diastolic }}</span>
          </div>
          <div v-if="measurement.pulse != null" class="flex justify-between items-center">
            <span class="text-sm text-gray-500">脈拍</span>
            <span class="font-mono font-medium text-gray-700">{{ measurement.pulse }} bpm</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
