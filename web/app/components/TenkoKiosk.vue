<script setup lang="ts">
import type { FaceAuthResult, MeasurementResult, SubmitMedicalData, TenkoRemoteEscalationReason } from '~/types'
import type { TenkoStep } from '~/composables/useTenkoKiosk'
import { TENKO_REMOTE_ESCALATION_REASONS } from '~/types'
import { cancelTenkoSession, getEmployeeByNfcId, getEmployeeByCode, getTenkoSession, startMeasurement } from '~/utils/api'
import { employeeNotFoundByNfc, employeeNotFoundByCode, employeeLookupFailureMessage } from '~/utils/employee-lookup-messages'
import { tenkoTypeLabel } from '~/utils/tenko-type'
import { VEIN_NO_MATCH_MESSAGE, VEIN_TEMPLATE_SYNC_INTERVAL_MS } from '~/utils/vein-identify'
import { reportApiFailure, reportFailure } from '~/utils/equipment-failure-report'

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
// 遠隔点呼の部屋に入るときは端末の鍵を付ける。signaling が鍵の sub (alarm:<fingerprint>) を
// 管理者画面へ渡し、管理者画面がこの端末の拠点カメラを引く。鍵が取れなければ付けない (従来どおり)
const { getDeviceJwt } = useDeviceToken()
async function roomToken(): Promise<string | undefined> {
  try {
    return (await getDeviceJwt()) ?? undefined
  }
  catch {
    return undefined
  }
}
const camera = useCamera()
let audioStream: MediaStream | null = null  // マイク音声 (WebRTC用)
const combinedStream = ref<MediaStream | null>(null)  // 映像+音声 (TenkoVideoCall用)

// 点呼キオスク状態管理
const {
  step, employeeId, employeeName, pendingSchedules, resumableSessions, selectedSchedule, selectedTenkoType, session,
  error, isLoading, safetyJudgment, tenkoType, isPreOperation,
  escalatedToRemote, escalationReason, isRemote, escalateToRemote,
  stepLabels, currentStepIndex,
  stationBp, stationBpLoading, loadStationBp,
  vehicleInput, vehicleManualRequired, onVehicleSubmit,
  identifyEmployee, selectSchedule, resumeSession, proceedWithoutSchedule, onFaceAuthComplete,
  onAlcoholMeasured, onMedicalSubmit, onSelfDeclarationSubmit,
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

/**
 * サーバが点呼の開始で作った測定 (体温・血圧・アルコールの値の置き場。セッションの `measurement_id`) を、最初の
 * アルコール測定に使ったか。測り直しは新しい測定で行う。開始で測定を作らない古いサーバでは使わない
 */
const sessionMeasurementUsed = ref(false)

/** 測定レコードを先に作る (best-effort: 失敗しても点呼は続ける) */
async function startAlcoholMeasurement() {
  if (!employeeId.value || alcoholMeasurementId.value) return
  const fromSession = session.value?.measurement_id
  if (fromSession && !sessionMeasurementUsed.value) {
    sessionMeasurementUsed.value = true
    alcoholMeasurementId.value = fromSession
    return
  }
  try {
    const m = await startMeasurement(employeeId.value)
    alcoholMeasurementId.value = m.id
    // CoreS3 がこの後のアルコールの記録にこの id を載せる
    sendMeasurementId(m.id)
  }
  catch (e) {
    console.warn('[TenkoKiosk] startMeasurement failed:', e)
    alcoholMeasurementId.value = null
    // 測定の記録を作れなかった (通信・サーバーの失敗) — 故障として残す。4xx は残さない
    reportApiFailure(e, 'アルコール測定の記録の作成', {
      sessionId: session.value?.id, type: 'measurement_recording_failed',
    })
  }
}

/**
 * 測定レコードを completed にする本文。**`record_as_tenko` は載せない** (通常点呼の新しいセッションは作らない)。
 * 点呼の段は `onAlcoholMeasured` が同じ保存に `tenko_session_id` を足して進める (Refs ippoan/rust-alc-api#680)
 */
function completedMeasurementFields(result: MeasurementResult): Record<string, unknown> {
  return {
    status: 'completed',
    alcohol_value: result.alcoholValue,
    result_type: result.resultType,
    device_use_count: result.deviceUseCount,
    face_photo_url: result.facePhotoUrl,
    measured_at: result.measuredAt.toISOString(),
    tenko_type: tenkoType.value ?? undefined,
  }
}

// アルコールの段に入ったら録画カメラを起こし、測定レコードを作る。
// **カメラを先に** — プレビューはローカルなので即出せる。逆順にすると
// `startMeasurement` が詰まっている間プレビューが出ない
watch(step, async (s) => {
  if (s !== 'alcohol') return
  // デモモードは FC-1200 の state 変化が来ないので即録画
  await openBlowCamera()
  await startAlcoholMeasurement()
})

/**
 * 録画カメラを起こす。起こせなかったときは (測定は続けるが) 機器の故障として残す —
 * 吹きかけ録画・顔写真が残らない点呼になるため
 */
async function openBlowCamera() {
  const ok = await startBlowCamera({ recordImmediately: isDemoMode.value })
  if (!ok) {
    reportFailure({
      type: 'photo_storage_error',
      description: 'カメラを起動できず、吹きかけ録画を撮れませんでした',
      device: 'カメラ',
      sessionId: session.value?.id,
    })
  }
}

// 録画のアップロードに失敗したら故障として残す (録画はローカルに残り、次回起動時にリトライされる)
watch(blowVideoUploadStatus, (status) => {
  if (status !== 'failed') return
  reportFailure({
    type: 'photo_storage_error',
    description: '吹きかけ録画のアップロードに失敗しました',
    device: 'カメラ録画',
    sessionId: session.value?.id,
  })
})

/** アルコール測定器 (FC-1200) の接続・読み取りの失敗 (`AlcMeasurement` の `error`) を故障として残す */
function onAlcDeviceError() {
  reportFailure({
    type: 'measurement_recording_failed',
    description: 'アルコール測定器 (FC-1200) の接続・読み取りに失敗しました',
    device: 'FC-1200',
    sessionId: session.value?.id,
  })
}

// PC の今の段を CoreS3 に送り、画面を連動させる (Refs ippoan/alc-app-s3#135)
const { syncStep, sendResult, sendMeasurementId } = useCoreS3Stage()
watch(step, syncStep, { immediate: true })

// セッションの測定を開始の時点で CoreS3 に渡す — 体温・血圧の記録にも載る (段に入ってから作る測定では間に合わない)
watch(() => session.value?.measurement_id, (id) => {
  if (id) sendMeasurementId(id)
})

// 本番 flip 後の新版への載せ替えを「最初の画面に居るとき」だけ許すための現在地 (Refs #338)。
// `useTenkoKiosk` の state は component ごとの素の ref で外からは読めないので、ここで出す。
// 読み込み中は、照会中の要求が消えるため busy 扱いにする。
// ファームの更新中 (待機画面 = `nfc` のまま始まる) も busy — 書き込みの途中でページを落とさない
// (Refs ippoan/alc-app#403)。`track` の getter は登録した時点で評価されるので、`serialOta` は
// これより前で定義する (受けの配線は下の「端末のシリアル OTA」の節)
const serialOta = useSerialOta()
useKioskScreen().track(() => ({
  step: step.value,
  busy: isLoading.value || serialOta.state.value.kind !== 'idle',
}))

/**
 * 運行管理者の判定を待っている (遠隔点呼の乗務員の側は終わり、判定で閉じる)。完了の画面のまま
 */
const awaitingJudgment = computed(() => step.value === 'completed' && session.value?.status === 'judgment_pending')
/**
 * 遠隔点呼で通話の部屋に入るとき (Refs ippoan/alc-app-s3#135)。部屋に入ると運行管理者の画面の「接続待ちデバイス」に
 * 出て、運行管理者席の警告デバイスが着信を鳴らすので、**運行管理者を呼ぶときに入る** (2026-11-01 ユーザー決定)。
 *
 * - 判定待ち: 乗務員が指示確認 (業務後は運行報告) を終えたら入って運行管理者を呼ぶ。運行管理者は通話の中で OK / NG を
 *   押して点呼を閉じる
 * - 途中で遠隔に切り替えた点呼の血圧の段 (`medical`): 血圧が測れず運行管理者を呼ぶのはこの段。signaling の
 *   部屋は**接続したときに登録される**ため、ここで繋がないと切り替えても運行管理者の一覧に出てこない
 */
const isRemoteCallStep = computed(
  () => awaitingJudgment.value || (escalatedToRemote.value && step.value === 'medical'),
)
/** 映像を繋ぐべき状態か。段だけでなく「いま遠隔か」も見るので、段の途中で切り替えても発火する */
const shouldConnectRemote = computed(
  () => isRemote.value && isRemoteCallStep.value,
)

/** 通話パネルの表示。部屋に入っている間だけ (閉じた点呼では部屋から出るので出さない) */
const showVideoCall = computed(
  () => isRemote.value && isRemoteCallStep.value,
)

// 点呼が閉じたら (完了・中止) 通話の部屋から出る。残ると運行管理者の画面の「接続待ちデバイス」に
// 終わった点呼が出続ける (2026-11-01 実機)。**判定待ちの間は出ない**。最初の画面に戻るときの
// handleReset も同じく止める
watch([step, () => session.value?.status], ([s, status]) => {
  if (!isRemote.value) return
  if (s === 'cancelled' || (s === 'completed' && status !== 'judgment_pending')) stopRemoteStreams()
})

/** 遠隔点呼の完了の画面から次の点呼へ自動で移るまでの秒数 */
const REMOTE_COMPLETED_RESET_S = 30
/** 次の点呼へ移るまでの残り秒数。数えていなければ null */
const autoResetLeft = ref<number | null>(null)
let autoResetTimer: ReturnType<typeof setInterval> | null = null
function stopAutoReset(): void {
  if (autoResetTimer !== null) clearInterval(autoResetTimer)
  autoResetTimer = null
  autoResetLeft.value = null
}
/**
 * 遠隔点呼が閉じた (運行管理者の判定が済んだ) 完了の画面。30 秒で次の点呼へ移る (2026-11-02 ユーザー指示)。
 * 判定は下の「判定待ちの間はセッションを取り直し」で入る。押せば待たずに移る
 */
const remoteClosed = computed(() => isRemote.value && step.value === 'completed' && session.value?.status === 'completed')
watch(remoteClosed, (closed) => {
  stopAutoReset()
  if (!closed) return
  autoResetLeft.value = REMOTE_COMPLETED_RESET_S
  autoResetTimer = setInterval(() => {
    autoResetLeft.value = (autoResetLeft.value ?? 1) - 1
    if (autoResetLeft.value <= 0) handleReset()
  }, 1000)
}, { immediate: true })

/**
 * 運行管理者を呼んでいる間 (判定待ち) に運行管理者が通話に出ないとき、乗務員がこの点呼をやめる
 * (取り消しの理由を残して最初の画面へ)。運行管理者が通話に入っている間は出さない
 */
const canCancelForNoManager = computed(() => isRemote.value && awaitingJudgment.value && !webRtc.isPeerConnected.value)
const NO_MANAGER_CANCEL_REASON = '運行管理者が通話に出なかったため乗務員が中止'
const cancellingNoManager = ref(false)
async function cancelForNoManager(): Promise<void> {
  const id = session.value?.id
  if (!id || cancellingNoManager.value) return
  cancellingNoManager.value = true
  try {
    await cancelTenkoSession(id, { reason: NO_MANAGER_CANCEL_REASON })
    handleReset()
  }
  catch {
    error.value = '点呼をやめられませんでした。もう一度押してください'
  }
  finally {
    cancellingNoManager.value = false
  }
}

// 判定待ちの間はセッションを取り直し、判定が入ったら完了の表示に変える (取り直さないと「判定を待っています」の
// まま変わらない)。取れなかった回は次の回に回す
const JUDGMENT_POLL_MS = 5000
let judgmentTimer: ReturnType<typeof setInterval> | null = null
function stopJudgmentPoll(): void {
  if (judgmentTimer) clearInterval(judgmentTimer)
  judgmentTimer = null
}
watch(awaitingJudgment, (waiting) => {
  stopJudgmentPoll()
  if (!waiting) return
  judgmentTimer = setInterval(async () => {
    const id = session.value?.id
    if (!id) return
    try {
      const latest = await getTenkoSession(id)
      if (session.value?.id === id) session.value = latest
    }
    catch {
      // 次の回に取り直す
    }
  }, JUDGMENT_POLL_MS)
}, { immediate: true })
onUnmounted(stopJudgmentPoll)

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
    await webRtc.connect(config.public.signalingUrl, session.value.id, 'room', await roomToken())
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
    await webRtc.connect(config.public.signalingUrl, session.value.id, 'room', await roomToken())
    if (camera.stream.value) await webRtc.startStreaming(camera.stream.value)
  } catch {
    // 失敗しても点呼フローはブロックしない
  }
}

// BLE Medical Gateway (体温・血圧)
const {
  latestTemperature: bleTemperature,
  latestBloodPressure: bleBloodPressure,
  error: bleError,
} = useBleGateway()

// 体温計・血圧計 (BLE ゲートウェイ) の接続・読み取りの失敗は、体温・血圧の段にいるあいだだけ故障として残す
// (他の段・他の画面で出たものは、この点呼の記録ではない)
watch(bleError, (message) => {
  if (!message || step.value !== 'medical') return
  reportFailure({
    type: 'measurement_recording_failed',
    description: '体温計・血圧計の接続・読み取りに失敗しました',
    device: '体温計・血圧計',
    sessionId: session.value?.id,
  })
})

/**
 * この端末で血圧を使うか (Refs ippoan/alc-app-s3#135 / ippoan/alc-app#347)。
 * `BleStatus` / `ManualMedicalInput` と同じ `useBpUiEnabled()` を見る — 以前の
 * `bpEnabled` 単独では、CoreS3 キオスクで血圧が必須なのに「遠隔点呼に切り替える」の
 * 逃げ道が出なかった。
 */
const { showBpUi } = useBpUiEnabled()

/**
 * 体温・血圧の段で血圧の行を出すか。**この端末の血圧計の有無 (`showBpUi`) に依らず、自動点呼なら
 * 出す** — 業務前の血圧は血圧測定台で測った直近の値を引き当てる (`stationBp`)。
 * 遠隔点呼は運行管理者が見るので出さない。
 */
const showMedicalBp = computed(() => showBpUi.value || !isRemote.value)

/** この端末で測った血圧 (BLE) があるか。あれば測定台の血圧より優先して使う */
const hasKioskBp = computed(() => Boolean(bleBloodPressure.value))

/** 測定台の血圧の測定時刻 (「07:31」の形) */
const stationBpTime = computed(() =>
  stationBp.value
    ? new Date(stationBp.value.measuredAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
    : '',
)

// 医療ステップ: BLE / 手動入力 タブ
const medicalInputTab = ref<'ble' | 'manual'>('ble')
watch(isDemoMode, (v) => {
  if (v) medicalInputTab.value = 'manual'
}, { immediate: true })

// --- NFC / 手動入力 ---
const manualIdInput = ref('')
const useManualInput = ref(false)
const manualError = ref<string | null>(null)

async function onNfcRead(nfcId: string) {
  try {
    const emp = await getEmployeeByNfcId(nfcId)
    await identifyEmployee(emp.id, emp.name)
  } catch (e) {
    reportApiFailure(e, '乗務員の照会')
    error.value = employeeLookupFailureMessage(e, employeeNotFoundByNfc(nfcId))
  }
}

async function onManualSubmit() {
  const input = manualIdInput.value.trim()
  if (!input) return
  manualError.value = null
  try {
    const emp = await getEmployeeByCode(input)
    await identifyEmployee(emp.id, emp.name)
  } catch (e) {
    reportApiFailure(e, '乗務員の照会')
    manualError.value = employeeLookupFailureMessage(e, employeeNotFoundByCode(input))
  }
}

// --- 指静脈 (Refs ippoan/vein-match#20) ---
// 乗務員の特定は最初の段の NFC (免許証)・社員番号で行い、**その後の顔認証を指静脈に置き換える**
// (遠隔点呼・自動点呼とも)。Vein Station がつながっていれば顔認証の段で指を置かせ、当たった人が
// 最初の段で特定した人と同じなら本人確認とする。**遠隔点呼・自動点呼は Vein Station でしか行わない**
// (2026-11-01 決定) — つながっていない端末は顔認証に逃がさず、この段で止める (デモだけは顔認証の画面)。
const veinSerial = useVeinSerial()
// 照合の手順・接続・写しの同期・指の合図は 3 つの入口で共通 (useVeinEmployeeIdentify)
const vein = useVeinEmployeeIdentify({
  label: 'kiosk',
  missMessage: VEIN_NO_MATCH_MESSAGE,
  pendingMessage: name => `${name ?? 'この人'}さんの指静脈は未承認です。血圧測定の画面の「未承認の指静脈」から運行管理者が承認してください`,
  // 最初の段で特定した人と同じなら本人確認 (顔写真は撮らない)。別の人なら理由を出して置き直させる
  onEmployee: (emp) => {
    if (emp.id !== employeeId.value) {
      return `${employeeName.value || '最初に確認した人'}さんの指静脈と一致しません。本人の指を置いてください`
    }
    onFaceAuthResult({ verified: true, similarity: 0, skipped: true })
    return null
  },
  // 指が置かれた合図で照合を始めるのは、顔認証の段で指静脈を使っているときだけ
  isIdle: () => useVeinForIdentity.value && !vein.busy.value,
  // 本人は最初の段で決まっている: その人の記録だけをモジュールに用意して 1:1 で照合する (Refs ippoan/alc-app-s3#352)
  expectedEmployeeId: () => employeeId.value || null,
  noRecordMessage: 'この人の承認済みの指静脈の記録がありません。登録して運行管理者の承認を受けてください',
  // 指静脈リーダー (Vein Station) の読み取り・記録の用意の失敗だけを故障として残す。
  // 不一致・別人・未承認・指を置かなかった、は利用者側のことなので残さない
  onDeviceError: () => reportFailure({
    type: 'face_recognition_error',
    description: '指静脈リーダーの読み取りに失敗しました',
    device: '指静脈リーダー',
    sessionId: session.value?.id,
  }),
})

/** 指静脈の照合を始めてよいか (本人確認の段・Vein Station がつながっている) */
const useVeinForIdentity = computed(() =>
  step.value === 'face_auth' && !isDemoMode.value
  && veinSerial.isSupported && veinSerial.isConnected.value,
)
/** 本人確認の段で止めている理由 (Vein Station が無い)。`null` なら止めていない */
const veinMissingReason = computed<string | null>(() => {
  if (isDemoMode.value) return null
  if (!veinSerial.isSupported) return 'この端末では指静脈を読めません (Chrome の Web Serial が要ります)。遠隔点呼・自動点呼は Vein Station をつないだ PC で行ってください'
  if (!veinSerial.isConnected.value) return 'Vein Station (指静脈読み取り端末) が接続されていません。USB でつないでください'
  return null
})

// 本人確認の段に入ったら、その人の記録をすぐモジュールに書き始める (約 2 秒。指を置くまでの間と重ねる)
watch(useVeinForIdentity, (use) => {
  if (use && employeeId.value) vein.prewrite(employeeId.value)
}, { immediate: true })

// 点呼の開始時 (最初の画面に戻ったとき): 前回の同期から時間がたっていれば取り直す
watch(step, (s) => {
  if (s === 'nfc') void vein.sync({ ifOlderThanMs: VEIN_TEMPLATE_SYNC_INTERVAL_MS })
})

// --- 端末のシリアル OTA (Refs ippoan/alc-app-s3#279) ---
// 管理者が /device/setup で「最新にする」を押すと、recorder が購読 WS に合図を送る。
// 点呼の途中では走らせず、待機画面 (NFC 待ち・指静脈の読み取り中でない) のときだけ走らせる。
// 途中で受けた合図は預けておき、待機画面へ戻ったときに走らせる。
// 購読 WS は打刻一覧の画面 (TodayPunchHistory) と同じもの — 両者は driverSubTab の v-if で
// 同時に出ない。CoreS3 を繋いだキオスクでは FirmwareOtaHost の購読 (CoreS3 の合図用) が別に
// 1 本在るので、合わせて 2 本になる (`serialOta` は上の `track` の前で定義)
const isKioskIdle = computed(() => step.value === 'nfc' && !vein.busy.value)
const otaWatch = useTimecardWatch({
  getToken: () => useDeviceToken().getDeviceJwt(),
  onSerialOta: (target) => {
    // この画面が預かるのは Vein Station の合図だけ (CoreS3 の合図は FirmwareOtaHost の側。Refs ippoan/alc-app#403)
    if (target !== 'timecard-station') return
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
// 「更新中」の幕は FirmwareOtaHost.vue が描く (タブに関係なく常に在る。Refs ippoan/alc-app#403)。
// 更新を始めてよいかの材料として、この画面が機体を使っている間を申告する
useKioskScreen().declareDeviceBusy(() => !isKioskIdle.value)

// --- 顔認証結果 ---
function onFaceAuthResult(result: FaceAuthResult) {
  if (result.verified) onFaceAuthComplete(result)
}

// --- アルコール測定結果 ---
async function onMeasurementResult(result: MeasurementResult) {
  // 段に入ったときの測定の作成が失敗していたら、ここでもう一度作る (段は測定の保存でしか進まない)
  if (!alcoholMeasurementId.value) await startAlcoholMeasurement()
  const measurementId = alcoholMeasurementId.value
  // **段を進める前に**録画を止めて blob を確定させる (進めると段が unmount される)
  await finishBlowRecording(employeeId.value, measurementId ?? undefined)
  sendResult(result)
  if (!measurementId) return
  uploadBlowRecording(measurementId)
  // 測定の保存と同じ要求で段を進める。**待つ** — 段の結果 (検知・次の段) はこの応答で決まる
  const retry = await onAlcoholMeasured(measurementId, completedMeasurementFields(result))
  if (retry) {
    // 測り直しは新しい測定で (この測定は完了済みかもしれない)
    alcoholMeasurementId.value = null
    await openBlowCamera()
    await startAlcoholMeasurement()
  }
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
  vein.error.value = null
  medicalInputSource.value = null
  medicalInputTab.value = isDemoMode.value ? 'manual' : 'ble'
  isChoosingEscalationReason.value = false
  alcoholMeasurementId.value = null
  sessionMeasurementUsed.value = false
  resetBlowRecording()
}

onUnmounted(() => {
  stopAutoReset()
  if (isRemote.value) stopRemoteStreams()
})
</script>

<template>
  <div :class="[
    'w-full flex-1 overflow-y-auto p-4',
    landscape ? 'flex gap-4 max-w-4xl mx-auto' : 'flex flex-col items-center'
  ]">
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

        </div>
      </div>

      <!-- Step 2: スケジュール選択 -->
      <div v-else-if="step === 'schedule_select'" class="flex flex-col gap-4">
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

      <!-- Step 3: 本人確認 (指静脈) -->
      <div v-else-if="step === 'face_auth'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <!-- 本人確認は指静脈 (遠隔点呼・自動点呼は Vein Station でしか行わない)。デモだけ顔認証の画面 -->
          <FaceAuth
            v-if="isDemoMode"
            :employee-id="employeeId"
            mode="verify"
            :demo-mode="true"
            @result="onFaceAuthResult"
          />
          <template v-else>
            <h2 class="text-lg font-semibold text-gray-700 mb-4">指静脈で本人確認</h2>
            <p v-if="veinMissingReason" data-testid="vein-missing" class="text-sm text-red-600">{{ veinMissingReason }}</p>
            <template v-else>
              <p class="text-sm text-gray-600 mb-4">{{ employeeName }}さん、Vein Station に指を置いてください</p>
              <button
                data-testid="vein-identify"
                :disabled="vein.busy.value"
                class="w-full px-6 py-3 bg-emerald-600 text-white rounded-xl font-medium disabled:opacity-50 hover:bg-emerald-700 transition-colors"
                @click="vein.identify()"
              >
                {{ vein.busy.value ? (vein.again.value ? 'もう一度置いてください…' : '指を置いてください…') : '指静脈で本人確認' }}
              </button>
              <p v-if="vein.error.value" data-testid="vein-error" class="mt-2 text-sm text-red-600">{{ vein.error.value }}</p>
            </template>
          </template>
        </div>
      </div>

      <!-- Step 3.5: 車両番号 (車検証の読み取りを優先。業務前 二十 ハ) -->
      <div v-else-if="step === 'vehicle'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">車両番号</h2>
          <TenkoVehicleEntry
            v-model="vehicleInput"
            :manual-required="vehicleManualRequired"
            @submit="onVehicleSubmit"
          />
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
            @error="onAlcDeviceError"
            @state-change="onAlcStateChange"
          />
        </div>
      </div>

      <!-- Step 5: 体温・血圧 (業務前のみ) -->
      <div v-else-if="step === 'medical'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-4 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-2">{{ showMedicalBp ? '体温・血圧' : '体温' }}</h2>

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

          <!--
            血圧測定台で測った直近の血圧 (業務前の自動点呼)。この端末で血圧を測っていれば
            そちらを使うので出さない。見つからないときは測定台で測ってもらい、読み込み直す。
          -->
          <div v-if="!isRemote && !hasKioskBp" class="mb-4" data-testid="station-bp">
            <p
              v-if="stationBp"
              class="rounded-xl bg-blue-50 border border-blue-200 text-blue-700 text-sm font-medium text-center px-4 py-3"
              data-testid="station-bp-value"
            >
              測定台の血圧: {{ stationBp.systolic }}/{{ stationBp.diastolic }} mmHg ({{ stationBpTime }} 測定)
            </p>
            <p v-else-if="stationBpLoading" class="text-sm text-blue-600 text-center">
              測定台の血圧を確認しています...
            </p>
            <div v-else class="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-center">
              <p class="text-sm text-amber-800 mb-2" data-testid="station-bp-missing">
                測定台で血圧を測ってから、「血圧を読み込む」を押してください。
              </p>
              <button
                class="px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 transition-colors"
                data-testid="station-bp-load"
                @click="loadStationBp"
              >
                血圧を読み込む
              </button>
            </div>
          </div>

          <BleStatus
            v-if="medicalInputTab === 'ble'"
            :allow-skip="false"
            :hide-bp-status="!showBpUi && !isRemote"
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
            自動点呼のとき出す (最初から遠隔なら出ない)。
            理由は自由入力にせず選択肢から選ばせる — サーバが `reason` を必須で受ける。
          -->
          <template v-if="!isRemote">
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
            :auto-reset-seconds="autoResetLeft"
            @reset="handleReset"
          />
          <!-- 運行管理者を呼んでいる間 (遠隔点呼の判定待ち)。出ないときは乗務員がやめられる -->
          <div v-if="canCancelForNoManager" data-testid="calling-manager" class="mt-3 rounded-xl bg-amber-50 text-amber-800 text-sm px-4 py-2">
            <p>運行管理者を呼んでいます。通話がつながると、運行管理者が判定して点呼が終わります</p>
            <button
              data-testid="cancel-no-manager"
              :disabled="cancellingNoManager"
              class="mt-2 w-full px-4 py-2 rounded-lg border border-amber-300 bg-white text-amber-800 disabled:opacity-50"
              @click="cancelForNoManager"
            >
              運行管理者が出ないので点呼をやめる
            </button>
          </div>
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
