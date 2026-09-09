<script setup lang="ts">
/**
 * 据置警告デバイス (Atom VoiceS3R / USB) の heartbeat と着信購読。
 *
 * 運行管理者の PC は普段、トップ画面「運行管理者」タブの認証ゲートのまま置かれる。
 * 見張る対象は「そのタブがブラウザで開いているか」であって認証の有無ではないので、
 * このバーは認証ゲートの外 (タブに入った時点) に置く。
 * バーが mount しているあいだだけ heartbeat が出る = タブを離れるとデバイスが鳴る (#135)
 */
const alarm = useAlarmDevice()
// Web Serial の無いブラウザでは購読も heartbeat も立てない
const isSupported = alarm.isSupported
const { isWatching, activeRooms, joinedRoomId, start, stop } = useActiveRooms()

if (isSupported) {
  onMounted(() => {
    start()
    // BLE ゲートウェイと同居しない PC なので、ポートの取り合いを待つ必要が無い
    alarm.connect(0)
  })
  onUnmounted(() => {
    void alarm.disconnect()
    // 参照カウントなので、遠隔点呼タブの子が先に stop していても WebSocket は残る
    stop()
  })
}

const alarmCauseLabels: Record<string, string> = {
  silence: '無音',
  'ng:signaling': 'signaling 未接続',
  call: '呼び出し',
}
function alarmCauseText(cause: string): string {
  return alarmCauseLabels[cause] ?? cause
}

/** 着信中 = room は立っているが管理者がまだどれにも入っていない (台数は認証前の画面なので出さない) */
const isCalling = computed(() => joinedRoomId.value === null && activeRooms.value.length > 0)

const alarmStatusText = computed(() => {
  if (!alarm.isConnected.value) return '未接続'
  const s = alarm.deviceState.value
  if (s?.state === 'alarming') return `鳴動中 (${alarmCauseText(s.cause)})`
  if (s?.state === 'muted') return `停止済み (人が止めた・${alarmCauseText(s.cause)})`
  return '接続'
})

const alarmDotClass = computed(() => {
  if (!alarm.isConnected.value) return 'bg-gray-300'
  const state = alarm.deviceState.value?.state
  if (state === 'alarming') return 'bg-red-500'
  if (state === 'muted') return 'bg-amber-400'
  return 'bg-green-500'
})
</script>

<template>
  <ClientOnly>
    <div
      v-if="isSupported"
      class="shrink-0 px-4 py-1.5 bg-white border-b flex items-center gap-3 text-xs"
      data-testid="manager-alarm-bar"
    >
      <span class="w-2.5 h-2.5 rounded-full shrink-0" :class="alarmDotClass" />
      <span class="text-gray-700">警告デバイス: {{ alarmStatusText }}</span>
      <span v-if="!isWatching" class="text-red-600">着信を受けられません (signaling 未接続)</span>
      <span v-else-if="isCalling" class="text-amber-600 font-medium">着信あり</span>
      <button
        class="ml-auto px-3 py-1 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
        @click="alarm.requestPort()"
      >
        警告デバイスを接続
      </button>
    </div>
  </ClientOnly>
</template>
