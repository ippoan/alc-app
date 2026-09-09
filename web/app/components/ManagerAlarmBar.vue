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

type AlarmVisual = 'disconnected' | 'idle' | 'alarming' | 'muted'

/** 見た目 (アイコン円・状態ピル・カードの枠) を 1 つの状態語に畳む */
const alarmVisual = computed<AlarmVisual>(() => {
  if (!alarm.isConnected.value) return 'disconnected'
  const s = alarm.deviceState.value?.state
  if (s === 'alarming') return 'alarming'
  if (s === 'muted') return 'muted'
  return 'idle'
})

// Tailwind の purge に残るよう、クラスは完全な文字列で持つ (`bg-${色}-100` のような連結は禁止)
const iconClasses: Record<AlarmVisual, string> = {
  disconnected: 'bg-gray-100 text-gray-400',
  idle: 'bg-green-100 text-green-600',
  alarming: 'bg-red-100 text-red-600',
  muted: 'bg-amber-100 text-amber-600',
}
const pillClasses: Record<AlarmVisual, string> = {
  disconnected: 'bg-gray-100 text-gray-500',
  idle: 'bg-green-50 text-green-700',
  alarming: 'bg-red-50 text-red-700',
  muted: 'bg-amber-50 text-amber-700',
}
const cardClasses: Record<AlarmVisual, string> = {
  disconnected: '',
  idle: '',
  alarming: 'border border-red-300 bg-red-50',
  muted: 'border border-amber-200',
}

const alarmIconClass = computed(() => iconClasses[alarmVisual.value])
const alarmPillClass = computed(() => pillClasses[alarmVisual.value])
const alarmCardClass = computed(() => cardClasses[alarmVisual.value])
</script>

<template>
  <ClientOnly>
    <div v-if="isSupported" class="w-full max-w-lg mx-auto px-4 mt-2">
      <div
        class="bg-white rounded-2xl shadow-sm px-4 py-3 flex items-center gap-3"
        :class="alarmCardClass"
        data-testid="manager-alarm-bar"
      >
        <span
          class="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
          :class="alarmIconClass"
        >
          <svg
            class="w-5 h-5"
            :class="{ 'animate-pulse': alarmVisual === 'alarming' }"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.4-1.4a2 2 0 01-.6-1.4V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0H9m6 0v1a3 3 0 11-6 0v-1" />
          </svg>
        </span>

        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium text-gray-800">警告デバイス</span>
            <span class="text-xs px-2 py-0.5 rounded-full" :class="alarmPillClass">{{ alarmStatusText }}</span>
          </div>
          <p v-if="!isWatching" class="text-xs text-red-600">着信を受けられません (signaling 未接続)</p>
          <p v-else-if="isCalling" class="text-xs text-amber-700 font-medium">着信あり — 遠隔点呼に入ると止まります</p>
          <p v-else class="text-xs text-gray-500">運行管理者のブラウザを見張っています (閉じると鳴ります)</p>
        </div>

        <button
          class="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
          :class="alarmVisual === 'disconnected'
            ? 'bg-blue-600 text-white hover:bg-blue-700'
            : 'border border-gray-300 text-gray-600 hover:bg-gray-50'"
          @click="alarm.requestPort()"
        >
          {{ alarmVisual === 'disconnected' ? '接続' : '接続し直す' }}
        </button>
      </div>
    </div>
  </ClientOnly>
</template>
