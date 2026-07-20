<script setup lang="ts">
const config = useRuntimeConfig()
const { accessToken } = useAuth()
const webRtc = useWebRtc('admin')

const siteIdInput = ref('')
const connectedSiteId = ref<string | null>(null)
const isViewActive = ref(false)
const isConnecting = ref(false)
const connectError = ref<string | null>(null)

const videoContainer = ref<HTMLElement | null>(null)
const videoRef = ref<HTMLVideoElement | null>(null)
const isFullscreen = ref(false)

const signalingWsUrl = (config.public.signalingUrl as string).replace(/^https/, 'wss').replace(/^http:/, 'ws:')

function toggleFullscreen() {
  if (!videoContainer.value) return
  if (!document.fullscreenElement) {
    videoContainer.value.requestFullscreen()
  } else {
    document.exitFullscreen()
  }
}

async function startViewing() {
  const siteId = siteIdInput.value.trim()
  if (!siteId) return

  if (!accessToken.value) {
    connectError.value = 'ログインセッションが見つかりません。再ログインしてください。'
    return
  }

  if (isViewActive.value) {
    webRtc.disconnect()
    isViewActive.value = false
  }

  connectError.value = null
  isConnecting.value = true
  try {
    await webRtc.connect(signalingWsUrl, siteId, 'cam-room', accessToken.value)
    connectedSiteId.value = siteId
    isViewActive.value = true
  } catch {
    connectError.value = '接続に失敗しました'
  } finally {
    isConnecting.value = false
  }
}

function stopViewing() {
  webRtc.disconnect()
  isViewActive.value = false
  connectedSiteId.value = null
}

watch(() => webRtc.error.value, (e) => {
  if (e) connectError.value = e
})

watch(() => webRtc.remoteStream.value, (stream) => {
  if (videoRef.value) videoRef.value.srcObject = stream
})

onMounted(() => {
  document.addEventListener('fullscreenchange', () => {
    isFullscreen.value = !!document.fullscreenElement
  })
})

onUnmounted(() => {
  webRtc.disconnect()
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
          :disabled="isConnecting || isViewActive"
          @keyup.enter="startViewing"
        >
        <button
          v-if="!isViewActive"
          class="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-50 transition-colors"
          :disabled="!siteIdInput.trim() || isConnecting"
          @click="startViewing"
        >
          {{ isConnecting ? '接続中...' : '接続' }}
        </button>
        <button
          v-else
          class="px-4 py-2 text-sm rounded-lg bg-red-100 hover:bg-red-200 text-red-700 font-medium transition-colors"
          @click="stopViewing"
        >
          視聴終了
        </button>
      </div>
      <div v-if="connectError" class="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
        {{ connectError }}
      </div>
    </div>

    <!-- 映像 -->
    <div v-if="isViewActive" class="bg-white rounded-xl p-4 shadow-sm space-y-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2 text-sm">
          <span
            class="w-2 h-2 rounded-full"
            :class="webRtc.isPeerConnected.value ? 'bg-green-500 animate-pulse' : 'bg-yellow-400 animate-pulse'"
          />
          <span class="text-gray-600">
            {{ webRtc.isPeerConnected.value ? '受信中' : 'デバイス接続待ち...' }}
          </span>
        </div>
        <span class="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-mono truncate max-w-[180px]">
          {{ connectedSiteId }}
        </span>
      </div>

      <div ref="videoContainer" class="relative group bg-black rounded-xl overflow-hidden">
        <video
          v-show="webRtc.remoteStream.value"
          ref="videoRef"
          autoplay
          playsinline
          muted
          class="w-full max-h-[70vh] object-contain mx-auto"
        />
        <div
          v-if="!webRtc.remoteStream.value"
          class="flex items-center justify-center h-48 text-gray-400 text-sm"
        >
          デバイス接続待ち...
        </div>
        <button
          class="absolute top-2 right-2 p-1.5 rounded-lg bg-black/40 hover:bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
          :title="isFullscreen ? '全画面解除' : '全画面表示'"
          @click="toggleFullscreen"
        >
          <svg v-if="!isFullscreen" class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
          </svg>
          <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M9 9V4m0 5H4m16 0h-5m5 0V4M9 15v5m0-5H4m16 0h-5m5 0v5" />
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>
