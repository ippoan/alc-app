<script setup lang="ts">
const config = useRuntimeConfig()
const signalingUrl = config.public.signalingUrl as string

const { isSharing, roomId, error, isPeerConnected, isConnected, isMuted, endedByAdmin, remoteStream, startSharing, stopSharing, toggleMute } = useScreenShare()

const { isAndroidLandscape } = useAndroidLandscape()
const shortRoomId = computed(() => roomId.value ? roomId.value.slice(-8).toUpperCase() : null)

const audioRef = ref<HTMLAudioElement | null>(null)
watch(() => remoteStream.value, (stream) => {
  if (audioRef.value) {
    audioRef.value.srcObject = stream
  }
})

const statusLabel = computed(() => {
  if (isPeerConnected.value) return '管理者が視聴中'
  if (isConnected.value) return '待機中...'
  return '接続中...'
})
</script>

<template>
  <!-- 固定フローティング UI: タブ切り替えに関係なく常時表示 -->
  <div :class="['fixed z-50', isAndroidLandscape ? 'top-1 right-14' : 'bottom-20 right-4']">
    <!-- 共有中: コンパクトパネル -->
    <div
      v-if="isSharing"
      class="rounded-2xl shadow-lg border bg-white overflow-hidden w-52"
    >
      <!-- ステータスヘッダー -->
      <div
        class="flex items-center gap-2 px-3 py-2"
        :class="isPeerConnected ? 'bg-green-500' : 'bg-yellow-400'"
      >
        <span class="w-2 h-2 rounded-full bg-white opacity-90 animate-pulse" />
        <span class="text-xs font-semibold text-white flex-1">{{ statusLabel }}</span>
      </div>

      <!-- 共有 ID -->
      <div class="px-3 py-2 text-center">
        <div class="text-xs text-gray-400 mb-0.5">共有 ID</div>
        <div class="font-mono text-lg font-bold tracking-widest text-gray-800">{{ shortRoomId }}</div>
      </div>

      <!-- エラー -->
      <div v-if="error" class="px-3 pb-2 text-xs text-red-600 text-center">{{ error }}</div>

      <!-- マイクミュート -->
      <div class="px-3 pb-1">
        <button
          class="w-full py-1.5 text-xs font-semibold rounded-lg transition-colors flex items-center justify-center gap-1"
          :class="isMuted ? 'bg-red-100 hover:bg-red-200 text-red-700' : 'bg-gray-100 hover:bg-gray-200 text-gray-600'"
          @click="toggleMute"
        >
          <svg v-if="!isMuted" class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
          <svg v-else class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
          </svg>
          {{ isMuted ? 'ミュート中' : 'マイクON' }}
        </button>
      </div>

      <!-- 停止ボタン -->
      <div class="px-3 pb-3">
        <button
          class="w-full py-1.5 text-xs font-semibold rounded-lg bg-red-100 hover:bg-red-200 text-red-700 transition-colors"
          @click="stopSharing"
        >
          共有を停止
        </button>
      </div>

      <!-- 管理者の音声再生 -->
      <audio ref="audioRef" autoplay playsinline class="hidden" />
    </div>

    <!-- 未共有: 小さいボタン -->
    <template v-else>
      <!-- 運行管理者の「画面共有を終了」で止まった直後だけ出る (数秒で消える) -->
      <div
        v-if="endedByAdmin"
        class="mb-2 rounded-lg shadow bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800 max-w-52"
        data-testid="screen-share-ended-by-admin"
      >
        管理者が画面共有を終了しました
      </div>
      <div v-if="error" class="mb-2 rounded-lg shadow bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700 max-w-52">
        {{ error }}
      </div>
      <button
        class="flex items-center gap-2 px-4 py-2.5 rounded-full shadow-lg bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 text-sm font-medium transition-colors"
        @click="startSharing(signalingUrl)"
      >
        <svg class="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
        画面共有
      </button>
    </template>
  </div>
</template>
