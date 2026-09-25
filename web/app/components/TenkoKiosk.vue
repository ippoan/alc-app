<script setup lang="ts">
import type { FaceAuthResult, MeasurementResult, SubmitMedicalData, TenkoRemoteEscalationReason } from '~/types'
import type { TenkoStep } from '~/composables/useTenkoKiosk'
import { TENKO_REMOTE_ESCALATION_REASONS } from '~/types'
import { getEmployeeByNfcId, getEmployeeByCode, startMeasurement, updateMeasurement } from '~/utils/api'
import { checkFaceApproval } from '~/utils/face-approval'
import { employeeNotFoundByNfc, employeeNotFoundByCode } from '~/utils/employee-lookup-messages'
import { tenkoTypeLabel } from '~/utils/tenko-type'
import { identifyVeinEmployee, syncVeinTemplates, VEIN_NO_MATCH_MESSAGE, VEIN_TEMPLATE_SYNC_INTERVAL_MS } from '~/utils/vein-identify'

const props = defineProps<{
  demoMode?: boolean
  remoteMode?: boolean
  landscape?: boolean
}>()

// シングルトン再呼出で共有状態取得
const { isSyncing: isFaceSyncing } = useFaceSync()

// デモモード (prop 優先、なければ URL クエリ)
const { isDemoMode: isDemoModeFromUrl } = useDemoMode()
const isDemoMode = computed(() => props.demoMode || isDemoModeFromUrl.value)

// --- 遠隔点呼 WebRTC (インスタンス生成のみ; watch は useTenkoKiosk 後に設定) ---
const config = useRuntimeConfig()
const webRtc = useWebRtc('device')
const camera = useCamera()
let audioStream: MediaStream | null = null  // マイク音声 (WebRTC用)
const combinedStream = ref<MediaStream | null>(null)  // 映像+音声 (TenkoVideoCall用)

// 点呼キオスク状態管理
const {
  step, employeeId, employeeName, pendingSchedules, resumableSessions, selectedSchedule, selectedTenkoType, session,
  error, isLoading, safetyJudgment, tenkoType, isPreOperation,
  escalatedToRemote, escalationReason, isRemote, escalateToRemote,
  stepLabels, currentStepIndex,
  bpRequirementUnknown, retryBpRequirement,
  identifyEmployee, selectSchedule, resumeSession, proceedWithoutSchedule, onFaceAuthComplete,
  onAlcoholResult, onMedicalSubmit, onSelfDeclarationSubmit,
  onDailyInspectionSubmit, carryingItems, loadCarryingItems, onCarryingItemsSubmit,
  onInstructionConfirm, onReportSubmit,
  reset,
} = useTenkoKiosk({ remoteMode: props.remoteMode, allowResume: true })

// carrying_items ステップに入ったら携行品マスタをロード
watch(() => step.value, (s) => {
  if (s === 'carrying_items') loadCarryingItems()
})

// --- アルコール測定の録画と測定レコード (Refs ippoan/alc-app#349) ---
// 通常点呼 (`NormalMeasurement`) と同じ `useBlowVideoRecording` を使う。同じ
// component を通る**自動点呼と遠隔点呼の両方**にこれで録画が付く (アルコールの段は
// `isRemote` で分岐していない)。
const {
  videoRef: blowVideoRef,
  isCameraActive: isBlowCameraActive,
  isRecording: isBlowRecording,
  uploadStatus: blowVideoUploadStatus,
  retryPendingUploads: retryPendingVideoUploads,
  startCamera: startBlowCamera,
  onAlcStateChange,
  finishRecording: finishBlowRecording,
  uploadRecording: uploadBlowRecording,
  reset: resetBlowRecording,
} = useBlowVideoRecording()

onMounted(() => {
  // 7 日超のローカル録画を削除 + 未アップロード分をリトライ
  void retryPendingVideoUploads()
})

/**
 * この点呼のアルコール測定の `measurements` 行 (Refs ippoan/alc-app#349)。
 *
 * **`POST /api/measurements/start` → `PUT /api/measurements/{id}` の 2 本だけを使う。**
 * `saveMeasurement` (`POST /api/measurements`、`record_as_tenko: true`) は使わない —
 * あれは `rust-alc-api` 側で `normal_tenko::record` を走らせるので、既に点呼セッションが
 * あるキオスクから呼ぶと `tenko_method = 通常点呼` のセッションがもう 1 本でき、
 * CSV に同じ点呼が二重に (しかも別方式で) 出る。
 *
 * どちらの口も auth-worker の `KIOSK_ROUTES` に入っているので、キオスクの device JWT で
 * `/api/proxy` 経由で通る。
 */
const alcoholMeasurementId = ref<string | null>(null)

/** 測定レコードを先に作る (best-effort: 失敗しても点呼は続ける) */
async function startAlcoholMeasurement() {
  if (!employeeId.value || alcoholMeasurementId.value) return
  try {
    const m = await startMeasurement(employeeId.value)
    alcoholMeasurementId.value = m.id
  }
  catch (e) {
    console.warn('[TenkoKiosk] startMeasurement failed:', e)
    alcoholMeasurementId.value = null
  }
}

/**
 * 測定レコードを completed にする (best-effort)。**`record_as_tenko` は載せない**。
 *
 * **待たない。** `submitAlcohol` が要るのは `measurement_id` だけで、この PUT の完了は
 * 前提条件ではない。待つと、API が詰まったときに乗務員がアルコールの段で最大 30 秒
 * (`DEFAULT_FETCH_TIMEOUT_MS`) 足止めされる。
 */
function completeAlcoholMeasurement(id: string, result: MeasurementResult) {
  void updateMeasurement(id, {
    status: 'completed',
    alcohol_value: result.alcoholValue,
    result_type: result.resultType,
    device_use_count: result.deviceUseCount,
    face_photo_url: result.facePhotoUrl,
    measured_at: result.measuredAt.toISOString(),
    tenko_type: tenkoType.value ?? undefined,
  }).catch(e => console.warn('[TenkoKiosk] updateMeasurement failed:', e))
}

// アルコールの段に入ったら録画カメラを起こし、測定レコードを作る。
// **カメラを先に** — プレビューはローカルなので即出せる。逆順にすると
// `startMeasurement` が詰まっている間プレビューが出ない
watch(step, async (s) => {
  if (s !== 'alcohol') return
  // デモモードは FC-1200 の state 変化が来ないので即録画
  await startBlowCamera({ recordImmediately: isDemoMode.value })
  await startAlcoholMeasurement()
})

// PC の今の段を CoreS3 に送り、画面を連動させる (Refs ippoan/alc-app-s3#135)
const { syncStep, sendResult } = useCoreS3Stage()
watch(step, syncStep, { immediate: true })

// 本番 flip 後の新版への載せ替えを「最初の画面に居るとき」だけ許すための現在地 (Refs #338)。
// `useTenkoKiosk` の state は component ごとの素の ref で外からは読めないので、ここで出す。
// 入口で止まっている間 (bpRequirementUnknown) と読み込み中は、リロードで止めた理由や
// 照会中の要求が消えるため busy 扱いにする。
useKioskScreen().track(() => ({
  step: step.value,
  busy: bpRequirementUnknown.value || isLoading.value,
}))

/**
 * 遠隔点呼で映像を繋ぐ段 (Refs ippoan/alc-app-s3#135)。
 *
 * **血圧の段 (`medical`) を含めるのが肝。** 血圧が測れず遠隔へ切り替えるのはこの段で、
 * signaling の部屋は**接続したときに登録される**ため、ここで繋がないと切り替えても
 * 運行管理者の一覧に出てこない。
 */
const REMOTE_CONNECT_STEPS: TenkoStep[] = ['medical', 'instruction', 'report']
/** 映像を繋ぐべき状態か。段だけでなく「いま遠隔か」も見るので、段の途中で切り替えても発火する */
const shouldConnectRemote = computed(
  () => isRemote.value && REMOTE_CONNECT_STEPS.includes(step.value),
)
/** 通話パネルの表示。繋ぐ段に加えて完了画面でも残す (従来どおり) */
const showVideoCall = computed(
  () => isRemote.value && (REMOTE_CONNECT_STEPS.includes(step.value) || step.value === 'completed'),
)

// 遠隔点呼: 繋ぐべき状態になったら WebRTC 接続
watch(shouldConnectRemote, async (connectNow) => {
  if (!connectNow || !session.value?.id) return
  try {
    await camera.start('user')
    // カメラ映像 + マイク音声を合成して送信
    let streamToSend = camera.stream.value
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
    combinedStream.value = streamToSend
    await webRtc.connect(config.public.signalingUrl, session.value.id)
    if (streamToSend) {
      await webRtc.startStreaming(streamToSend)
    }
  }
  catch {
    // カメラ/WebRTC 失敗は点呼フローをブロックしない
  }
})

// 管理者が切断 → オーバーレイ表示
const hadPeerConnected = ref(false)
watch(
  () => webRtc.isPeerConnected.value,
  (connected) => {
    if (!isRemote.value) return
    if (connected) hadPeerConnected.value = true
  }
)
const isDisconnected = computed(
  () => isRemote.value && hadPeerConnected.value && !webRtc.isPeerConnected.value
)

async function reconnect() {
  if (!session.value?.id) return
  try {
    await webRtc.connect(config.public.signalingUrl, session.value.id)
    if (camera.stream.value) await webRtc.startStreaming(camera.stream.value)
  } catch {
    // 失敗しても点呼フローはブロックしない
  }
}

// BLE Medical Gateway (体温・血圧)
const {
  latestTemperature: bleTemperature,
  latestBloodPressure: bleBloodPressure,
} = useBleGateway()

/**
 * この端末で血圧を使うか (Refs ippoan/alc-app-s3#135 / ippoan/alc-app#347)。
 * `BleStatus` / `ManualMedicalInput` と同じ `useBpUiEnabled()` を見る — 以前の
 * `bpEnabled` 単独では、CoreS3 キオスクで血圧が必須なのに「遠隔点呼に切り替える」の
 * 逃げ道が出なかった。
 */
const { showBpUi } = useBpUiEnabled()

// 医療ステップ: BLE / 手動入力 タブ
const medicalInputTab = ref<'ble' | 'manual'>('ble')
watch(isDemoMode, (v) => {
  if (v) medicalInputTab.value = 'manual'
}, { immediate: true })

// --- NFC / 手動入力 ---
const manualIdInput = ref('')
const useManualInput = ref(false)
const manualError = ref<string | null>(null)

// 乗務員の点呼は、顔を登録していない人を止めない — 顔が未登録なら顔認証を飛ばせる
// (Refs ippoan/alc-app-s3#135)。審査中・却下は登録済みなので従来どおり弾く。
// 判定は utils/face-approval.ts の 1 か所だけで、**通すかどうかの方針をこの入口が
// 決める** (運行管理者の入口 RoleAuthGate は未登録でも通さない)。
const faceSkippable = ref(false)
const faceSkipNotice = ref<string | null>(null)

/** 通してよければ true。通す場合はスキップ可否も控える */
function applyFaceApproval(emp: { name: string; face_approval_status?: string }): boolean {
  const approval = checkFaceApproval(emp)
  if (approval.kind === 'blocked') { error.value = approval.message; return false }
  faceSkippable.value = approval.kind === 'unregistered'
  faceSkipNotice.value = approval.kind === 'unregistered'
    ? `${approval.message}。顔認証をスキップして進めます`
    : null
  return true
}

function skipFaceAuth() {
  onFaceAuthResult({ verified: true, similarity: 0, skipped: true })
}

async function onNfcRead(nfcId: string) {
  try {
    const emp = await getEmployeeByNfcId(nfcId)
    if (!applyFaceApproval(emp)) return
    await identifyEmployee(emp.id, emp.name)
  } catch {
    error.value = employeeNotFoundByNfc(nfcId)
  }
}

async function onManualSubmit() {
  const input = manualIdInput.value.trim()
  if (!input) return
  manualError.value = null
  try {
    const emp = await getEmployeeByCode(input)
    if (!applyFaceApproval(emp)) return
    await identifyEmployee(emp.id, emp.name)
  } catch {
    manualError.value = employeeNotFoundByCode(input)
  }
}

// --- 指静脈 (Refs ippoan/vein-match#20) ---
// 本人確認の主は指静脈、顔認証はサブ。NFC・社員番号と並ぶ 3 つ目の手段で、当たったあとは
// NFC と同じ手順 (applyFaceApproval → identifyEmployee) に合流する — 顔の記録・顔認証は変えない。
// 指静脈が使えないとき (端末が無い・外れ・読み取り失敗) は NFC と社員番号がそのまま逃げ道になる。
const veinSerial = useVeinSerial()
const veinBusy = ref(false)
const veinError = ref<string | null>(null)

/** ボタンを押せない理由。`null` なら押せる */
const veinDisabledReason = computed<string | null>(() =>
  veinSerial.isConnected.value ? null : 'Vein Station (指静脈読み取り端末) が接続されていません',
)

onMounted(() => {
  void veinSerial.connect()
  // キオスクの起動時: オフラインの照合に使う写しを取る
  void syncVeinTemplates()
})

// 点呼の開始時 (最初の画面に戻ったとき): 前回の同期から時間がたっていれば取り直す
watch(step, (s) => {
  if (s === 'nfc') void syncVeinTemplates({ ifOlderThanMs: VEIN_TEMPLATE_SYNC_INTERVAL_MS })
})

/** 指静脈で乗務員を特定する。失敗したら画面に出す理由を返す */
async function identifyByVein(): Promise<string | null> {
  let chara: string
  try {
    await veinSerial.say('PLACE')
    chara = await veinSerial.capture()
  }
  catch (e) {
    return `指静脈を読み取れませんでした (${(e as Error).message})`
  }
  const outcome = await identifyVeinEmployee(chara)
  if (outcome.kind === 'miss') return VEIN_NO_MATCH_MESSAGE
  if (outcome.kind === 'error') return outcome.message
  // 顔の承認で止めたときは NFC と同じくグローバルエラーに理由が出る
  if (!applyFaceApproval(outcome.employee)) return null
  await identifyEmployee(outcome.employee.id, outcome.employee.name)
  return null
}

async function onVeinIdentify() {
  if (veinDisabledReason.value || veinBusy.value) return
  veinBusy.value = true
  veinError.value = null
  const failure = await identifyByVein()
  if (failure) {
    veinError.value = failure
    // 案内の失敗は握り潰す (画面の理由が主)
    await veinSerial.say('FAILED').catch(() => {})
  }
  veinBusy.value = false
}

// --- 端末のシリアル OTA (Refs ippoan/alc-app-s3#279) ---
// 管理者が /device/setup で「最新にする」を押すと、recorder が購読 WS に合図を送る。
// 点呼の途中では走らせず、待機画面 (NFC 待ち・指静脈の読み取り中でない) のときだけ走らせる。
// 途中で受けた合図は預けておき、待機画面へ戻ったときに走らせる。
// 購読 WS は打刻一覧の画面 (TodayPunchHistory) と同じもの — 両者は driverSubTab の v-if で
// 同時に出ないので、キオスク 1 台の購読は 1 本のまま
const serialOta = useSerialOta()
const isKioskIdle = computed(() => step.value === 'nfc' && !veinBusy.value)
const otaWatch = useTimecardWatch({
  getToken: () => useDeviceToken().getDeviceJwt(),
  onSerialOta: (target) => {
    serialOta.enqueue(target)
    if (isKioskIdle.value) void serialOta.runQueued()
  },
})
watch(isKioskIdle, (idle) => {
  if (idle) void serialOta.runQueued()
})
onMounted(() => {
  // デモは実機が無いので購読しない
  if (!isDemoMode.value) void otaWatch.connect()
})

/** 画面全体に出す OTA の表示 (`null` なら出さない) */
const serialOtaMessage = computed<string | null>(() => {
  const s = serialOta.state.value
  switch (s.kind) {
    case 'idle': return null
    case 'downloading': return '端末を更新しています 0%'
    case 'writing': return `端末を更新しています ${s.pct}%`
    case 'rebooting':
    case 'confirming': return '端末を再起動しています…'
    case 'done': return `更新しました ${s.ver}`
    case 'failed': return '更新できませんでした (元の版のまま)'
  }
})

// --- 顔認証結果 ---
function onFaceAuthResult(result: FaceAuthResult) {
  if (result.verified) {
    if (employeeId.value) authorizeEmployee(employeeId.value)
    onFaceAuthComplete(result)
  }
}

// 指紋認証 (Android Bridge)
const {
  isFingerprintAvailable,
  isEmployeeAuthorized,
  authorizeEmployee,
  requestFingerprint: triggerFingerprint,
} = useFingerprint()

const canUseFingerprint = computed(() =>
  isFingerprintAvailable.value && employeeId.value && isEmployeeAuthorized(employeeId.value),
)

function requestFingerprint() {
  triggerFingerprint()
}

onMounted(() => {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail
    if (detail?.success) {
      onFaceAuthComplete({ verified: true, similarity: 1.0 })
    }
  }
  window.addEventListener('fingerprint-result', handler)
  onUnmounted(() => window.removeEventListener('fingerprint-result', handler))
})

// --- アルコール測定結果 ---
async function onMeasurementResult(result: MeasurementResult) {
  const alcoholResult = result.resultType === 'normal' ? 'pass' : 'fail'
  const measurementId = alcoholMeasurementId.value
  // **段を進める前に**録画を止めて blob を確定させる (進めると段が unmount される)
  await finishBlowRecording(employeeId.value, measurementId ?? undefined)
  if (measurementId) {
    completeAlcoholMeasurement(measurementId, result)
    uploadBlowRecording(measurementId)
  }
  onAlcoholResult(alcoholResult, result.alcoholValue, measurementId ?? undefined)
  sendResult(result)
}

// --- BLE 医療データ → 送信 ---
function onMedicalNext() {
  medicalInputSource.value = 'ble'
  const data: SubmitMedicalData = {}
  if (bleTemperature.value) {
    data.temperature = bleTemperature.value.value
    data.medical_measured_at = bleTemperature.value.measuredAt.toISOString()
  }
  if (bleBloodPressure.value) {
    data.systolic = bleBloodPressure.value.systolic
    data.diastolic = bleBloodPressure.value.diastolic
    data.pulse = bleBloodPressure.value.pulse
    if (!data.medical_measured_at) {
      data.medical_measured_at = bleBloodPressure.value.measuredAt.toISOString()
    }
  }
  onMedicalSubmit(data)
}

// 医療データ入力元トラッキング
const medicalInputSource = ref<'ble' | 'manual' | null>(null)

// --- 遠隔点呼への切り替え (Refs ippoan/alc-app-s3#135) ---
// 理由は自由入力にせず選択肢から選ばせる (サーバが `reason` を必須で受け、後で集計する)
const isChoosingEscalationReason = ref(false)

function chooseEscalationReason(reason: TenkoRemoteEscalationReason) {
  isChoosingEscalationReason.value = false
  escalateToRemote(reason)
}

// 手動入力からの医療データ送信
function onManualMedicalSubmit(data: SubmitMedicalData) {
  medicalInputSource.value = 'manual'
  onMedicalSubmit(data)
}

/** 映像・音声を止める。遠隔だったときだけ呼ぶ */
function stopRemoteStreams() {
  webRtc.disconnect()
  camera.stop()
  audioStream?.getTracks().forEach(t => t.stop())
  audioStream = null
  combinedStream.value = null
}

// --- リセット時に手動入力もクリア ---
function handleReset() {
  // reset() が昇格を畳んで isRemote を false にするので、**先に**映像を止める
  if (isRemote.value) stopRemoteStreams()
  reset()
  manualIdInput.value = ''
  manualError.value = null
  useManualInput.value = false
  veinError.value = null
  faceSkippable.value = false
  faceSkipNotice.value = null
  medicalInputSource.value = null
  medicalInputTab.value = isDemoMode.value ? 'manual' : 'ble'
  isChoosingEscalationReason.value = false
  alcoholMeasurementId.value = null
  resetBlowRecording()
}

onUnmounted(() => {
  if (isRemote.value) stopRemoteStreams()
})
</script>

<template>
  <div :class="[
    'w-full flex-1 overflow-y-auto p-4',
    landscape ? 'flex gap-4 max-w-4xl mx-auto' : 'flex flex-col items-center'
  ]">
    <!-- 端末のシリアル OTA (Refs ippoan/alc-app-s3#279)。実行中は画面全体を覆って操作させない -->
    <div
      v-if="serialOtaMessage"
      data-testid="serial-ota-overlay"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
    >
      <p class="bg-white rounded-2xl px-8 py-6 text-2xl font-bold text-gray-800 text-center shadow-xl">
        {{ serialOtaMessage }}
      </p>
    </div>
    <!-- 左列 (横画面) / 上部 (縦画面): バナー + ステップ -->
    <div :class="landscape ? 'w-2/5 flex flex-col shrink-0' : 'w-full flex flex-col items-center'">
      <!-- 遠隔点呼 ビデオ通話 -->
      <ClientOnly>
        <div v-if="showVideoCall" :class="['w-full mb-4', landscape ? '' : 'max-w-md']">
          <TenkoVideoCall
            :local-stream="combinedStream"
            :remote-stream="webRtc.remoteStream.value"
            :is-peer-connected="webRtc.isPeerConnected.value"
            :is-connected="webRtc.isConnected.value"
          />
          <!-- 切断時ボタン -->
          <div v-if="isDisconnected" class="flex gap-2 mt-2">
            <button
              class="flex-1 py-1.5 text-sm rounded-lg bg-blue-500 hover:bg-blue-400 text-white font-medium"
              @click="reconnect"
            >
              再接続
            </button>
            <button
              class="flex-1 py-1.5 text-sm rounded-lg bg-gray-200 hover:bg-gray-300 text-gray-700 font-medium"
              @click="handleReset"
            >
              終了
            </button>
          </div>
        </div>
      </ClientOnly>

      <!-- 遠隔点呼バナー -->
      <ClientOnly>
        <div
          v-if="isRemote"
          :class="['w-full bg-blue-50 border border-blue-200 rounded-xl px-4 py-2 mb-2 text-center text-sm text-blue-700 font-medium', landscape ? '' : 'max-w-md']"
        >
          {{ escalatedToRemote
            ? `遠隔点呼に切り替えました (${escalationReason}) — 運行管理者がビデオ通話で確認しています`
            : '遠隔点呼モード — 運行管理者がビデオ通話で確認しています' }}
        </div>
      </ClientOnly>

      <!-- デモモードバナー -->
      <ClientOnly>
        <div
          v-if="isDemoMode"
          :class="['w-full bg-purple-50 border border-purple-200 rounded-xl px-4 py-2 mb-2 text-center text-sm text-purple-700 font-medium', landscape ? '' : 'max-w-md']"
        >
          デモモード — 実機不要で点呼フローを体験できます
        </div>
      </ClientOnly>

      <!-- デモ用点呼予定作成 (NFCステップのみ表示) -->
      <ClientOnly>
        <DemoScheduleCreator v-if="isDemoMode && !isRemote && step === 'nfc'" :class="['w-full mb-4', landscape ? '' : 'max-w-md']" />
      </ClientOnly>

      <!-- 顔データ同期中 -->
      <div
        v-if="isFaceSyncing"
        :class="['w-full bg-green-50 border border-green-200 rounded-xl px-4 py-2 mb-2 text-center text-sm text-green-700', landscape ? '' : 'max-w-md']"
      >
        顔データ同期中...
      </div>

      <header :class="['w-full text-center', landscape ? 'py-2' : 'max-w-md py-6']">
        <h1 :class="['font-bold text-gray-800', landscape ? 'text-lg' : 'text-2xl']">{{ isRemote ? '遠隔点呼' : '自動点呼' }}</h1>
        <!-- 点呼種別 (遠隔点呼かつ乗務員未特定のみトグル。予定に依存せず画面で選ぶ。Refs #310) -->
        <div v-if="remoteMode && step === 'nfc'" class="flex gap-3 mt-3 w-full max-w-md mx-auto">
          <button
            class="flex-1 py-4 rounded-xl text-xl font-bold border-2 transition-colors"
            :class="tenkoType === 'pre_operation'
              ? 'bg-blue-600 text-white border-blue-600'
              : 'bg-white text-blue-600 border-blue-300 hover:bg-blue-50'"
            @click="selectedTenkoType = 'pre_operation'"
          >
            {{ tenkoTypeLabel('pre_operation') }}
          </button>
          <button
            class="flex-1 py-4 rounded-xl text-xl font-bold border-2 transition-colors"
            :class="tenkoType === 'post_operation'
              ? 'bg-orange-500 text-white border-orange-500'
              : 'bg-white text-orange-500 border-orange-300 hover:bg-orange-50'"
            @click="selectedTenkoType = 'post_operation'"
          >
            {{ tenkoTypeLabel('post_operation') }}
          </button>
        </div>
        <p v-else-if="tenkoType" class="mt-1 text-sm">
          <span
            class="px-2 py-0.5 rounded text-xs font-bold"
            :class="isPreOperation ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'"
          >
            {{ isPreOperation ? '業務前' : '業務後' }}
          </span>
        </p>
        <p v-if="employeeName && step !== 'nfc'" class="mt-1 text-sm font-medium text-gray-600">{{ employeeName }}</p>

        <!-- ステップインジケーター -->
        <div v-if="step !== 'nfc'" :class="['flex items-center mt-3 flex-wrap gap-y-1', landscape ? 'justify-center gap-x-0.5' : 'justify-center']">
          <template v-for="(s, i) in stepLabels" :key="i">
            <div
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap"
              :class="{
                'bg-blue-600 text-white': i === currentStepIndex,
                'bg-green-500 text-white': i < currentStepIndex,
                'bg-gray-200 text-gray-400': i > currentStepIndex,
              }"
            >
              <svg v-if="i < currentStepIndex" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              {{ s }}
            </div>
            <svg
              v-if="i < stepLabels.length - 1"
              class="w-4 h-4 mx-1 shrink-0"
              :class="i < currentStepIndex ? 'text-green-400' : 'text-gray-300'"
              fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </template>
        </div>
      </header>

      <!-- リセットリンク (横画面時は左列に配置) -->
      <div v-if="landscape && step !== 'nfc'" class="mt-auto pt-2">
        <div class="flex justify-center">
          <button class="text-gray-500 hover:text-gray-700 text-sm" @click="handleReset">
            最初からやり直す
          </button>
        </div>
      </div>
    </div>

    <!-- 右列 (横画面) / メインコンテンツ (縦画面) -->
    <main :class="['w-full flex-1', landscape ? 'min-h-0 overflow-y-auto' : 'max-w-md']">
      <!-- グローバルエラー -->
      <div v-if="error" class="bg-red-50 border border-red-200 rounded-xl p-3 mb-4 text-sm text-red-700">
        {{ error }}
      </div>

      <!-- ローディング -->
      <div v-if="isLoading" class="flex justify-center py-8">
        <span class="w-6 h-6 rounded-full border-2 border-blue-600 border-t-transparent animate-spin" />
      </div>

      <!-- Step 1: NFC / 手動入力 -->
      <div v-else-if="step === 'nfc'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">乗務員ID</h2>

          <div v-if="!useManualInput && !isDemoMode">
            <NfcStatus @read="onNfcRead" />
            <button
              class="w-full mt-4 text-sm text-gray-500 hover:text-gray-700 underline"
              @click="useManualInput = true"
            >
              手動でIDを入力する
            </button>
          </div>

          <div v-else>
            <p class="text-sm text-gray-500 mb-4">
              {{ isDemoMode ? 'デモ: 社員番号を入力してください' : '社員番号を入力してください' }}
            </p>
            <input
              v-model="manualIdInput"
              type="text"
              placeholder="社員番号 (例: 001)"
              class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
              @keyup.enter="onManualSubmit"
            >
            <p v-if="manualError" class="mt-2 text-sm text-red-600">{{ manualError }}</p>
            <button
              :disabled="!manualIdInput.trim()"
              class="w-full mt-4 px-6 py-3 bg-blue-600 text-white rounded-xl font-medium disabled:opacity-50 hover:bg-blue-700 transition-colors"
              @click="onManualSubmit"
            >
              次へ
            </button>
            <button
              v-if="!isDemoMode"
              class="w-full mt-2 text-sm text-gray-500 hover:text-gray-700 underline"
              @click="useManualInput = false"
            >
              NFC で読み取る
            </button>
          </div>

          <!-- 指静脈 (Refs ippoan/vein-match#20)。WebSerial が無い端末 (Android 等) には出さない -->
          <div v-if="!isDemoMode && veinSerial.isSupported" class="mt-4 pt-4 border-t border-gray-100">
            <button
              data-testid="vein-identify"
              :disabled="!!veinDisabledReason || veinBusy"
              class="w-full px-6 py-3 bg-emerald-600 text-white rounded-xl font-medium disabled:opacity-50 hover:bg-emerald-700 transition-colors"
              @click="onVeinIdentify"
            >
              {{ veinBusy ? '指を置いてください…' : '指静脈で本人確認' }}
            </button>
            <p v-if="veinDisabledReason" class="mt-2 text-xs text-gray-500">{{ veinDisabledReason }}</p>
            <p v-if="veinError" data-testid="vein-error" class="mt-2 text-sm text-red-600">{{ veinError }}</p>
          </div>
        </div>
      </div>

      <!-- Step 2: スケジュール選択 -->
      <div v-else-if="step === 'schedule_select'" class="flex flex-col gap-4">
        <!--
          再開を選んだが血圧の要否が確定できず入口で止めた場合 (Refs #336 / #343)。
          再開の経路が #339 の入口ガードを迂回しないよう、顔認証の段と同じ文言・同じ
          「もう一度試す」を出す (理由は上のグローバルエラーに出ている)。
        -->
        <div v-if="bpRequirementUnknown" class="bg-white rounded-2xl p-4 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">血圧計: 未確認</h2>
          <button
            data-testid="retry-bp-from-schedule-select"
            class="w-full px-4 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
            @click="retryBpRequirement"
          >
            もう一度試す
          </button>
        </div>
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">点呼予定選択</h2>
          <TenkoScheduleSelect
            :schedules="pendingSchedules"
            :employee-name="employeeName"
            :resumable-sessions="resumableSessions"
            @select="selectSchedule"
            @resume="resumeSession"
            @no-schedule="proceedWithoutSchedule"
          />
        </div>
      </div>

      <!-- Step 3: 顔認証 -->
      <div v-else-if="step === 'face_auth'" class="flex flex-col gap-4">
        <!--
          血圧の要否が確定できない端末は、体温・血圧まで歩かせずここで止める (Refs #336)。
          理由は上のグローバルエラーに出る (BP_REQUIREMENT_UNKNOWN_MESSAGE)。
          「不明」は一時的なこともあるので、リロードなしでやり直せる導線を必ず残す。
        -->
        <div v-if="bpRequirementUnknown" class="bg-white rounded-2xl p-4 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">血圧計: 未確認</h2>
          <button
            class="w-full px-4 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
            @click="retryBpRequirement"
          >
            もう一度試す
          </button>
        </div>
        <div v-else class="bg-white rounded-2xl p-4 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">顔認証</h2>
          <!-- 顔が未登録: 顔写真なしで進める (審査中・却下はここまで来ない) -->
          <template v-if="faceSkippable">
            <p class="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4">
              {{ faceSkipNotice }}
            </p>
            <button
              class="w-full px-4 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
              @click="skipFaceAuth"
            >
              顔認証をスキップして進む
            </button>
          </template>
          <FaceAuth
            v-else
            :employee-id="employeeId"
            mode="verify"
            :demo-mode="isDemoMode"
            @result="onFaceAuthResult"
          />
          <button
            v-if="canUseFingerprint"
            class="w-full mt-4 px-4 py-3 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition-colors flex items-center justify-center gap-2"
            @click="requestFingerprint"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 11c0-1.1.9-2 2-2s2 .9 2 2v3c0 1.66-1.34 3-3 3"/><path d="M8 15V11c0-2.21 1.79-4 4-4s4 1.79 4 4"/><path d="M2 11c0-5.52 4.48-10 10-10s10 4.48 10 10v3c0 3.31-2.69 6-6 6"/><path d="M12 11v4c0 .55-.45 1-1 1"/><path d="M6 11c0-3.31 2.69-6 6-6s6 2.69 6 6v2"/></svg>
            指紋認証で本人確認
          </button>
        </div>
      </div>

      <!-- Step 4: アルコール測定 -->
      <div v-else-if="step === 'alcohol'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">アルコール測定</h2>

          <!-- 録画カメラプレビュー (v-show: useCamera.start の時点で video が在る必要がある。v-if だと srcObject が入らず映像が出ない) -->
          <div v-show="isBlowCameraActive" class="relative mb-4 flex justify-center">
            <video
              ref="blowVideoRef"
              autoplay
              playsinline
              muted
              class="w-full aspect-video rounded-lg object-cover border border-gray-200"
            />
            <div
              v-if="isBlowRecording"
              class="absolute top-1 left-1 flex items-center gap-1 bg-red-600 text-white text-xs px-1.5 py-0.5 rounded"
            >
              <span class="w-2 h-2 rounded-full bg-white animate-pulse" />
              録画中
            </div>
          </div>

          <AlcMeasurement
            :employee-id="employeeId"
            :demo-mode="isDemoMode"
            @result="onMeasurementResult"
            @state-change="onAlcStateChange"
          />
        </div>
      </div>

      <!-- Step 5: 体温・血圧 (業務前のみ) -->
      <div v-else-if="step === 'medical'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-2">{{ showBpUi ? '体温・血圧' : '体温' }}</h2>

          <!-- タブ切替 (デモ時は BLE タブ非表示) -->
          <div v-if="!isDemoMode" class="flex gap-1 bg-gray-100 rounded-lg p-1 mb-4">
            <button
              class="flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
              :class="medicalInputTab === 'ble' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
              @click="medicalInputTab = 'ble'"
            >
              CoreS3
            </button>
            <button
              class="flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
              :class="medicalInputTab === 'manual' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
              @click="medicalInputTab = 'manual'"
            >
              手動入力
            </button>
          </div>

          <BleStatus
            v-if="medicalInputTab === 'ble'"
            :allow-skip="false"
            @next="onMedicalNext"
          />
          <ManualMedicalInput
            v-else
            :allow-skip="false"
            @submit="onManualMedicalSubmit"
          />

          <!--
            血圧が測れないときの逃げ道 (Refs ippoan/alc-app-s3#135)。
            血圧は必須なのでスキップも手入力もさせず、運行管理者が遠隔で対応する経路へ移す。
            自動点呼で血圧を使う端末のときだけ出す (最初から遠隔なら出ない)。
            理由は自由入力にせず選択肢から選ばせる — サーバが `reason` を必須で受ける。
          -->
          <template v-if="showBpUi && !isRemote">
            <button
              v-if="!isChoosingEscalationReason"
              class="w-full mt-4 px-4 py-3 bg-amber-600 text-white rounded-xl font-medium hover:bg-amber-700 transition-colors"
              @click="isChoosingEscalationReason = true"
            >
              遠隔点呼に切り替える
            </button>
            <div v-else class="mt-4 border border-amber-200 bg-amber-50 rounded-xl p-3">
              <p class="text-sm font-medium text-amber-800 mb-2">切り替える理由を選んでください</p>
              <button
                v-for="reason in TENKO_REMOTE_ESCALATION_REASONS"
                :key="reason"
                class="w-full mb-2 px-4 py-3 bg-amber-600 text-white rounded-xl font-medium hover:bg-amber-700 transition-colors"
                @click="chooseEscalationReason(reason)"
              >
                {{ reason }}
              </button>
              <button
                class="w-full text-sm text-gray-500 hover:text-gray-700 underline"
                @click="isChoosingEscalationReason = false"
              >
                やめる
              </button>
            </div>
          </template>
        </div>
      </div>

      <!-- Step 6: 自己申告 (業務前のみ) -->
      <div v-else-if="step === 'self_declaration'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">自己申告</h2>
          <TenkoSelfDeclaration @submit="onSelfDeclarationSubmit" />
        </div>
      </div>

      <!-- Step 7: 日常点検 (業務前のみ) -->
      <div v-else-if="step === 'daily_inspection'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">日常点検</h2>
          <TenkoDailyInspection @submit="onDailyInspectionSubmit" />
        </div>
      </div>

      <!-- Step 7.5: 携行品チェック -->
      <div v-else-if="step === 'carrying_items'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <TenkoCarryingItemsCheck
            v-if="carryingItems.length > 0"
            :items="carryingItems"
            @submit="onCarryingItemsSubmit"
          />
          <div v-else class="text-center py-4 text-gray-400">携行品マスタ未登録</div>
        </div>
      </div>

      <!-- Step 8: 指示確認 -->
      <div v-else-if="step === 'instruction'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">指示事項</h2>
          <TenkoInstruction
            :instruction="selectedSchedule?.instruction ?? null"
            :manager-name="selectedSchedule?.responsible_manager_name ?? ''"
            @confirm="onInstructionConfirm"
          />
        </div>
      </div>

      <!-- Step 9: 運行報告 (業務後のみ) -->
      <div v-else-if="step === 'report'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">運行報告</h2>
          <TenkoOperationReport @submit="onReportSubmit" />
        </div>
      </div>

      <!-- 完了 -->
      <div v-else-if="step === 'completed' && session" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <TenkoCompleted
            :session="session"
            :employee-name="employeeName"
            @reset="handleReset"
          />
          <!-- 医療データ入力元バッジ (業務前のみ) -->
          <div
            v-if="medicalInputSource && isPreOperation && (session.temperature || (showBpUi && session.systolic))"
            class="mt-3 text-center text-xs"
          >
            <span
              class="inline-flex items-center gap-1 px-2 py-1 rounded-full"
              :class="medicalInputSource === 'manual' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'"
            >
              {{ showBpUi ? '体温・血圧' : '体温' }}: {{ medicalInputSource === 'manual' ? '手動入力' : 'CoreS3' }}
            </span>
          </div>
          <!-- 吹きかけ録画のアップロード状態 (Refs ippoan/alc-app#349) -->
          <div v-if="blowVideoUploadStatus" class="mt-2 text-center text-xs">
            <span
              class="inline-flex items-center gap-1 px-2 py-1 rounded-full"
              :class="{
                'bg-blue-100 text-blue-700': blowVideoUploadStatus === 'uploading',
                'bg-green-100 text-green-700': blowVideoUploadStatus === 'uploaded',
                'bg-amber-100 text-amber-700': blowVideoUploadStatus === 'pending',
                'bg-red-100 text-red-700': blowVideoUploadStatus === 'failed',
              }"
            >
              <template v-if="blowVideoUploadStatus === 'uploading'">
                <span class="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                録画アップロード中...
              </template>
              <template v-else-if="blowVideoUploadStatus === 'uploaded'">
                録画アップロード完了
              </template>
              <template v-else-if="blowVideoUploadStatus === 'pending'">
                録画はローカルに保存済み (後でアップロード)
              </template>
              <template v-else-if="blowVideoUploadStatus === 'failed'">
                録画アップロード失敗 (次回起動時にリトライ)
              </template>
            </span>
          </div>
        </div>
      </div>

      <!-- 中断 (安全判定失敗 etc.) -->
      <div v-else-if="step === 'interrupted'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <TenkoInterrupted
            :employee-name="employeeName"
            :safety-judgment="safetyJudgment"
            @reset="handleReset"
          />
        </div>
      </div>

      <!-- キャンセル (アルコール検知 / 日常点検NG) -->
      <div v-else-if="step === 'cancelled'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <TenkoInterrupted
            :employee-name="employeeName"
            :reason="session?.cancel_reason ?? '点呼がキャンセルされました'"
            @reset="handleReset"
          />
        </div>
      </div>
    </main>

    <!-- ナビゲーション (縦画面時のみ。横画面時は左列に配置) -->
    <footer v-if="!landscape" class="w-full max-w-md py-4">
      <div class="flex justify-center gap-4">
        <button
          v-if="step !== 'nfc'"
          class="text-gray-500 hover:text-gray-700 text-sm"
          @click="handleReset"
        >
          最初からやり直す
        </button>
      </div>
    </footer>
  </div>
</template>
