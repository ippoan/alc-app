<script setup lang="ts">
const config = useRuntimeConfig()

const webRtc = useWebRtc('admin')

const { activeRooms, start: startWatchingRooms, stop: stopWatchingRooms, reload: reloadActiveRooms } = useActiveRooms()
const selectedRoomId = ref<string | null>(null)
const isViewActive = ref(false)
const isLoading = ref(false)
const loadError = ref<string | null>(null)

const videoContainer = ref<HTMLElement | null>(null)
const videoRef = ref<HTMLVideoElement | null>(null)
const isFullscreen = ref(false)
const isMuted = ref(false)
const hasMic = ref(false)
let adminMicStream: MediaStream | null = null

function toggleFullscreen() {
  if (!videoContainer.value) return
  if (!document.fullscreenElement) {
    videoContainer.value.requestFullscreen()
  } else {
    document.exitFullscreen()
  }
}

// screen- プレフィックスのみフィルタリング
const screenRooms = computed(() => activeRooms.value.filter(r => r.startsWith('screen-')))

const signalingWsUrl = (config.public.signalingUrl as string).replace(/^https/, 'wss').replace(/^http:/, 'ws:')

async function loadActiveRooms() {
  isLoading.value = true
  loadError.value = null
  if (!await reloadActiveRooms()) {
    loadError.value = '画面共有一覧の取得に失敗しました'
  }
  isLoading.value = false
}

async function startViewing(roomId: string) {
  if (isViewActive.value) {
    webRtc.disconnect()
    adminMicStream?.getTracks().forEach(t => t.stop())
    adminMicStream = null
    isViewActive.value = false
  }

  selectedRoomId.value = roomId
  isMuted.value = false
  try {
    // マイク音声を取得
    try {
      adminMicStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      hasMic.value = true
    } catch {
      // マイク拒否時は視聴のみで続行
    }

    await webRtc.connect(signalingWsUrl, roomId)

    // マイク音声をWebRTCで送信
    if (adminMicStream) {
      await webRtc.startStreaming(adminMicStream)
    }

    isViewActive.value = true
  } catch {
    adminMicStream?.getTracks().forEach(t => t.stop())
    adminMicStream = null
    hasMic.value = false
    loadError.value = '接続に失敗しました'
  }
}

function stopViewing() {
  webRtc.disconnect()
  adminMicStream?.getTracks().forEach(t => t.stop())
  adminMicStream = null
  hasMic.value = false
  isViewActive.value = false
  selectedRoomId.value = null
  isMuted.value = false
}

function toggleMute() {
  if (!adminMicStream) return
  isMuted.value = !isMuted.value
  for (const track of adminMicStream.getAudioTracks()) {
    track.enabled = !isMuted.value
  }
}

// 視聴中のルームが一覧から消えたら停止
watch(activeRooms, (rooms) => {
  if (isViewActive.value && selectedRoomId.value && !rooms.includes(selectedRoomId.value)) {
    stopViewing()
  }
})

watch(() => webRtc.remoteStream.value, (stream) => {
  if (videoRef.value) videoRef.value.srcObject = stream
})

onMounted(() => {
  loadActiveRooms()
  startWatchingRooms()
  document.addEventListener('fullscreenchange', () => {
    isFullscreen.value = !!document.fullscreenElement
  })
})

onUnmounted(() => {
  stopWatchingRooms()
  webRtc.disconnect()
  adminMicStream?.getTracks().forEach(t => t.stop())
  adminMicStream = null
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-bold text-gray-800">画面共有モニター</h2>
      <button
        class="text-sm px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 transition-colors"
        :disabled="isLoading"
        @click="loadActiveRooms"
      >
        更新
      </button>
    </div>

    <!-- 運行者側の操作手順 -->
    <div class="rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-800">
      <div class="font-semibold mb-1">運行者側の操作手順</div>
      <ol class="list-decimal list-inside space-y-0.5 text-blue-700">
        <li>運行者タブを開く</li>
        <li>画面右下の「画面共有」ボタンを押す</li>
        <li>ブラウザの画面選択ダイアログで「画面全体」を選択して共有</li>
        <li>このページの一覧に接続中の運行者が表示される</li>
      </ol>
    </div>

    <div v-if="loadError" class="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
      {{ loadError }}
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <!-- 左: 画面表示パネル -->
      <div class="space-y-3">
        <h3 class="text-sm font-semibold text-gray-600">共有画面</h3>

        <div v-if="selectedRoomId && isViewActive" class="space-y-2">
          <!-- 接続ステータス + マイク -->
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2 text-sm">
              <span
                class="w-2 h-2 rounded-full"
                :class="webRtc.isPeerConnected.value ? 'bg-green-500 animate-pulse' : 'bg-yellow-400 animate-pulse'"
              />
              <span class="text-gray-600">
                {{ webRtc.isPeerConnected.value ? '画面受信中' : '接続待機中...' }}
              </span>
            </div>
            <button
              class="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors"
              :class="isMuted
                ? 'bg-red-100 hover:bg-red-200 text-red-700'
                : hasMic ? 'bg-green-100 hover:bg-green-200 text-green-700' : 'bg-gray-100 text-gray-400 cursor-not-allowed'"
              :disabled="!hasMic"
              @click="toggleMute"
            >
              <svg v-if="!isMuted && hasMic" class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
              <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
              </svg>
              {{ !hasMic ? 'マイク未接続' : isMuted ? 'ミュート中' : 'マイクON' }}
            </button>
          </div>

          <!-- 画面映像 -->
          <div ref="videoContainer" class="relative group bg-black rounded-xl overflow-hidden">
            <video
              v-show="webRtc.remoteStream.value"
              ref="videoRef"
              autoplay
              playsinline
              class="w-full max-h-[80vh] object-contain mx-auto"
            />
            <div
              v-if="!webRtc.remoteStream.value"
              class="flex items-center justify-center h-48 text-gray-400 text-sm"
            >
              接続待機中...
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

          <div class="rounded-lg bg-blue-50 border border-blue-200 px-4 py-2 text-xs font-mono text-blue-600 truncate">
            {{ selectedRoomId }}
          </div>

          <button
            class="w-full py-2 text-sm rounded-lg bg-red-100 hover:bg-red-200 text-red-700 font-medium transition-colors"
            @click="stopViewing"
          >
            視聴終了
          </button>
        </div>

        <div
          v-else
          class="flex items-center justify-center aspect-video rounded-xl bg-gray-100 text-gray-400 text-sm"
        >
          右のリストから共有中の画面を選択
        </div>
      </div>

      <!-- 右: 共有中一覧 -->
      <div class="space-y-3">
        <h3 class="text-sm font-semibold text-gray-600">
          画面共有中
          <span class="ml-1 text-gray-400">({{ screenRooms.length }}件)</span>
        </h3>

        <div v-if="isLoading && screenRooms.length === 0" class="text-center py-8 text-gray-400 text-sm">
          読み込み中...
        </div>

        <div v-else-if="screenRooms.length === 0" class="text-center py-8 text-gray-400 text-sm">
          画面共有中の運行者はいません
        </div>

        <div
          v-for="roomId in screenRooms"
          :key="roomId"
          class="rounded-xl border p-4 cursor-pointer transition-colors"
          :class="selectedRoomId === roomId && isViewActive
            ? 'border-blue-400 bg-blue-50'
            : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'"
          @click="startViewing(roomId)"
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span class="text-sm font-medium text-gray-800">画面共有中</span>
            </div>
            <span class="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">
              共有中
            </span>
          </div>
          <div class="mt-1 text-xs text-gray-400 font-mono truncate">{{ roomId }}</div>
          <div class="mt-2 text-xs text-blue-600 font-medium">
            クリックして視聴 →
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
