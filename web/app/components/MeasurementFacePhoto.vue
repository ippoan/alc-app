<script setup lang="ts">
import type { ApiMeasurement } from '~/types'
import { fetchFacePhoto } from '~/utils/api'

const props = defineProps<{
  measurement: ApiMeasurement
}>()

const facePhotoUrl = ref<string | null>(null)
const isLoadingPhoto = ref(false)

let unmounted = false

async function loadFacePhoto() {
  if (!props.measurement.face_photo_url) return
  isLoadingPhoto.value = true
  try {
    const url = await fetchFacePhoto(props.measurement.id)
    if (unmounted) {
      if (url) URL.revokeObjectURL(url)
      return
    }
    facePhotoUrl.value = url
  } finally {
    if (!unmounted) isLoadingPhoto.value = false
  }
}

onMounted(() => {
  loadFacePhoto()
})

onUnmounted(() => {
  unmounted = true
  if (facePhotoUrl.value) {
    URL.revokeObjectURL(facePhotoUrl.value)
  }
})
</script>

<template>
  <div class="flex justify-center">
    <div v-if="isLoadingPhoto" class="w-32 h-32 rounded-xl bg-gray-200 animate-pulse" />
    <img
      v-else-if="facePhotoUrl"
      :src="facePhotoUrl"
      alt="認証時の顔写真"
      class="w-32 h-32 rounded-xl object-cover shadow-sm"
    >
    <p v-else-if="!measurement.face_photo_url" class="text-sm text-gray-400">
      顔認証なし
    </p>
    <div
      v-else
      class="w-32 h-32 rounded-xl bg-gray-100 flex items-center justify-center text-gray-400"
    >
      <svg class="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" />
      </svg>
    </div>
  </div>
</template>
