<script setup lang="ts">
import { listCamClipsCameras } from '~/utils/api'
import type { CamClipsCamera } from '~/utils/cam-clips'
import { errorText } from '~/utils/cam-clips'

/**
 * 拠点カメラの一覧 (グリッド)。登録済みのカメラ全部を `CamLiveTile` (roomId = camera.id) で同時に映す。
 * タイルは独立に繋ぐ・切る。このコンポーネントが外れる (タブを離れる) と全タイルが切れる。
 *
 * 「一斉に更新を確認」: 繋がっていて自己更新の確認に対応している (alc-cam の host 0.4.5〜) 拠点 PC 全部に、
 * タイルの「更新を確認」と同じ合図を送る。結果は各タイルに出る。繋がっていない・古い拠点 PC は対象にならない。
 */
const cameras = ref<CamClipsCamera[]>([])
const loading = ref(true)
const error = ref('')

/** 更新を確認できるタイル (roomId) */
const updatable = ref(new Set<string>())
const updateAllCount = ref(0)
const updateAllNote = ref<string | null>(null)

function setUpdatable(id: string, v: boolean) {
  const next = new Set(updatable.value)
  if (v) next.add(id)
  else next.delete(id)
  updatable.value = next
}

function updateAll() {
  const n = updatable.value.size
  updateAllCount.value += 1
  const skipped = cameras.value.length - n
  updateAllNote.value = `${n} 台の拠点 PC に更新の確認を頼みました。結果は各カメラに出ます`
    + (skipped > 0 ? ` (繋がっていない・古い ${skipped} 台は対象外)` : '')
}

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
    <template v-else>
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <button
          class="px-3 py-1 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50"
          :disabled="updatable.size === 0"
          title="繋がっている拠点 PC 全部に、host と拡張の更新を確認させます"
          data-testid="cam-grid-update-all"
          @click="updateAll"
        >
          一斉に更新を確認 ({{ updatable.size }} 台)
        </button>
        <span v-if="updateAllNote" class="text-xs text-gray-600" data-testid="cam-grid-update-note">{{ updateAllNote }}</span>
      </div>
      <div class="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3" data-testid="cam-grid">
        <CamLiveTile
          v-for="c in cameras"
          :key="c.id"
          :room-id="c.id"
          :label="c.name"
          auto-connect
          :update-all-count="updateAllCount"
          @update:updatable="setUpdatable(c.id, $event)"
        />
      </div>
    </template>
  </div>
</template>
