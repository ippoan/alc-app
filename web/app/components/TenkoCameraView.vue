<script setup lang="ts">
import { isClient } from '~/utils/env'

const SITE_ID_STORAGE_KEY = 'alc_camera_site_id'

const siteIdInput = ref('')
/** 接続を始めた site_id。タイルは視聴終了で外れ、次の接続で作り直される */
const connectedSiteId = ref<string | null>(null)
const isViewActive = ref(false)

function startViewing() {
  const siteId = siteIdInput.value.trim()
  if (!siteId) return
  // デバッグ用: 次回このページを開いた時に site_id を再入力しなくて済むように保存
  if (isClient) localStorage.setItem(SITE_ID_STORAGE_KEY, siteId)
  connectedSiteId.value = siteId
  isViewActive.value = true
}

function stopViewing() {
  isViewActive.value = false
  connectedSiteId.value = null
}

onMounted(() => {
  if (isClient) {
    const saved = localStorage.getItem(SITE_ID_STORAGE_KEY)
    if (saved) siteIdInput.value = saved
  }
})
</script>

<template>
  <div class="space-y-4">
    <!-- 接続フォーム -->
    <div class="bg-white rounded-xl p-4 shadow-sm space-y-3">
      <h3 class="text-sm font-medium text-gray-700">拠点カメラ接続</h3>
      <p class="text-sm text-gray-500">
        視聴する拠点の site_id を入力してください (hub デバイスの device_id と一致)。
      </p>
      <div class="flex gap-2">
        <input
          v-model="siteIdInput"
          type="text"
          placeholder="site_id"
          class="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
          :disabled="isViewActive"
          @keyup.enter="startViewing"
        >
        <button
          v-if="!isViewActive"
          class="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-50 transition-colors"
          :disabled="!siteIdInput.trim()"
          @click="startViewing"
        >
          接続
        </button>
        <button
          v-else
          class="px-4 py-2 text-sm rounded-lg bg-red-100 hover:bg-red-200 text-red-700 font-medium transition-colors"
          @click="stopViewing"
        >
          視聴終了
        </button>
      </div>
    </div>

    <!-- 映像 -->
    <CamLiveTile
      v-if="isViewActive && connectedSiteId"
      :room-id="connectedSiteId"
      auto-connect
    />
  </div>
</template>
