<script setup lang="ts">
/**
 * 据置警告デバイス (Atom VoiceS3R / USB) の状態表示と「接続」ボタン。
 *
 * 見張り (着信購読 + heartbeat) を始める・止めるのはこのバーではなく useAlarmWatch
 * (トップ画面 pages/index.vue が全タブ共通で 1 回だけ呼ぶ)。運行管理者の PC は運行者などの
 * タブをログイン無しで使うので、運行管理者タブにだけ出るこのバーの mount を起点にすると、
 * 警告デバイスが繋がらないままになる (Refs #231)。
 *
 * 止める (= デバイスが鳴る) のは次の 3 つだけ:
 *   PWA を閉じる / reload (app.vue の pagehide → grace=45) / デバイス設定を off にする
 * ロールタブ切替 (このバーの unmount) では切らない (#205)。どのロールタブに居ても
 * 着信 (`call=1`) は鳴る — これは望ましい副作用 (#135)
 */
const alarm = useAlarmDevice()
// Web Serial の無いブラウザではバーを出さない
const isSupported = alarm.isSupported
// この端末で警告デバイスを使うか (端末登録 / デバイス設定で選ぶ)。false の端末では
// バーを出さない。null は未設定 (既存の端末) なので問いかけカードを出す
// ([つなぐ] で true になった瞬間に useAlarmWatch が見張りを始める)
const { enabled, setEnabled } = useAlarmDeviceSetting()
const { isWatching, activeRooms, joinedRoomId } = useActiveRooms()

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

type AlarmVisual = 'disconnected' | 'idle' | 'alarming' | 'muted' | 'calling'

/**
 * 見た目 (アイコン円・状態ピル・カードの枠) を 1 つの状態語に畳む。
 * 未接続は音が鳴らない状況なので最優先で赤、着信は amber で目立たせる
 */
const alarmVisual = computed<AlarmVisual>(() => {
  if (!alarm.isConnected.value) return 'disconnected'
  const s = alarm.deviceState.value?.state
  if (s === 'alarming') return 'alarming'
  if (s === 'muted') return 'muted'
  if (isCalling.value) return 'calling'
  return 'idle'
})

// Tailwind の purge に残るよう、クラスは完全な文字列で持つ (`bg-${色}-100` のような連結は禁止)
const iconClasses: Record<AlarmVisual, string> = {
  disconnected: 'bg-red-100 text-red-600',
  idle: 'bg-green-100 text-green-600',
  alarming: 'bg-red-100 text-red-600',
  muted: 'bg-amber-100 text-amber-600',
  calling: 'bg-amber-100 text-amber-600',
}
const pillClasses: Record<AlarmVisual, string> = {
  disconnected: 'bg-red-50 text-red-700',
  idle: 'bg-green-50 text-green-700',
  alarming: 'bg-red-50 text-red-700',
  muted: 'bg-amber-50 text-amber-700',
  calling: 'bg-amber-50 text-amber-700',
}
const cardClasses: Record<AlarmVisual, string> = {
  disconnected: 'border border-red-300 bg-red-50',
  idle: '',
  alarming: 'border border-red-300 bg-red-50',
  muted: 'border border-amber-200',
  calling: 'border border-amber-300 bg-amber-50',
}
const pulseVisuals: ReadonlySet<AlarmVisual> = new Set(['disconnected', 'alarming', 'calling'])
const alarmPulse = computed(() => pulseVisuals.has(alarmVisual.value))

const alarmIconClass = computed(() => iconClasses[alarmVisual.value])
const alarmPillClass = computed(() => pillClasses[alarmVisual.value])
const alarmCardClass = computed(() => cardClasses[alarmVisual.value])
</script>

<template>
  <ClientOnly>
    <!-- 未設定 (既存の端末): バーの代わりに、この PC で使うかを問う -->
    <div v-if="isSupported && enabled === null" class="w-full max-w-lg mx-auto px-4 mt-2">
      <div
        class="bg-white rounded-2xl shadow-sm border border-gray-200 px-4 py-3 flex items-center gap-3"
        data-testid="manager-alarm-ask"
      >
        <p class="flex-1 min-w-0 text-xs text-gray-700">
          この PC に警告デバイス (Atom VoiceS3R) をつなぎますか?
          <span class="block text-gray-500">運行管理者の PC だけ「つなぐ」を選んでください。後からデバイス設定で変えられます</span>
        </p>
        <button
          class="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          data-testid="manager-alarm-ask-yes"
          @click="setEnabled(true)"
        >
          つなぐ
        </button>
        <button
          class="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
          data-testid="manager-alarm-ask-no"
          @click="setEnabled(false)"
        >
          つながない
        </button>
      </div>
    </div>

    <div v-else-if="isSupported && enabled === true" class="w-full max-w-lg mx-auto px-4 mt-2">
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
            :class="{ 'animate-pulse': alarmPulse }"
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
          <p v-if="alarmVisual === 'disconnected'" class="text-xs text-red-700 font-medium">
            <span class="font-bold">警告デバイスが接続されていません</span> — USB を確認して「接続」を押してください
          </p>
          <p v-else-if="!isWatching" class="text-xs text-red-600">着信を受けられません (signaling 未接続)</p>
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
