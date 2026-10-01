<script setup lang="ts">
/**
 * 運行管理者側の IT点呼 の受け画面 (Refs ippoan/alc-app#387)。
 *
 * 遠隔点呼とは別物。流れは「運行管理者を席に登録 (社員番号だけ。**顔認証なし**) → 通話 → 判定」。
 * IT点呼 で保存された記録は、運行管理者の判定が付くまで未完了のまま残る。判定のときに
 * **通話で確認した (IT) か、本人が来て対面で確認した (対面) か**を選んで確定する。
 * 通話が成立しなかった分は「未完了の IT点呼」の一覧から後で確定する。
 *
 * **どの席にも出る** (`index.vue` の最上段の役割タブ `it_tenko`。開発用の印は見ない。
 * 運行管理者タブの入口 `RoleAuthGate` は通さない = ログインなしで受ける)。
 * 通信は全部 `'manager-device'` の口 (= 運行管理者席の鍵) で送る。席の鍵が取れないときは
 * `request()` が投げた文言 (`MANAGER_DEVICE_AUTH_FAILED_MESSAGE`) を一覧と登録のエラーにそのまま出す。
 *
 * **判定者は「この席に登録された運行管理者」** (`useItTenkoManager`)。画面の上部の枠で社員番号を
 * 登録すると席 (localStorage) が id を覚え、「変更」を押すまで残る。運行管理者タブ・遠隔点呼が
 * 共有する ID (`useManagerAuth`) は引き継がないし、そこへ書き込みもしない。
 *
 * 通話の手順は `TenkoRemoteAdminView.vue` からの複製 (あちらは本番で動いている
 * 経路なので触らない。共通化は IT点呼 を通常の点呼へ統合するときに行う)。
 */
import type { TenkoSession } from '~/types'
import { MANAGER_DEVICE_AUTH_FAILED_MESSAGE, getEmployees, getTenkoSession, listTenkoSessions } from '~/utils/api'
import { alcoholResultLabel } from '~/utils/alcohol'
import { IT_TENKO_METHOD, defaultJudgmentMethod, itTenkoRoomOf, itTenkoSessionId, splitRooms } from '~/utils/it-tenko'
import { IT_TENKO_POLL_INTERVAL_MS } from '~/composables/useItTenkoCall'

/** 開く対象。`roomId` が在れば通話して開く、null なら通話なしで開く */
interface Target {
  sessionId: string
  roomId: string | null
}

const config = useRuntimeConfig()
const {
  manager,
  loading: managerLoading,
  load: loadManager,
  registerByCode,
  clear: clearManager,
} = useItTenkoManager()
const webRtc = useWebRtc('admin')
const camera = useCamera()

// 部屋の一覧の購読はアプリ全体で 1 本。**start / stop は参照カウントで、警告デバイスの見張りが
// 別に 1 つ持っている** — stop を余分に呼ぶと見張りの分を奪って接続が閉じるので、
// mount で 1 回・unmount で 1 回だけ呼ぶ (エラー時や判定の後には呼ばない)
const {
  activeRooms,
  callingRooms,
  start: startWatchingRooms,
  stop: stopWatchingRooms,
  setJoined,
  reload: reloadActiveRooms,
} = useActiveRooms()
/** 着信 = IT点呼 の部屋だけ (遠隔点呼の部屋は遠隔点呼モニターが受ける) */
const itRooms = computed(() => splitRooms(activeRooms.value).it)

// WebSocket用: https://→wss:// または http://→ws://
const signalingWsUrl = (config.public.signalingUrl as string).replace(/^https/, 'wss').replace(/^http:/, 'ws:')

// --- 未完了の IT点呼 (運行管理者の判定がまだ確定していない記録) ---

const pending = ref<TenkoSession[]>([])
const pendingLoading = ref(false)
const pendingError = ref<string | null>(null)
const employeeNames = ref<Record<string, string>>({})
// 取り直しが重なったら、後から始めた方の結果だけを採る
let pendingSeq = 0

async function loadEmployeeNames() {
  try {
    const employees = await getEmployees('manager-device')
    employeeNames.value = Object.fromEntries(employees.map(e => [e.id, e.name]))
  }
  catch { /* 名前が引けなくても一覧は出す */ }
}

async function loadPending() {
  const seq = ++pendingSeq
  pendingLoading.value = true
  pendingError.value = null
  try {
    const res = await listTenkoSessions(
      { tenko_method: IT_TENKO_METHOD, judgment_pending: true, per_page: 50 },
      'manager-device',
    )
    if (seq !== pendingSeq) return
    pending.value = res.sessions
  }
  catch (e) {
    if (seq !== pendingSeq) return
    // 席の鍵が取れなかったときだけ、その理由をそのまま出す (直し方が書いてある)
    pendingError.value = e instanceof Error && e.message === MANAGER_DEVICE_AUTH_FAILED_MESSAGE
      ? e.message
      : '未完了の IT点呼 の取得に失敗しました'
  }
  pendingLoading.value = false
}

function refresh() {
  void reloadActiveRooms()
  void loadPending()
}

function employeeName(employeeId: string) {
  return employeeNames.value[employeeId] || employeeId.slice(0, 8)
}

/** 着信の行に出す名前。未完了の一覧に在る記録なら乗務員名、まだ無ければ部屋の id */
function roomLabel(roomId: string) {
  const s = pending.value.find(p => p.id === itTenkoSessionId(roomId))
  return s ? employeeName(s.employee_id) : roomId
}

function formatTime(d: string | null) {
  if (!d) return '-'
  return new Date(d).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// --- この席の運行管理者 (社員番号で登録する。顔認証はしない) ---

/** 未登録のまま開こうとして、社員番号の入力を待っている対象 */
const waiting = ref<Target | null>(null)
const idInput = ref('')
const idError = ref<string | null>(null)
/** 上部の枠 (着信が無くても登録できる) の入力 */
const cardInput = ref('')
const cardError = ref<string | null>(null)

const managerName = computed(() =>
  manager.value?.name ?? (managerLoading.value ? '確認中...' : '(名前を取得できません)'),
)

function request(target: Target) {
  idError.value = null
  // 席に登録が在れば社員番号は聞かない
  if (manager.value) {
    void open(target)
    return
  }
  waiting.value = target
}

/** 着信の行・未完了の行 (部屋が在る) の「通話する」 */
function requestCall(roomId: string) {
  const sessionId = itTenkoSessionId(roomId)
  if (sessionId) request({ sessionId, roomId })
}

/** 未完了の行。部屋が在れば着信と同じ動き、無ければ通話なしで開く */
function requestRow(s: TenkoSession) {
  request({ sessionId: s.id, roomId: itTenkoRoomOf(s.id, activeRooms.value) })
}

/** 入力の社員番号で席に登録する。登録できたら true (空の入力・失敗は false) */
async function register(input: Ref<string>, error: Ref<string | null>): Promise<boolean> {
  const code = input.value.trim()
  if (!code) return false
  error.value = null
  const res = await registerByCode(code)
  if (!res.ok) {
    error.value = res.message
    return false
  }
  input.value = ''
  return true
}

/** 上部の枠の「登録」 */
async function onCardSubmit() {
  await register(cardInput, cardError)
}

/** モーダルの「次へ」。登録できたら、そのまま対象を開く */
async function onIdSubmit() {
  if (!await register(idInput, idError)) return
  // 照会を待つあいだにキャンセルされていたら開かない
  if (waiting.value) await open(waiting.value)
}

/** 「変更」: 登録を消して未登録の表示に戻す */
function changeManager() {
  cardError.value = null
  clearManager()
}

function cancelIdInput() {
  waiting.value = null
  idInput.value = ''
  idError.value = null
}

// --- 通話と点呼の記録 ---

/** いま開いている対象 */
const opened = ref<Target | null>(null)
const session = ref<TenkoSession | null>(null)
const isCallActive = ref(false)
/** カメラ・マイク・signaling を開いている途中 (このあいだは別の行を開かせない) */
const connecting = ref(false)
const callError = ref<string | null>(null)
const showDriverInfoPanel = ref(false)
const localStream = shallowRef<MediaStream | null>(null)  // 映像+音声 (TenkoVideoCall用)
let audioStream: MediaStream | null = null  // マイク音声 (WebRTC用)
let pollTimer: ReturnType<typeof setInterval> | null = null
// open() / close() の世代。カメラや signaling を待つあいだに close() が来たら、
// 待っていた古い open() は何も残さずに終わる
let generation = 0

function releaseMedia() {
  webRtc.disconnect()
  camera.stop()
  audioStream?.getTracks().forEach(t => t.stop())
  audioStream = null
  localStream.value = null
}

/** 通話・カメラ・マイク・ポーリングを手放し、開いていた対象を閉じる */
function close() {
  generation += 1
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  releaseMedia()
  isCallActive.value = false
  connecting.value = false
  showDriverInfoPanel.value = false
  opened.value = null
  session.value = null
  setJoined(null)
}

/** 通話を始める。始められたら true (世代が変わっていた・失敗したら false) */
async function startCall(roomId: string, gen: number): Promise<boolean> {
  connecting.value = true
  try {
    await camera.start('user')
    // カメラ映像 + マイク音声を合成して送信
    let streamToSend = camera.stream.value as MediaStream | null
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      if (streamToSend) {
        streamToSend = new MediaStream([
          ...streamToSend.getVideoTracks(),
          ...audioStream.getAudioTracks(),
        ])
      }
    }
    catch {
      // マイク拒否時はビデオのみで続行
    }
    localStream.value = streamToSend
    // 開発用の印がある席では鍵のトークンを自分で付け、取れなければ throw する。
    // 受けてエラーを出すだけで、token なしでは繋ぎ直さない (本番の部屋の側に入ってしまう)
    await webRtc.connect(signalingWsUrl, roomId)
    if (streamToSend) await webRtc.startStreaming(streamToSend)
  }
  catch (e) {
    if (gen !== generation) {
      releaseMedia()
      return false
    }
    close()
    callError.value = e instanceof Error && e.message
      ? `通話を始められませんでした: ${e.message}`
      : '通話を始められませんでした'
    return false
  }
  if (gen !== generation) {
    // 待つあいだに close() が来ていた (画面が消えた)。いま開いたぶんを閉じて終わる
    releaseMedia()
    return false
  }
  connecting.value = false
  isCallActive.value = true
  setJoined(roomId)
  return true
}

async function fetchSession(sessionId: string, gen: number) {
  try {
    const s = await getTenkoSession(sessionId, 'manager-device')
    if (gen === generation) session.value = s
  }
  catch {
    // 一時的な失敗では閉じない (通話中は次の回で引き直す)。1 度も引けていなければ伝える
    if (gen === generation && !session.value) callError.value = '点呼の記録を取得できませんでした'
  }
}

async function open(target: Target) {
  waiting.value = null
  close()
  const gen = generation
  callError.value = null
  if (target.roomId && !await startCall(target.roomId, gen)) return
  opened.value = target
  await fetchSession(target.sessionId, gen)
  if (gen !== generation || !target.roomId) return
  // 通話中だけ引き直す (通話なしで開いたときは上の 1 回だけ)
  pollTimer = setInterval(() => void fetchSession(target.sessionId, gen), IT_TENKO_POLL_INTERVAL_MS)
}

/** 判定が付いた: 通話を終え、選択を解除し、未完了の一覧を取り直す */
function onJudged() {
  close()
  void loadPending()
}

onMounted(() => {
  void loadManager()
  void loadEmployeeNames()
  refresh()
  startWatchingRooms()
})

// 部屋が増減した = 新しい IT点呼 が始まった / 終わった
watch(activeRooms, () => void loadPending())

// 警告デバイス本体のボタン (着信で鳴っている間に押された) = 着信の先頭の IT点呼 に応答する。
// この画面が開いているときだけ効く (mount より前の押下は拾わない)。対象は**着信として数えている
// 部屋** (`callingRooms`) の IT点呼 で、判定済みでまだ消えていない部屋を含む `itRooms` は使わない。
// 遠隔点呼の着信だけのとき・点呼を開いている / 繋いでいる途中・社員番号を聞いている間は何もしない
watch(useAlarmDevice().buttonPressCount, () => {
  if (opened.value || connecting.value || waiting.value) return
  const roomId = splitRooms(callingRooms.value).it[0]
  if (roomId) requestCall(roomId)
})

onUnmounted(() => {
  close()
  stopWatchingRooms()
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-bold text-gray-800">IT点呼</h2>
      <button
        class="text-sm px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 transition-colors"
        :disabled="pendingLoading"
        @click="refresh"
      >
        更新
      </button>
    </div>

    <!-- この席の運行管理者 (判定者)。着信が無くても登録できる -->
    <div class="rounded-xl border border-gray-200 bg-white p-4" data-testid="it-manager-card">
      <div v-if="manager" class="flex items-center justify-between gap-2">
        <p class="text-sm text-gray-700">
          いまの運行管理者:
          <span class="font-semibold text-gray-900" data-testid="it-manager-name">{{ managerName }}</span>
        </p>
        <!-- 点呼を開いている間 (繋いでいる途中を含む) は替えさせない: 判定者が途中で消える -->
        <button
          class="shrink-0 px-3 py-1.5 text-sm rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium transition-colors disabled:opacity-50"
          :disabled="opened !== null || connecting"
          @click="changeManager"
        >
          変更
        </button>
      </div>
      <div v-else class="space-y-2">
        <p class="text-sm text-gray-700">この席の運行管理者を登録してください (社員番号)</p>
        <div class="flex gap-2">
          <input
            v-model="cardInput"
            type="text"
            placeholder="社員番号 (例: 001)"
            class="min-w-0 flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            @keyup.enter="onCardSubmit"
          >
          <button
            :disabled="!cardInput.trim()"
            class="shrink-0 px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors disabled:opacity-50"
            @click="onCardSubmit"
          >
            登録
          </button>
        </div>
        <p v-if="cardError" class="text-sm text-red-700" data-testid="it-manager-card-error">{{ cardError }}</p>
      </div>
    </div>

    <div v-if="callError" class="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700" data-testid="it-call-error">
      {{ callError }}
    </div>

    <!-- 開いている点呼 (通話して開いた / 通話なしで開いた) -->
    <div v-if="opened" class="rounded-xl border border-blue-300 bg-white p-4 space-y-3" data-testid="it-opened">
      <div class="flex items-center justify-between gap-2">
        <h3 class="text-sm font-semibold text-gray-700">
          {{ opened.roomId ? '通話中の IT点呼' : '通話なしで確定する IT点呼' }}
        </h3>
        <div class="flex gap-2">
          <button
            v-if="session"
            class="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors"
            @click="showDriverInfoPanel = !showDriverInfoPanel"
          >
            {{ showDriverInfoPanel ? '情報を閉じる' : '運転者情報' }}
          </button>
          <button
            class="px-3 py-1.5 text-sm rounded-lg bg-red-100 hover:bg-red-200 text-red-700 font-medium transition-colors"
            @click="close"
          >
            {{ opened.roomId ? '通話終了' : '閉じる' }}
          </button>
        </div>
      </div>

      <TenkoVideoCall
        v-if="isCallActive"
        :local-stream="localStream"
        :remote-stream="webRtc.remoteStream.value"
        :is-peer-connected="webRtc.isPeerConnected.value"
        :is-connected="webRtc.isConnected.value"
      />

      <!-- 運転者情報。**測定時の顔写真は出さない** (本人確認は免許証で、本人は通話の映像で見る)。
           顔写真はこのパネルが出す乗務員の登録写真だけ -->
      <TenkoDriverInfoPanel
        v-if="showDriverInfoPanel && session"
        :employee-id="session.employee_id"
        :session-id="session.id"
        scope="manager-device"
        @close="showDriverInfoPanel = false"
      />

      <div v-if="session" class="divide-y divide-gray-100 text-sm">
        <div class="py-1 flex justify-between">
          <span class="text-xs text-gray-500">乗務員</span>
          <span class="font-semibold text-gray-800">{{ employeeName(session.employee_id) }}</span>
        </div>
        <div class="py-1 flex justify-between">
          <span class="text-xs text-gray-500">開始時刻</span>
          <span class="text-gray-800">{{ formatTime(session.started_at ?? session.created_at) }}</span>
        </div>
        <div class="py-1 flex justify-between">
          <span class="text-xs text-gray-500">アルコール</span>
          <span class="text-gray-800">
            {{ session.alcohol_result ? alcoholResultLabel(session.alcohol_result) : '-' }}
            <span v-if="session.alcohol_value != null" class="text-xs text-gray-500 ml-1">{{ session.alcohol_value }} mg/L</span>
          </span>
        </div>
        <div class="py-1 flex justify-between">
          <span class="text-xs text-gray-500">体温</span>
          <span class="text-gray-800">{{ session.temperature != null ? `${session.temperature}°C` : '-' }}</span>
        </div>
        <div class="py-1 flex justify-between">
          <span class="text-xs text-gray-500">血圧</span>
          <span class="text-gray-800">{{ session.systolic != null && session.diastolic != null ? `${session.systolic}/${session.diastolic} mmHg` : '-' }}</span>
        </div>
      </div>
      <div v-else-if="!callError" class="text-sm text-gray-400">点呼の記録を読み込み中...</div>

      <!-- 運行管理者の判定。確認の方法の初期値は、通話して開いたなら IT、通話なしなら対面 -->
      <TenkoManagerJudgmentPanel
        v-if="session"
        :key="session.id"
        :session="session"
        :manager-id="manager?.id ?? null"
        :default-method="defaultJudgmentMethod(opened.roomId !== null)"
        scope="manager-device"
        @judged="onJudged"
      />
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <!-- 着信 (乗務員が通話を待っている IT点呼) -->
      <div class="space-y-3" data-testid="it-incoming">
        <h3 class="text-sm font-semibold text-gray-600">
          着信
          <span class="ml-1 text-gray-400">({{ itRooms.length }}件)</span>
        </h3>
        <div v-if="itRooms.length === 0" class="text-center py-8 text-gray-400 text-sm">
          通話を待っている IT点呼 はありません
        </div>
        <div
          v-for="roomId in itRooms"
          :key="roomId"
          class="rounded-xl border p-4 flex items-center justify-between gap-2"
          :class="opened?.roomId === roomId ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-white'"
        >
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span class="text-sm font-medium text-gray-800 truncate">{{ roomLabel(roomId) }}</span>
            </div>
            <div class="mt-1 text-xs text-gray-400 font-mono truncate">{{ roomId }}</div>
          </div>
          <button
            class="shrink-0 px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors disabled:opacity-50"
            :disabled="connecting"
            @click="requestCall(roomId)"
          >
            通話する
          </button>
        </div>
      </div>

      <!-- 未完了の IT点呼 (運行管理者の判定がまだ確定していない記録) -->
      <div class="space-y-3" data-testid="it-pending">
        <h3 class="text-sm font-semibold text-gray-600">
          未完了の IT点呼
          <span class="ml-1 text-gray-400">({{ pending.length }}件)</span>
        </h3>
        <div v-if="pendingError" class="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {{ pendingError }}
        </div>
        <div v-else-if="pendingLoading && pending.length === 0" class="text-center py-8 text-gray-400 text-sm">
          読み込み中...
        </div>
        <div v-else-if="pending.length === 0" class="text-center py-8 text-gray-400 text-sm">
          未完了の IT点呼 はありません
        </div>
        <div
          v-for="s in pending"
          :key="s.id"
          class="rounded-xl border border-gray-200 bg-white p-4 flex items-center justify-between gap-2"
          data-testid="it-pending-row"
        >
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium text-gray-800 truncate">{{ employeeName(s.employee_id) }}</span>
              <span
                v-if="itTenkoRoomOf(s.id, activeRooms)"
                class="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium"
              >
                通話中
              </span>
            </div>
            <div class="mt-1 text-xs text-gray-500">開始 {{ formatTime(s.started_at ?? s.created_at) }}</div>
          </div>
          <button
            class="shrink-0 px-3 py-1.5 text-sm rounded-lg font-medium transition-colors disabled:opacity-50"
            :disabled="connecting"
            :class="itTenkoRoomOf(s.id, activeRooms)
              ? 'bg-blue-600 hover:bg-blue-700 text-white'
              : 'bg-gray-100 hover:bg-gray-200 text-gray-700'"
            @click="requestRow(s)"
          >
            {{ itTenkoRoomOf(s.id, activeRooms) ? '通話する' : '通話なしで確定する' }}
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- 未登録のまま開こうとしたとき: 社員番号で席に登録してから開く (顔認証はしない) -->
  <div
    v-if="waiting"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
    data-testid="it-manager-id"
  >
    <div class="bg-white rounded-2xl p-4 shadow-xl w-full max-w-lg mx-2">
      <h3 class="text-lg font-semibold text-gray-800 mb-1">点呼開始前の確認</h3>
      <p class="text-sm text-gray-500 mb-4">管理者の社員番号を入力してください</p>
      <div v-if="idError" class="mb-3 rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
        {{ idError }}
      </div>
      <input
        v-model="idInput"
        type="text"
        placeholder="社員番号 (例: 001)"
        class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
        @keyup.enter="onIdSubmit"
      >
      <button
        :disabled="!idInput.trim()"
        class="w-full mt-4 px-6 py-3 bg-blue-600 text-white rounded-xl font-medium disabled:opacity-50 hover:bg-blue-700 transition-colors"
        @click="onIdSubmit"
      >
        次へ
      </button>
      <button
        class="w-full mt-4 text-sm text-gray-500 hover:text-gray-700 underline"
        @click="cancelIdInput"
      >
        キャンセル
      </button>
    </div>
  </div>
</template>
