<script setup lang="ts">
import type { ApiEmployee, TenkoSession, DriverInfo } from '~/types'
import { tenkoStatusLabel } from '~/utils/tenko-status'
import { getEmployeeById, getEmployees, getTenkoSession, getDeviceSettings, getDriverInfo } from '~/utils/api'
import { tenkoTypeLabel } from '~/utils/tenko-type'
import { alcoholResultLabel, alcoholTone } from '~/utils/alcohol'

const props = defineProps<{
  initialRoomId?: string | null
  /**
   * 並べた IT点呼 の画面 (`TenkoDeskView`) が通話中・確認中。このあいだは通話を始めず、指の合図も受けない
   * (マイク・カメラと指静脈の機器を取り合わないため)
   */
  blocked?: boolean
}>()
const emit = defineEmits<{
  /** 通話中・通話前の確認中か (並べた IT点呼 の画面を止めるため) */
  busy: [busy: boolean]
}>()

const config = useRuntimeConfig()
const { authenticatedManagerId, setManagerId, loadFromDevice } = useManagerAuth()

// 管理者側 WebRTC
const webRtc = useWebRtc('admin')
const adminCamera = useCamera()
let adminAudioStream: MediaStream | null = null  // マイク音声 (WebRTC用)
const adminCombinedStream = ref<MediaStream | null>(null)  // 映像+音声 (TenkoVideoCall用)

// シグナリングサーバーからアクティブなルーム(device接続中)一覧を購読 (アプリ全体で 1 本)
const {
  activeRooms: allRooms,
  start: startWatchingRooms,
  stop: stopWatchingRooms,
  setJoined,
  reload: reloadActiveRooms,
} = useActiveRooms()
const activeRooms = computed(() => splitRooms(allRooms.value).remote)
const selectedRoomId = ref<string | null>(null)
const isCallActive = ref(false)
const isLoading = ref(false)
const loadError = ref<string | null>(null)

// デバイスに保存された管理者情報
const deviceManagerName = ref<string | null>(null)
onMounted(async () => {
  loadFromDevice()
  if (authenticatedManagerId.value) {
    try {
      const emp = await getEmployeeById(authenticatedManagerId.value, 'tenko-monitor')
      deviceManagerName.value = emp.name
    }
    catch { deviceManagerName.value = null }
  }
})

// 通話前の確認 (指静脈)。運行管理者の画面の入口 (RoleAuthGate) と同じく指静脈だけで本人を確かめる
// (2026-11-02 ユーザー決定「顔認証外して静脈認証に統一」)
const pendingRoomId = ref<string | null>(null)
const veinConfirmActive = ref(false)

// 本番 flip 後の新版への載せ替えを、待機中のこの画面でも許す (Refs #345)。
// 運行管理者席は遠隔点呼の呼び出しを待って画面を開いたまま待機するので、キオスクと同じく
// ナビゲーションが起きず、申告しないと古い app shell を永久に掴み続ける (#341 の取りこぼし)。
// 通話中・確認中・読み込み中はリロードで失うものがあるので、そのあいだは申告を下ろす。
useKioskScreen().declareSafeToReload(
  () => !isCallActive.value && !veinConfirmActive.value && !isLoading.value,
)
// 通話中・確認中・読み込み中は、席の警告デバイスの更新を始めさせない (Refs ippoan/alc-app#425)。
// リロードの申告 (上) とは別の集合
useKioskScreen().declareDeviceBusy(
  () => isCallActive.value || veinConfirmActive.value || isLoading.value,
)

// 運転者情報パネル
const showDriverInfoPanel = ref(false)

// 運転者情報 (労働時間表示用)
const liveDriverInfo = ref<DriverInfo | null>(null)

// 通話中セッションのリアルタイムデータ
const liveSession = ref<TenkoSession | null>(null)
const liveEmployeeName = ref('')
let sessionPollTimer: ReturnType<typeof setInterval> | null = null

async function startSessionPolling(sessionId: string) {
  stopSessionPolling()
  // 初回即時取得
  await fetchSession(sessionId)
  // 3秒間隔でポーリング
  sessionPollTimer = setInterval(() => fetchSession(sessionId), 3000)
}

function stopSessionPolling() {
  if (sessionPollTimer) { clearInterval(sessionPollTimer); sessionPollTimer = null }
  liveSession.value = null
  liveEmployeeName.value = ''
  liveDriverInfo.value = null
}

async function fetchSession(sessionId: string) {
  try {
    const session = await getTenkoSession(sessionId, 'tenko-monitor')
    liveSession.value = session
    // 社員名 + 運転者情報を取得 (初回のみ)
    if (!liveEmployeeName.value && session.employee_id) {
      try {
        const employees = await getEmployees('tenko-monitor')
        const emp = employees.find(e => e.id === session.employee_id)
        if (emp) liveEmployeeName.value = emp.name
      } catch { /* ignore */ }
      try {
        liveDriverInfo.value = await getDriverInfo(session.employee_id, 'tenko-monitor')
      } catch { /* ignore */ }
    }
  } catch { /* セッション未作成の場合は無視 */ }
}

// 表示名は `~/utils/tenko-status.ts` に集約 (Refs ippoan/alc-app#343)
const statusLabel = tenkoStatusLabel

function statusColor(s: string) {
  if (s === 'completed') return 'bg-green-100 text-green-800'
  if (s === 'cancelled') return 'bg-red-100 text-red-800'
  if (s === 'interrupted') return 'bg-orange-100 text-orange-800'
  return 'bg-yellow-100 text-yellow-800'
}

function alcoholLabel(r: string | null, v: number | null) {
  if (!r) return '-'
  // pass / fail は遠隔点呼だけの値で helper に無いのでここに残す
  const extra: Record<string, string> = { pass: '正常', fail: '検出' }
  return extra[r] ?? alcoholResultLabel(r, v ?? 0)
}

function alcoholColor(r: string | null, v: number | null) {
  if (!r) return ''
  // 緑かそれ以外か。判定は alcoholTone に集約 (pass は normal として読む)
  if (alcoholTone(r === 'pass' ? 'normal' : r, v ?? 0) === 'green') return 'text-green-700'
  return 'text-red-700 font-semibold'
}

function safetyLabel(sj: TenkoSession['safety_judgment']) {
  if (!sj) return '-'
  return sj.status === 'pass' ? '合格' : '不合格'
}

function safetyColor(sj: TenkoSession['safety_judgment']) {
  if (!sj) return ''
  return sj.status === 'pass' ? 'text-green-700' : 'text-red-700 font-semibold'
}

function selfDeclLabel(key: string) {
  const map: Record<string, string> = { illness: '疾病', fatigue: '疲労', sleep_deprivation: '睡眠不足' }
  return map[key] || key
}

// WebSocket用: https://→wss:// または http://→ws://
const signalingWsUrl = (config.public.signalingUrl as string).replace(/^https/, 'wss').replace(/^http:/, 'ws:')

/** 並べた IT点呼 の画面が通話中で、通話を始められなかった */
const blockedByIt = ref(false)
watch(() => props.blocked, (b) => { if (!b) blockedByIt.value = false })

// セッションカードクリック → 指静脈の確認を出す
function requestCall(roomId: string) {
  if (props.blocked) {
    blockedByIt.value = true
    return
  }
  pendingRoomId.value = roomId
  veinConfirmActive.value = true
}

/**
 * 指静脈で特定できた人を確かめて通話を始める。運行管理者・管理者でなければ理由を返す (確認は閉じない)。
 * 確かめた人をこの端末の運行管理者として控える (判定の記録に使う)
 */
async function onManagerVein(emp: ApiEmployee): Promise<string | null> {
  if (!emp.role.includes('manager') && !emp.role.includes('admin')) {
    return `${emp.name}さんには運行管理者の権限がありません`
  }
  setManagerId(emp.id)
  deviceManagerName.value = emp.name
  veinConfirmActive.value = false
  const roomId = pendingRoomId.value
  if (roomId) await startCall(roomId)
  return null
}

watch(() => isCallActive.value || veinConfirmActive.value, b => emit('busy', b), { immediate: true })

function cancelVeinConfirm() {
  veinConfirmActive.value = false
  pendingRoomId.value = null
}

async function loadActiveRooms() {
  isLoading.value = true
  loadError.value = null
  if (!await reloadActiveRooms()) {
    loadError.value = '接続中デバイスの取得に失敗しました'
  }
  isLoading.value = false
}

async function startCall(roomId: string) {
  if (isCallActive.value) {
    webRtc.disconnect()
    adminCamera.stop()
    adminAudioStream?.getTracks().forEach(t => t.stop())
    adminAudioStream = null
    isCallActive.value = false
    setJoined(null)
  }

  selectedRoomId.value = roomId
  try {
    await adminCamera.start('user')
    // カメラ映像 + マイク音声を合成して送信
    let streamToSend = adminCamera.stream.value
    try {
      adminAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      if (streamToSend) {
        streamToSend = new MediaStream([
          ...streamToSend.getVideoTracks(),
          ...adminAudioStream.getAudioTracks(),
        ])
      }
    }
    catch {
      // マイク拒否時はビデオのみで続行
    }
    adminCombinedStream.value = streamToSend
    await webRtc.connect(signalingWsUrl, roomId)
    if (streamToSend) {
      await webRtc.startStreaming(streamToSend)
    }
    isCallActive.value = true
    setJoined(roomId)
    startSessionPolling(roomId)
  }
  catch {
    loadError.value = 'ビデオ通話の開始に失敗しました'
  }
}

function endCall() {
  stopSessionPolling()
  webRtc.disconnect()
  adminCamera.stop()
  adminAudioStream?.getTracks().forEach(t => t.stop())
  adminAudioStream = null
  adminCombinedStream.value = null
  isCallActive.value = false
  selectedRoomId.value = null
  setJoined(null)
}

/**
 * 判定を送ったら通話を終えて一覧へ戻る (IT点呼の `TenkoItAdminView` の `onJudged` と同じ)。
 * 残すと画面が閉じず、もう一度押して「判定の送信に失敗しました」になる (2026-11-02 実機)
 */
function onJudged(): void {
  endCall()
  liveSession.value = null
}

const { deviceId, deviceSettingsToken } = useAuth()

onMounted(async () => {
  // 着信通知モード: ルーム読み込みより先に管理者IDを復元 (requestCall で id_input スキップするため)
  if (props.initialRoomId && !authenticatedManagerId.value && deviceId.value) {
    try {
      const settings = await getDeviceSettings(deviceId.value, deviceSettingsToken.value)
      if (settings.last_login_employee_id) {
        setManagerId(settings.last_login_employee_id)
      }
    } catch { /* best effort */ }
  }

  loadActiveRooms()
  startWatchingRooms()
})

// initialRoomId 指定時、ルームが現れたら自動で requestCall
const autoConnectTriggered = ref(false)
watch(activeRooms, (rooms) => {
  if (props.initialRoomId && !autoConnectTriggered.value && rooms.includes(props.initialRoomId) && !isCallActive.value && !veinConfirmActive.value) {
    autoConnectTriggered.value = true
    requestCall(props.initialRoomId)
  }
})

onUnmounted(() => {
  stopSessionPolling()
  stopWatchingRooms()
  webRtc.disconnect()
  adminCamera.stop()
  adminAudioStream?.getTracks().forEach(t => t.stop())
  adminAudioStream = null
  adminCombinedStream.value = null
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-bold text-gray-800">遠隔点呼モニター</h2>
      <button
        class="text-sm px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 transition-colors"
        :disabled="isLoading"
        @click="loadActiveRooms"
      >
        更新
      </button>
    </div>

    <div v-if="blockedByIt" class="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800" data-testid="remote-blocked-by-it">
      IT点呼の通話中です。終わってから応答してください
    </div>
    <div v-if="loadError" class="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
      {{ loadError }}
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <!-- 左: ビデオ通話パネル -->
      <div class="space-y-3">
        <h3 class="text-sm font-semibold text-gray-600">ビデオ通話</h3>

        <div v-if="selectedRoomId && isCallActive">
          <TenkoVideoCall
            :local-stream="adminCombinedStream"
            :remote-stream="webRtc.remoteStream.value"
            :is-peer-connected="webRtc.isPeerConnected.value"
            :is-connected="webRtc.isConnected.value"
          />

          <div class="mt-2 rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 text-sm">
            <div class="font-semibold text-blue-800">接続中</div>
            <div class="text-blue-500 text-xs mt-0.5 font-mono">{{ selectedRoomId }}</div>
          </div>

          <div class="mt-2">
            <button
              class="w-full py-2 text-sm rounded-lg bg-red-100 hover:bg-red-200 text-red-700 font-medium transition-colors"
              @click="endCall"
            >
              通話終了
            </button>
          </div>
        </div>

        <div
          v-else
          class="flex items-center justify-center aspect-video rounded-xl bg-gray-100 text-gray-400 text-sm"
        >
          右のリストからデバイスを選択して通話開始
        </div>
      </div>

      <!-- 右: 接続中デバイス一覧 -->
      <div class="space-y-3">
        <h3 class="text-sm font-semibold text-gray-600">
          接続待ちデバイス
          <span class="ml-1 text-gray-400">({{ activeRooms.length }}台)</span>
        </h3>

        <div v-if="isLoading && activeRooms.length === 0" class="text-center py-8 text-gray-400 text-sm">
          読み込み中...
        </div>

        <div v-else-if="activeRooms.length === 0" class="text-center py-8 text-gray-400 text-sm">
          接続中のデバイスはありません
        </div>

        <div
          v-for="roomId in activeRooms"
          :key="roomId"
          class="rounded-xl border p-4 cursor-pointer transition-colors"
          :class="selectedRoomId === roomId && isCallActive
            ? 'border-blue-400 bg-blue-50'
            : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'"
          @click="requestCall(roomId)"
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span class="text-sm font-medium text-gray-800">デバイス接続中</span>
            </div>
            <span class="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">
              待機中
            </span>
          </div>
          <div class="mt-1 text-xs text-gray-400 font-mono truncate">{{ roomId }}</div>
          <div class="mt-2 text-xs text-blue-600 font-medium">
            クリックして通話開始 →
          </div>
        </div>
      </div>
    </div>

  </div>

  <!-- 通話中全画面オーバーレイ -->
  <div
    v-if="isCallActive && selectedRoomId"
    class="fixed inset-0 z-40 bg-gray-900 flex flex-col"
  >
    <!-- 上: ビデオエリア (PiP・ボタン含む) -->
    <div class="flex-1 relative min-h-0">
      <TenkoVideoCall
        :local-stream="adminCombinedStream"
        :remote-stream="webRtc.remoteStream.value"
        :is-peer-connected="webRtc.isPeerConnected.value"
        :is-connected="webRtc.isConnected.value"
        :fullscreen="true"
        class="w-full h-full"
      />
      <!-- 通話終了ボタン + 運転者情報ボタン (右上) -->
      <div class="absolute top-3 right-3 flex gap-2 z-10">
        <button
          v-if="liveSession?.employee_id"
          class="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium shadow-lg transition-colors"
          @click="showDriverInfoPanel = !showDriverInfoPanel"
        >
          {{ showDriverInfoPanel ? '情報を閉じる' : '運転者情報' }}
        </button>
        <button
          class="px-4 py-2 text-sm rounded-lg bg-red-600 hover:bg-red-700 text-white font-medium shadow-lg transition-colors"
          @click="endCall"
        >
          通話終了
        </button>
      </div>

      <!-- 運転者情報パネル -->
      <TenkoDriverInfoPanel
        v-if="showDriverInfoPanel && liveSession?.employee_id"
        :employee-id="liveSession.employee_id"
        :session-id="liveSession.id"
        scope="tenko-monitor"
        @close="showDriverInfoPanel = false"
      />
    </div>

    <!-- 乗務員の端末が申告した端末 ID に紐づく拠点カメラ。通話を終えるとオーバーレイごと外れて切れる -->
    <div v-if="webRtc.peerDeviceId.value" class="shrink-0 bg-gray-800 px-3 py-2">
      <TenkoSiteCameras :device-id="webRtc.peerDeviceId.value" />
    </div>

    <!-- 下: 点呼データテーブル -->
    <div v-if="liveSession" class="shrink-0 bg-white">
      <!-- ヘッダー -->
      <div class="px-3 py-1 border-b border-gray-200 flex items-center gap-2">
        <span class="font-bold text-sm text-gray-800">{{ liveEmployeeName || liveSession.employee_id.slice(0, 8) }}</span>
        <span class="text-xs px-1.5 py-0.5 rounded-full" :class="liveSession.tenko_type === 'pre_operation' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'">
          {{ tenkoTypeLabel(liveSession.tenko_type) }}
        </span>
        <span class="text-xs px-1.5 py-0.5 rounded-full" :class="statusColor(liveSession.status)">
          {{ statusLabel(liveSession.status) }}
        </span>
        <!--
          自動点呼から切り替わってきた点呼の印 (Refs ippoan/alc-app-s3#135)。
          血圧が測れず遠隔へ移ってきた点呼は、最初から遠隔の点呼と扱いが違う
          (運行管理者が血圧を口頭で確認する) ので、一目で分かるようにする。
          値を埋めるのはサーバ側の別 PR。
        -->
        <span
          v-if="liveSession.escalated_to_remote_at"
          class="text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 font-bold"
        >
          自動点呼から切替
        </span>
      </div>
      <!-- データ項目 -->
      <div class="divide-y divide-gray-100">
        <div class="px-3 py-1 flex justify-between items-center">
          <span class="text-xs text-gray-500">アルコール</span>
          <div class="text-right">
            <span class="text-sm font-semibold" :class="alcoholColor(liveSession.alcohol_result, liveSession.alcohol_value)">{{ alcoholLabel(liveSession.alcohol_result, liveSession.alcohol_value) }}</span>
            <span v-if="liveSession.alcohol_value != null" class="text-xs text-gray-500 ml-1">{{ liveSession.alcohol_value }} mg/L</span>
          </div>
        </div>
        <div class="px-3 py-1 flex justify-between items-center">
          <span class="text-xs text-gray-500">体温</span>
          <span class="text-sm font-semibold text-gray-800">{{ liveSession.temperature != null ? `${liveSession.temperature}°C` : '-' }}</span>
        </div>
        <div class="px-3 py-1 flex justify-between items-center">
          <span class="text-xs text-gray-500">血圧</span>
          <span class="text-sm font-semibold text-gray-800">{{ liveSession.systolic != null && liveSession.diastolic != null ? `${liveSession.systolic}/${liveSession.diastolic} mmHg` : '-' }}</span>
        </div>
        <div class="px-3 py-1 flex justify-between items-center">
          <span class="text-xs text-gray-500">脈拍</span>
          <span class="text-sm font-semibold text-gray-800">{{ liveSession.pulse != null ? `${liveSession.pulse} bpm` : '-' }}</span>
        </div>
        <div class="px-3 py-1 flex justify-between items-center">
          <span class="text-xs text-gray-500">自己申告</span>
          <div v-if="liveSession.self_declaration" class="text-right">
            <template v-for="(val, key) in { illness: liveSession.self_declaration.illness, fatigue: liveSession.self_declaration.fatigue, sleep_deprivation: liveSession.self_declaration.sleep_deprivation }" :key="key">
              <span v-if="val" class="inline-block ml-1 text-xs px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">{{ selfDeclLabel(key) }}</span>
            </template>
            <span v-if="!liveSession.self_declaration.illness && !liveSession.self_declaration.fatigue && !liveSession.self_declaration.sleep_deprivation" class="text-sm text-green-700 font-semibold">異常なし</span>
          </div>
          <span v-else class="text-sm text-gray-400">-</span>
        </div>
        <div class="px-3 py-1 flex justify-between items-center">
          <span class="text-xs text-gray-500">安全判定</span>
          <div class="text-right">
            <span class="text-sm font-semibold" :class="safetyColor(liveSession.safety_judgment)">{{ safetyLabel(liveSession.safety_judgment) }}</span>
            <span v-if="liveSession.safety_judgment?.failed_items?.length" class="text-xs text-red-600 ml-1">{{ liveSession.safety_judgment.failed_items.join(', ') }}</span>
          </div>
        </div>
        <div class="px-3 py-1 flex justify-between items-center">
          <span class="text-xs text-gray-500">日常点検</span>
          <div v-if="liveSession.daily_inspection">
            <span v-if="['brakes','tires','lights','steering','wipers','mirrors','horn','seatbelts'].every(k => (liveSession!.daily_inspection as any)[k] === 'ok')" class="text-sm text-green-700 font-semibold">全項目OK</span>
            <span v-else class="text-sm text-red-700 font-semibold">NG あり</span>
          </div>
          <span v-else class="text-sm text-gray-400">-</span>
        </div>
        <!-- 直近労働時間 -->
        <div v-if="liveDriverInfo?.working_hours?.length" class="px-3 py-1">
          <span class="text-xs text-gray-500">直近労働時間</span>
          <div class="mt-0.5 grid grid-cols-5 gap-x-2 text-xs">
            <span class="text-gray-400">日付</span>
            <span class="text-gray-400 text-right">拘束</span>
            <span class="text-gray-400 text-right">運転</span>
            <span class="text-gray-400 text-right">荷役</span>
            <span class="text-gray-400 text-right">深夜</span>
            <template v-for="wh in liveDriverInfo.working_hours.slice(0, 3)" :key="wh.id">
              <span>{{ new Date(wh.work_date).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) }}</span>
              <span class="text-right font-mono">{{ wh.total_work_minutes != null ? `${Math.floor(wh.total_work_minutes / 60)}:${String(wh.total_work_minutes % 60).padStart(2, '0')}` : '-' }}</span>
              <span class="text-right font-mono">{{ `${Math.floor(wh.drive_minutes / 60)}:${String(wh.drive_minutes % 60).padStart(2, '0')}` }}</span>
              <span class="text-right font-mono">{{ `${Math.floor(wh.cargo_minutes / 60)}:${String(wh.cargo_minutes % 60).padStart(2, '0')}` }}</span>
              <span class="text-right font-mono" :class="wh.late_night_minutes > 0 ? 'text-purple-600' : ''">{{ `${Math.floor(wh.late_night_minutes / 60)}:${String(wh.late_night_minutes % 60).padStart(2, '0')}` }}</span>
            </template>
          </div>
        </div>
        <div class="px-3 py-1 flex justify-between items-center">
          <span class="text-xs text-gray-500">担当管理者</span>
          <span class="text-sm text-gray-800">{{ liveSession.responsible_manager_name || '-' }}</span>
        </div>
      </div>

      <!-- 運行管理者の判定 (Refs ippoan/alc-app#315。safety_judgment とは別物) -->
      <div class="px-3 py-2 border-t border-gray-100">
        <TenkoManagerJudgmentPanel
          :session="liveSession"
          :manager-id="authenticatedManagerId"
          wait-for-driver
          @judged="onJudged"
        />
      </div>
    </div>
  </div>

  <!-- 通話前の確認 (指静脈) -->
  <div
    v-if="veinConfirmActive"
    data-testid="remote-vein-confirm"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
  >
    <div class="bg-white rounded-2xl p-4 shadow-xl w-full max-w-lg mx-2 max-h-[95vh] overflow-y-auto">
      <h3 class="text-lg font-semibold text-gray-800 mb-1">点呼開始前の確認</h3>
      <ItTenkoVeinRegister
        :on-employee="onManagerVein"
        :idle="veinConfirmActive && !isCallActive && !blocked"
        auto
        miss-message="指静脈が一致する人が見つかりません。もう一度置いてください"
      />
      <button
        class="w-full mt-4 text-sm text-gray-500 hover:text-gray-700 underline"
        @click="cancelVeinConfirm"
      >
        キャンセル
      </button>
    </div>
  </div>
</template>
