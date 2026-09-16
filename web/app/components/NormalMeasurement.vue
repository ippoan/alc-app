<script setup lang="ts">
import type { MeasurementResult, TenkoType, CarInspectionLookupResponse } from '~/types'
import { getEmployeeByNfcId, getEmployeeByCode, startMeasurement, updateMeasurement, uploadBlowVideo, lookupCarInspection, punchTimecard } from '~/utils/api'
import { saveVideo, markVideoUploaded, getPendingVideos, cleanupOldVideos } from '~/utils/video-store'
import { checkLicenseExpiry, checkLicenseExpiryFromString, formatExpiryDate, expiryTone, EXPIRY_TONE_CLASS, type LicenseExpiryStatus } from '~/utils/license'
import { employeeNotFoundByNfc, employeeNotFoundByCode, deviceUnregisteredMessage } from '~/utils/employee-lookup-messages'
import { SHOW_BLOOD_PRESSURE } from '~/utils/medical-inputs'
import { evtArg } from '~/composables/useCoreS3Serial'

const { isDemoMode: isDemoModeFromUrl } = useDemoMode()

const props = defineProps<{
  demoMode?: boolean
  landscape?: boolean
}>()

const isDemoMode = computed(() => props.demoMode || isDemoModeFromUrl.value)

const step = ref<'nfc' | 'choice' | 'vehicle' | 'medical' | 'measuring' | 'result'>('nfc')
const employeeId = ref('')
const measurementResult = ref<MeasurementResult | null>(null)

// 電子車検証の段 (免許証の次)。タップ / スキップ → normal、始業 → pre_operation、
// 終業 → post_operation (Refs ippoan/alc-app-s3#135)
const tenkoType = ref<TenkoType>('normal')
function chooseVehicleStep(type: TenkoType) {
  tenkoType.value = type
  step.value = 'medical'
}

/**
 * 免許証タッチの直後の段 (choice)。「アルコールチェック / 始業点呼 / 終業点呼」を選ぶ
 * (Refs ippoan/alc-app-s3#135)。
 *
 * **アルコールチェック = 種別なしの測定**。点呼種別の列は NULL を受けない
 * (`migrations/140_normal_tenko_sessions.sql` の CHECK / `015` の NOT NULL) ので、
 * スキップと同じ `'normal'` で記録する
 * (保存経路は増やさない — 既存の完了 PUT / offline-queue をそのまま通る)。
 *
 * **車検証の段へ進むのは始業点呼だけ。** 終業に車検証は要らない (ユーザー判断) ので、
 * 終業点呼はアルコールチェックと同じく車検証を飛ばして体温へ直行する。種別
 * (`'post_operation'`) はそのまま残るので、完了の PUT には終業として載る。
 */
function chooseType(type: TenkoType) {
  tenkoType.value = type
  step.value = type === 'pre_operation' ? 'vehicle' : 'medical'
}

// --- 免許証タッチのその場で打刻する (Refs ippoan/alc-app-s3#135) ---
// タイムカードタブと同じ打刻の口 (`~/utils/api.ts` → alc-app の server route →
// cf-alc-recorder) をそのまま通す。新しい API は作らない。
// **何も選ばずに離れても打刻は残る** = 打刻だけの人はタッチして終われる。

/**
 * 同じカードの連続タップで 2 回打刻しないための窓。
 *
 * 値は `useNfcReader.ts` の `DEDUPE_WINDOW_MS` (3000) に揃えてある — 免許証の通り道は
 * 既に「同じ ID を 3 秒以内に再受信したら捨てる」ので、ここだけ別の長さにすると
 * 同じ操作が経路 (PC ブリッジ / CoreS3 直結) によって違う結果になる。
 * `onNfcRead` は `await` を挟むため、1 回目の応答が返る前に 2 回目が段のガードを
 * 通り抜けて届きうる — その取りこぼしをこちら側の窓で止める。
 */
const PUNCH_REPEAT_WINDOW_MS = 3000

/** 打刻できた時刻 (choice の段の上に出す)。null = 打てていない */
const punchedAt = ref<Date | null>(null)
/** 打刻の失敗理由 (赤い帯で出す) */
const punchErrorMessage = ref<string | null>(null)
/** 打刻を見送った理由。オフライン (通信なし) と手入力 (card_id が無い) */
const punchSkipReason = ref<'offline' | 'manual' | null>(null)
/** 直前に打刻を試みたカードと時刻 (連続タップの除去に使う。表示しないので ref にしない) */
let lastPunchedCardId: string | null = null
let lastPunchedAt = 0

const punchedAtLabel = computed(() => punchedAt.value
  ? punchedAt.value.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
  : '')

function clearPunchState() {
  punchedAt.value = null
  punchErrorMessage.value = null
  punchSkipReason.value = null
}

/**
 * 打刻失敗の文言。**status を握りつぶさない** — 未ペアリング (資格情報が無い) と
 * 通信障害を同じ文言にすると、現地で「ペアリングすれば直る」と分からない
 * (TimePunchKiosk.vue と同じ切り分け)。
 */
function punchFailureMessage(e: unknown): string {
  const err = e as { punchFailure?: string, status?: number } | undefined
  if (err?.punchFailure === 'unpaired') return deviceUnregisteredMessage
  if (err?.punchFailure === 'forbidden') return 'この端末では打刻できません (ペアリングの種別を確認してください)'
  return err?.status ? `打刻に失敗しました (${err.status})` : '打刻に失敗しました'
}

/**
 * 打刻する (best-effort: 失敗しても投げない)。**点呼を打刻の失敗で止めない**。
 * オフラインでは打たない — 打刻のキューイングはこの段では持たない
 * (未送信の測定結果キューに打刻を混ぜると flush の経路が濁る)。
 */
async function tryPunch(cardId: string) {
  if (!isOnline.value) {
    punchSkipReason.value = 'offline'
    return
  }
  const now = Date.now()
  if (cardId === lastPunchedCardId && now - lastPunchedAt < PUNCH_REPEAT_WINDOW_MS) return
  // **往復を待つ前に**記録する — 応答を待ってから記録すると、待っているあいだに
  // 届いた 2 回目のタップが窓をすり抜けて打刻が 2 行入る
  lastPunchedCardId = cardId
  lastPunchedAt = now
  try {
    await punchTimecard(cardId)
    punchedAt.value = new Date()
  }
  catch (e) {
    punchErrorMessage.value = punchFailureMessage(e)
  }
}

// PC の今の段を CoreS3 に送り、画面を連動させる (Refs ippoan/alc-app-s3#135)
const { syncStep, sendResult } = useCoreS3Stage()
watch(step, syncStep, { immediate: true })

// 電子車検証の管理番号・車両 ID (タップで保持。段は進めない。Refs ippoan/alc-app-s3#110)
const carinsCertNo = ref<string | undefined>(undefined)
const carinsVehicleId = ref<string | undefined>(undefined)
/** rc= (読み取り失敗、再タップ促し) */
const carinsReadError = ref(false)
const carinsLookup = ref<CarInspectionLookupResponse | null>(null)
/** matched_by === 'none' は別に灰表示するのでここでは判定しない */
const carinsExpiryStatus = computed<LicenseExpiryStatus | null>(() => {
  const expiresOn = carinsLookup.value?.expires_on
  return expiresOn ? checkLicenseExpiryFromString(expiresOn) : null
})

// 電子車検証の段で CoreS3 の NFC_CARINS を直接受ける (新しい component は作らず、
// 免許証の通り道 (useNfcReader) にも流さない。Refs ippoan/alc-app-s3#135)。
// 番号を保持して段に留まる — chooseVehicleStep は 3 つのボタンでだけ呼ぶ
// (Refs ippoan/alc-app-s3#110)
const offCarinsEvent = useCoreS3Serial().onEvent((name, args) => {
  if (name !== 'NFC_CARINS' || step.value !== 'vehicle') return

  const rc = evtArg(args, 'rc')
  if (rc) {
    // 再タップで上書きされるまで残す
    carinsReadError.value = true
    return
  }

  const mgno = evtArg(args, 'mgno')
  const carid = evtArg(args, 'carid')
  carinsReadError.value = false
  // 旧 firmware (引数なし) は番号なしのまま段に留まる
  if (!mgno && !carid) return

  carinsCertNo.value = mgno || undefined
  carinsVehicleId.value = carid || undefined
  carinsLookup.value = null
  lookupCarInspection(carinsCertNo.value, carinsVehicleId.value)
    .then((res) => { carinsLookup.value = res })
    // lookupCarInspection 自身が失敗を吸収する契約だが、テストの直接モック等でも
    // 確実に警告なしで進めるため二重に守る
    .catch(() => { carinsLookup.value = null })
})
onUnmounted(offCarinsEvent)

const saveError = ref<string | null>(null)
const isSaving = ref(false)
const saveStatus = ref<'saved' | 'queued' | null>(null)

// 免許証有効期限
const licenseExpiryDate = ref<Date | null>(null)
const licenseExpiryStatus = ref<LicenseExpiryStatus | null>(null)

// オフライン同期
const { isOnline, pending, isSyncing, save: offlineSave, syncQueue } = useOfflineSync()

// シングルトン再呼出で共有状態取得
const { isSyncing: isFaceSyncing, sync: faceSync } = useFaceSync()

// 手動入力フォールバック
const manualIdInput = ref('')
const useManualInput = ref(false)

// 測定レコード早期作成
const activeMeasurementId = ref<string | null>(null)

// 録画 (measuring ステップ用)
const {
  stream: measuringStream,
  videoRef: measuringVideoRef,
  isActive: isMeasuringCameraActive,
  start: startMeasuringCamera,
  stop: stopMeasuringCamera,
} = useCamera()
const { isRecording, startRecording, stopRecording } = useVideoRecorder()
const recordedVideoBlob = ref<Blob | null>(null)
const videoStoreId = ref<string | null>(null)
const videoUploadStatus = ref<'pending' | 'uploading' | 'uploaded' | 'failed' | null>(null)

/** 測定開始レコードを作成 (best-effort: 失敗しても測定フローは続行) */
async function tryStartMeasurement(empId: string) {
  console.log('[Measurement] tryStartMeasurement called, empId:', empId, 'isOnline:', isOnline.value)
  if (!isOnline.value) return
  try {
    const m = await startMeasurement(empId)
    activeMeasurementId.value = m.id
    console.log('[Measurement] startMeasurement success, id:', m.id)
  } catch (e) {
    console.warn('[Measurement] startMeasurement failed:', e)
    activeMeasurementId.value = null
  }
}

// NFC 読み取り → employee UUID を解決
const employeeName = ref('')
const approvalError = ref<string | null>(null)
async function onNfcRead(nfcId: string, expiryDate?: Date) {
  // **測定中のタップで段が巻き戻らないようにする。このガードを外さない**
  // (Refs ippoan/alc-app-s3#135)
  if (step.value !== 'nfc') return
  approvalError.value = null
  clearPunchState()
  if (expiryDate) {
    licenseExpiryDate.value = expiryDate
    licenseExpiryStatus.value = checkLicenseExpiry(expiryDate)
  }
  try {
    const emp = await getEmployeeByNfcId(nfcId)
    employeeId.value = emp.id
    employeeName.value = emp.name
    await tryStartMeasurement(emp.id)
    await faceSync()
    // 打刻は best-effort。**失敗しても種別の選択へ必ず進む**
    await tryPunch(nfcId)
    step.value = 'choice'
  } catch {
    const msg = employeeNotFoundByNfc(nfcId)
    console.error(msg)
    approvalError.value = msg
  }
}

// 手動入力 (社員番号で検索)
const manualError = ref<string | null>(null)
async function onManualSubmit() {
  const input = manualIdInput.value.trim()
  if (!input) return
  manualError.value = null
  approvalError.value = null
  clearPunchState()
  try {
    const emp = await getEmployeeByCode(input)
    employeeId.value = emp.id
    employeeName.value = emp.name
    await tryStartMeasurement(emp.id)
    await faceSync()
    // 手入力には card_id が無いので打刻しない (打刻は免許証のタッチだけ)
    punchSkipReason.value = 'manual'
    step.value = 'choice'
  } catch {
    manualError.value = employeeNotFoundByCode(input)
  }
}

// BLE Medical Gateway
const {
  latestTemperature: bleTemperature,
  latestBloodPressure: bleBloodPressure,
} = useBleGateway()

// 医療ステップ: BLE / 手動入力 タブ
const medicalInputTab = ref<'ble' | 'manual'>('ble')
watch(isDemoMode, (v) => {
  if (v) medicalInputTab.value = 'manual'
}, { immediate: true })

// 手動入力の医療データ (BLE未接続フォールバック用)
const manualMedicalData = ref<import('~/types').SubmitMedicalData | null>(null)
const medicalInputSource = ref<'ble' | 'manual' | null>(null)

onMounted(() => {
  // 録画: 7日超のローカル録画を削除 + 未アップロード分をリトライ
  cleanupOldVideos(7).catch(() => {})
  getPendingVideos().then(pending => {
    for (const v of pending) {
      if (!v.measurementId) continue
      const mId = v.measurementId
      uploadBlowVideo(v.videoBlob)
        .then(url => {
          console.log('[VideoRetry] Uploaded pending video:', v.id)
          updateMeasurement(mId, { video_url: url }).catch(() => {})
          markVideoUploaded(v.id).catch(() => {})
        })
        .catch(() => console.warn('[VideoRetry] Failed:', v.id))
    }
  }).catch(() => {})
})

// BLE 体温・血圧を取得時に即レコード更新（best-effort）
watch(bleTemperature, (t) => {
  console.log('[Measurement] bleTemperature changed:', t?.value, 'activeMeasurementId:', activeMeasurementId.value)
  if (t && activeMeasurementId.value) {
    updateMeasurement(activeMeasurementId.value, {
      temperature: t.value,
      medical_measured_at: t.measuredAt.toISOString(),
    })
      .then(() => console.log('[Measurement] temperature saved'))
      .catch(e => console.error('[Measurement] temperature update failed:', e))
  }
})

watch(bleBloodPressure, (bp) => {
  console.log('[Measurement] bleBloodPressure changed:', bp, 'activeMeasurementId:', activeMeasurementId.value)
  if (bp && activeMeasurementId.value) {
    updateMeasurement(activeMeasurementId.value, {
      systolic: bp.systolic,
      diastolic: bp.diastolic,
      pulse: bp.pulse,
      medical_measured_at: bp.measuredAt.toISOString(),
    })
      .then(() => console.log('[Measurement] blood pressure saved'))
      .catch(e => console.error('[Measurement] blood pressure update failed:', e))
  }
})

// BLE ステップ → 次へ or スキップ
function onMedicalNext() {
  medicalInputSource.value = 'ble'
  step.value = 'measuring'
}
function onMedicalSkip() {
  medicalInputSource.value = null
  step.value = 'measuring'
}

// 手動入力 → 次へ
function onManualMedicalSubmit(data: import('~/types').SubmitMedicalData) {
  manualMedicalData.value = data
  medicalInputSource.value = 'manual'
  step.value = 'measuring'
}

// measuring ステップでカメラ起動/停止
watch(step, async (s, prev) => {
  if (s === 'measuring') {
    try {
      await startMeasuringCamera('user')
      console.log('[Measurement] Recording camera started')
      // デモモードではすぐに録画開始 (FC-1200 state 変化がないため)
      if (isDemoMode.value && measuringStream.value) {
        startRecording(measuringStream.value)
      }
    } catch (e) {
      console.warn('[Measurement] Recording camera failed:', e)
    }
  } else if (prev === 'measuring') {
    stopMeasuringCamera()
  }
})

// AlcMeasurement の状態変化 → 録画開始/停止
function onAlcStateChange(alcState: string) {
  if (alcState === 'blow_waiting' && measuringStream.value && !isRecording.value) {
    startRecording(measuringStream.value)
  }
}

// FC-1200 測定結果 → BLE 医療データ / 手動入力データをマージ → API に保存
async function onMeasurementResult(result: MeasurementResult) {
  result.tenkoType = tenkoType.value
  result.carinsCertNo = carinsCertNo.value
  result.carinsVehicleId = carinsVehicleId.value
  // BLE Medical Gateway のデータをマージ
  if (bleTemperature.value) {
    result.temperature = bleTemperature.value.value
  }
  if (bleBloodPressure.value) {
    result.systolic = bleBloodPressure.value.systolic
    result.diastolic = bleBloodPressure.value.diastolic
    result.pulse = bleBloodPressure.value.pulse
  }
  // BLE データがない場合は手動入力データをマージ
  if (!bleTemperature.value && manualMedicalData.value?.temperature !== undefined) {
    result.temperature = manualMedicalData.value.temperature
  }
  if (!bleBloodPressure.value && manualMedicalData.value) {
    if (manualMedicalData.value.systolic !== undefined) result.systolic = manualMedicalData.value.systolic
    if (manualMedicalData.value.diastolic !== undefined) result.diastolic = manualMedicalData.value.diastolic
    if (manualMedicalData.value.pulse !== undefined) result.pulse = manualMedicalData.value.pulse
  }
  if (manualMedicalData.value?.medical_measured_at && !bleTemperature.value && !bleBloodPressure.value) {
    result.medicalMeasuredAt = new Date(manualMedicalData.value.medical_measured_at)
  }
  if (bleTemperature.value || bleBloodPressure.value) {
    const times = [
      bleTemperature.value?.measuredAt,
      bleBloodPressure.value?.measuredAt,
    ].filter((t): t is Date => t !== undefined)
    if (times.length > 0) {
      result.medicalMeasuredAt = times.sort((a, b) => b.getTime() - a.getTime())[0]
    }
  }

  measurementResult.value = result
  step.value = 'result'

  // 録画停止 + ローカル保存
  const videoBlob = await stopRecording()
  if (videoBlob) {
    recordedVideoBlob.value = videoBlob
    const vid = crypto.randomUUID()
    videoStoreId.value = vid
    saveVideo(vid, videoBlob, employeeId.value, activeMeasurementId.value || undefined)
      .catch(e => console.warn('[Measurement] video local save failed:', e))
    console.log(`[Measurement] Video recorded: ${(videoBlob.size / 1024).toFixed(0)}KB`)
  }
  stopMeasuringCamera()

  isSaving.value = true
  saveError.value = null
  saveStatus.value = null
  try {
    console.log('[Measurement] activeMeasurementId:', activeMeasurementId.value, 'isOnline:', isOnline.value)
    if (activeMeasurementId.value && isOnline.value) {
      // started レコードを completed に更新
      const updateData = {
        status: 'completed',
        alcohol_value: result.alcoholValue,
        result_type: result.resultType,
        device_use_count: result.deviceUseCount,
        face_photo_url: result.facePhotoUrl,
        measured_at: result.measuredAt.toISOString(),
        temperature: result.temperature,
        systolic: result.systolic,
        diastolic: result.diastolic,
        pulse: result.pulse,
        medical_measured_at: result.medicalMeasuredAt?.toISOString(),
        face_verified: null,
        medical_manual_input: medicalInputSource.value === 'manual' ? true : undefined,
        record_as_tenko: true,
        tenko_type: result.tenkoType ?? 'normal',
        carins_cert_no: result.carinsCertNo,
        carins_vehicle_id: result.carinsVehicleId,
      }
      // carins の番号は console に出さない (simplify-reviewer の検査点、Refs ippoan/alc-app-s3#110)
      const loggableUpdateData: Record<string, unknown> = { ...updateData }
      delete loggableUpdateData.carins_cert_no
      delete loggableUpdateData.carins_vehicle_id
      console.log('[Measurement] updateMeasurement PUT data:', JSON.stringify(loggableUpdateData))
      await updateMeasurement(activeMeasurementId.value, updateData)
      console.log('[Measurement] updateMeasurement success')
      saveStatus.value = 'saved'

      // 録画をバックグラウンドでアップロード
      if (recordedVideoBlob.value && activeMeasurementId.value) {
        const mId = activeMeasurementId.value
        const vId = videoStoreId.value
        videoUploadStatus.value = 'uploading'
        uploadBlowVideo(recordedVideoBlob.value)
          .then(url => {
            console.log('[Measurement] Video uploaded:', url)
            videoUploadStatus.value = 'uploaded'
            updateMeasurement(mId, { video_url: url }).catch(() => {})
            if (vId) markVideoUploaded(vId).catch(() => {})
          })
          .catch(e => {
            console.warn('[Measurement] Video upload failed (will retry later):', e)
            videoUploadStatus.value = 'failed'
          })
      } else if (recordedVideoBlob.value) {
        videoUploadStatus.value = 'pending'
      }
    } else {
      // オフラインまたは activeMeasurementId なし → 従来のフロー
      console.log('[Measurement] fallback to offlineSave')
      saveStatus.value = await offlineSave(result, undefined, activeMeasurementId.value || undefined, videoStoreId.value || undefined)
      if (recordedVideoBlob.value) videoUploadStatus.value = 'pending'
    }
  } catch (e) {
    // 更新失敗時はオフラインキューにフォールバック
    console.error('[Measurement] updateMeasurement failed:', e)
    try {
      saveStatus.value = await offlineSave(result, undefined, activeMeasurementId.value || undefined, videoStoreId.value || undefined)
      if (recordedVideoBlob.value) videoUploadStatus.value = 'pending'
    } catch (e2) {
      saveError.value = e2 instanceof Error ? e2.message : '保存エラー'
      console.warn('測定結果の保存に失敗:', e2)
    }
  } finally {
    isSaving.value = false
  }

  sendResult(result)
}

// リセット
function reset() {
  step.value = 'nfc'
  employeeId.value = ''
  employeeName.value = ''
  tenkoType.value = 'normal'
  manualIdInput.value = ''
  manualError.value = null
  useManualInput.value = false
  measurementResult.value = null
  saveError.value = null
  saveStatus.value = null
  isSaving.value = false
  licenseExpiryDate.value = null
  licenseExpiryStatus.value = null
  carinsCertNo.value = undefined
  carinsVehicleId.value = undefined
  carinsReadError.value = false
  carinsLookup.value = null
  clearPunchState()
  lastPunchedCardId = null
  lastPunchedAt = 0
  activeMeasurementId.value = null
  manualMedicalData.value = null
  medicalInputSource.value = null
  recordedVideoBlob.value = null
  videoStoreId.value = null
  videoUploadStatus.value = null
  stopMeasuringCamera()
}

const STEP_LABEL: Record<string, string> = {
  nfc: 'NFC',
  vehicle: '車検証',
  medical: SHOW_BLOOD_PRESSURE ? '体温・血圧' : '体温',
  measuring: '測定',
  result: '結果',
}
/**
 * 段の見出し。**車検証の段を通るのは始業点呼だけ**なので、アルコールチェックと
 * 終業点呼では見出しからも「車検証」を落とす (Refs ippoan/alc-app-s3#135)。
 */
const stepKeys = computed<string[]>(() => tenkoType.value === 'pre_operation'
  ? ['nfc', 'vehicle', 'medical', 'measuring', 'result']
  : ['nfc', 'medical', 'measuring', 'result'])
const steps = computed(() => stepKeys.value.map(k => STEP_LABEL[k]!))
// choice は免許証をタッチした人がその場で種別を選ぶだけの段なので、見出しの現在地は
// NFC のまま動かさない (CoreS3 に送る段階も `choice: 'NFC'` で揃えてある)
const currentStepIndex = computed(() => stepKeys.value.indexOf(step.value === 'choice' ? 'nfc' : step.value))
</script>

<template>
  <div :class="[
    'w-full flex-1 overflow-y-auto p-4',
    landscape ? 'flex gap-4 max-w-4xl mx-auto' : 'flex flex-col items-center'
  ]">
    <!-- 左列 (横画面) / 上部 (縦画面): バナー + ステップ + フッターリンク -->
    <div :class="landscape ? 'w-2/5 flex flex-col shrink-0' : 'w-full flex flex-col items-center'">
      <!-- オフラインバナー -->
      <div
        v-if="!isOnline"
        :class="['w-full bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 mb-2 text-center text-sm text-amber-700', landscape ? '' : 'max-w-md']"
      >
        オフライン — 測定結果はローカルに保存されます
      </div>
      <!-- 未送信キュー通知 -->
      <div
        v-if="pending > 0 && isOnline && !isSyncing"
        :class="['w-full bg-blue-50 border border-blue-200 rounded-xl px-4 py-2 mb-2 flex items-center justify-between text-sm', landscape ? '' : 'max-w-md']"
      >
        <span class="text-blue-700">未送信の測定結果: {{ pending }}件</span>
        <button class="text-blue-600 font-medium hover:underline" @click="syncQueue">同期する</button>
      </div>
      <div
        v-if="isSyncing"
        :class="['w-full bg-blue-50 border border-blue-200 rounded-xl px-4 py-2 mb-2 text-center text-sm text-blue-700', landscape ? '' : 'max-w-md']"
      >
        同期中...
      </div>
      <div
        v-if="isFaceSyncing"
        :class="['w-full bg-green-50 border border-green-200 rounded-xl px-4 py-2 mb-2 text-center text-sm text-green-700', landscape ? '' : 'max-w-md']"
      >
        顔データ同期中...
      </div>

      <!-- 免許証有効期限切れ警告 -->
      <div
        v-if="licenseExpiryStatus === 'expired' && licenseExpiryDate"
        :class="['w-full border rounded-xl px-4 py-2 mb-2 text-center text-sm', EXPIRY_TONE_CLASS.banner[expiryTone('expired').tone], landscape ? '' : 'max-w-md']"
      >
        免許証の有効期限が切れています ({{ formatExpiryDate(licenseExpiryDate) }})
      </div>
      <div
        v-if="licenseExpiryStatus === 'expiring_soon' && licenseExpiryDate"
        :class="['w-full border rounded-xl px-4 py-2 mb-2 text-center text-sm', EXPIRY_TONE_CLASS.banner[expiryTone('expiring_soon').tone], landscape ? '' : 'max-w-md']"
      >
        免許証の有効期限が近づいています ({{ formatExpiryDate(licenseExpiryDate) }})
      </div>

      <header :class="['w-full text-center', landscape ? 'py-2' : 'max-w-md py-6']">
        <h1 :class="['font-bold text-gray-800', landscape ? 'text-lg' : 'text-2xl']">アルコールチェッカー</h1>
        <!-- ステップインジケーター -->
        <div :class="['flex items-center mt-3', landscape ? 'flex-wrap gap-1 justify-center' : 'justify-center']">
          <template v-for="(s, i) in steps" :key="i">
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
              v-if="i < steps.length - 1"
              class="w-4 h-4 mx-1 shrink-0"
              :class="i < currentStepIndex ? 'text-green-400' : 'text-gray-300'"
              fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </template>
        </div>
      </header>

      <!-- フッターリンク (横画面時は左列に配置) -->
      <div v-if="landscape" class="mt-auto pt-2">
        <div class="flex flex-wrap justify-center gap-4">
          <button
            v-if="step !== 'nfc'"
            class="text-gray-500 hover:text-gray-700 text-sm"
            @click="reset"
          >
            最初からやり直す
          </button>
          <NuxtLink to="/register" class="text-blue-600 hover:underline text-sm">
            顔登録
          </NuxtLink>
          <NuxtLink to="/maintenance" class="text-blue-600 hover:underline text-sm">
            メンテナンス
          </NuxtLink>
        </div>
      </div>
    </div>

    <!-- 右列 (横画面) / メインコンテンツ (縦画面) -->
    <main :class="['w-full flex-1', landscape ? 'min-h-0 overflow-y-auto' : 'max-w-md']">
      <!-- Step 1: NFC / 手動入力 -->
      <div v-if="step === 'nfc'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-6 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">乗務員ID</h2>

          <!-- 承認エラー -->
          <div v-if="approvalError" class="bg-red-50 border border-red-200 rounded-xl p-3 mb-4 text-sm text-red-700">
            {{ approvalError }}
          </div>

          <!-- NFC モード -->
          <div v-if="!useManualInput && !isDemoMode">
            <NfcStatus @read="onNfcRead" />
            <button
              class="w-full mt-4 text-sm text-gray-500 hover:text-gray-700 underline"
              @click="useManualInput = true"
            >
              手動でIDを入力する
            </button>
          </div>

          <!-- 手動入力モード -->
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

      <!-- Step 1.5: 種別の選択 (免許証タッチの直後。打刻はここへ来る前に済んでいる、
           Refs ippoan/alc-app-s3#135) -->
      <div v-if="step === 'choice'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-6 shadow-sm">
          <!-- 打刻の結果 (何も選ばずに離れても打刻は残る) -->
          <div
            v-if="punchedAt"
            data-testid="punch-done"
            :class="['w-full border rounded-xl px-4 py-2 mb-4 text-center text-sm', EXPIRY_TONE_CLASS.banner.green]"
          >
            打刻しました {{ punchedAtLabel }}
          </div>
          <div
            v-else-if="punchErrorMessage"
            data-testid="punch-failed"
            :class="['w-full border rounded-xl px-4 py-2 mb-4 text-center text-sm', EXPIRY_TONE_CLASS.banner.red]"
          >
            {{ punchErrorMessage }}
          </div>
          <div
            v-else-if="punchSkipReason"
            data-testid="punch-skipped"
            :class="['w-full border rounded-xl px-4 py-2 mb-4 text-center text-sm', EXPIRY_TONE_CLASS.banner.yellow]"
          >
            {{ punchSkipReason === 'offline' ? 'オフライン — 打刻は記録されません' : '手入力では打刻されません' }}
          </div>

          <h2 class="text-lg font-semibold text-gray-700 mb-2">操作を選んでください</h2>
          <p class="text-sm text-gray-500 mb-4">{{ employeeName }}</p>

          <div class="flex flex-col gap-3">
            <button
              data-testid="choice-alcohol"
              class="w-full px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
              @click="chooseType('normal')"
            >
              アルコールチェック
            </button>
            <button
              data-testid="choice-pre-operation"
              class="w-full px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
              @click="chooseType('pre_operation')"
            >
              始業点呼
            </button>
            <button
              data-testid="choice-post-operation"
              class="w-full px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
              @click="chooseType('post_operation')"
            >
              終業点呼
            </button>
          </div>
        </div>
      </div>

      <!-- Step 2: 電子車検証 (タップ待ち。スキップ・始業・終業も選べる、Refs ippoan/alc-app-s3#135) -->
      <div v-if="step === 'vehicle'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-6 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">電子車検証をタップしてください</h2>
          <p class="text-sm text-gray-500 mb-4">{{ employeeName }}</p>

          <!-- 読み取り失敗 (rc=): 再タップを促す (Refs ippoan/alc-app-s3#110) -->
          <div
            v-if="carinsReadError"
            :class="['w-full border rounded-xl px-4 py-2 mb-4 text-center text-sm', EXPIRY_TONE_CLASS.banner.red]"
          >
            車検証を読み取れませんでした。もう一度タップしてください
          </div>

          <!-- 番号を保持中 (段はここに留まる) -->
          <div v-else-if="carinsCertNo || carinsVehicleId" class="mb-4">
            <p class="text-sm text-green-700 mb-2">
              車検証: 読取済み<template v-if="carinsLookup?.car_no"> (登録番号 = {{ carinsLookup.car_no }})</template>
            </p>
            <div
              v-if="carinsLookup?.matched_by === 'none'"
              :class="['w-full border rounded-xl px-4 py-2 text-center text-sm', EXPIRY_TONE_CLASS.banner.gray]"
            >
              車検証データ未登録
            </div>
            <div
              v-else-if="carinsExpiryStatus === 'expired' && carinsLookup?.expires_on"
              :class="['w-full border rounded-xl px-4 py-2 text-center text-sm', EXPIRY_TONE_CLASS.banner.red]"
            >
              車検の有効期限が切れています ({{ carinsLookup.expires_on.replace(/-/g, '/') }})
            </div>
            <div
              v-else-if="carinsExpiryStatus === 'expiring_soon' && carinsLookup?.expires_on"
              :class="['w-full border rounded-xl px-4 py-2 text-center text-sm', EXPIRY_TONE_CLASS.banner.yellow]"
            >
              車検の有効期限が近づいています ({{ carinsLookup.expires_on.replace(/-/g, '/') }})
            </div>
          </div>

          <div class="flex flex-col gap-3">
            <button
              data-testid="vehicle-pre-operation"
              class="w-full px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
              @click="chooseVehicleStep('pre_operation')"
            >
              始業点呼
            </button>
            <button
              data-testid="vehicle-post-operation"
              class="w-full px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
              @click="chooseVehicleStep('post_operation')"
            >
              終業点呼
            </button>
            <button
              data-testid="vehicle-skip"
              class="w-full px-6 py-3 text-gray-500 hover:text-gray-700 text-sm underline"
              @click="chooseVehicleStep('normal')"
            >
              スキップ
            </button>
          </div>
        </div>
      </div>

      <!-- Step 3: 体温・血圧 (BLE Medical Gateway / 手動入力) -->
      <div v-if="step === 'medical'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-6 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-2">{{ SHOW_BLOOD_PRESSURE ? '体温・血圧' : '体温' }}</h2>
          <p class="text-sm text-gray-500 mb-4">{{ employeeName }}</p>

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
            @next="onMedicalNext"
            @skip="onMedicalSkip"
          />
          <ManualMedicalInput
            v-else
            @submit="onManualMedicalSubmit"
            @skip="onMedicalSkip"
          />
        </div>
      </div>

      <!-- Step 4: FC-1200 測定 -->
      <div v-if="step === 'measuring'" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-6 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-700 mb-4">アルコール測定</h2>
          <p class="text-sm text-gray-500 mb-4">{{ employeeName }}</p>

          <!-- 録画カメラプレビュー (v-show: useCamera.start の時点で video が在る必要がある。v-if だと srcObject が入らず映像が出ない) -->
          <div v-show="isMeasuringCameraActive" class="relative mb-4 flex justify-center">
            <video
              ref="measuringVideoRef"
              autoplay
              playsinline
              muted
              class="w-full aspect-video rounded-lg object-cover border border-gray-200"
            />
            <div
              v-if="isRecording"
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

      <!-- Step 5: 結果表示 -->
      <div v-if="step === 'result' && measurementResult" class="flex flex-col gap-4">
        <ResultCard
          :result="measurementResult"
          :employee-name="employeeName"
          @reset="reset"
        />
        <!-- 医療データ入力元バッジ -->
        <div
          v-if="medicalInputSource && (measurementResult.temperature || (SHOW_BLOOD_PRESSURE && measurementResult.systolic))"
          class="text-center text-xs"
        >
          <span
            class="inline-flex items-center gap-1 px-2 py-1 rounded-full"
            :class="medicalInputSource === 'manual' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'"
          >
            {{ medicalInputSource === 'manual' ? '手動入力' : 'CoreS3' }}
          </span>
        </div>
        <!-- API 保存状態 -->
        <div v-if="isSaving" class="text-center text-sm text-gray-500">
          保存中...
        </div>
        <div v-else-if="saveStatus === 'queued'" class="text-center text-sm text-amber-600">
          オフラインのためローカルに保存しました (オンライン復帰時に自動送信)
        </div>
        <div v-else-if="saveError" class="text-center text-sm text-red-500">
          保存失敗: {{ saveError }}
        </div>
        <!-- 録画アップロード状態 -->
        <div v-if="videoUploadStatus" class="text-center text-xs">
          <span
            class="inline-flex items-center gap-1 px-2 py-1 rounded-full"
            :class="{
              'bg-blue-100 text-blue-700': videoUploadStatus === 'uploading',
              'bg-green-100 text-green-700': videoUploadStatus === 'uploaded',
              'bg-amber-100 text-amber-700': videoUploadStatus === 'pending',
              'bg-red-100 text-red-700': videoUploadStatus === 'failed',
            }"
          >
            <template v-if="videoUploadStatus === 'uploading'">
              <span class="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
              録画アップロード中...
            </template>
            <template v-else-if="videoUploadStatus === 'uploaded'">
              録画アップロード完了
            </template>
            <template v-else-if="videoUploadStatus === 'pending'">
              録画はローカルに保存済み (後でアップロード)
            </template>
            <template v-else-if="videoUploadStatus === 'failed'">
              録画アップロード失敗 (次回起動時にリトライ)
            </template>
          </span>
        </div>
      </div>
    </main>

    <!-- 呼び出し元がカードの下に足したい内容 (例: 本日の打刻履歴)。空なら何も出ない。
         直後のナビゲーションより上に出すことで、リンクの塊を画面最下部に保つ (Refs #238) -->
    <slot name="below-card" />

    <!-- ナビゲーション (縦画面時のみ。横画面時は左列に配置) -->
    <footer v-if="!landscape" class="w-full max-w-md py-4">
      <div class="flex justify-center gap-4">
        <button
          v-if="step !== 'nfc'"
          class="text-gray-500 hover:text-gray-700 text-sm"
          @click="reset"
        >
          最初からやり直す
        </button>
        <NuxtLink to="/register" class="text-blue-600 hover:underline text-sm">
          顔登録
        </NuxtLink>
        <NuxtLink to="/maintenance" class="text-blue-600 hover:underline text-sm">
          メンテナンス
        </NuxtLink>
      </div>
    </footer>
  </div>
</template>
