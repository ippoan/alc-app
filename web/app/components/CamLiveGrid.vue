<script setup lang="ts">
import { listCamClipsCameras } from '~/utils/api'
import type { CamClipsCamera } from '~/utils/cam-clips'
import { errorText } from '~/utils/cam-clips'

/**
 * 拠点カメラの一覧 (グリッド)。登録済みのカメラ全部を `CamLiveTile` (roomId = camera.id) で同時に映す。
 * タイルは独立に繋ぐ・切る。このコンポーネントが外れる (タブを離れる) と全タイルが切れる。
 */
const cameras = ref<CamClipsCamera[]>([])
const loading = ref(true)
const error = ref('')

onMounted(async () => {
  try {
    cameras.value = (await listCamClipsCameras()).cameras
  }
  catch (e) {
    error.value = errorText(e, 'カメラの一覧を取得できませんでした')
  }
  finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="space-y-3">
    <p v-if="loading" class="text-sm text-gray-500" data-testid="cam-grid-loading">読み込み中...</p>
    <div v-else-if="error" class="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700" data-testid="cam-grid-error">
      {{ error }}
    </div>
    <p v-else-if="cameras.length === 0" class="text-sm text-gray-500" data-testid="cam-grid-empty">
      カメラが登録されていません (「拠点カメラの録画」タブで追加できます)。
    </p>
    <div v-else class="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3" data-testid="cam-grid">
      <CamLiveTile v-for="c in cameras" :key="c.id" :room-id="c.id" :label="c.name" auto-connect />
    </div>
  </div>
</template>
