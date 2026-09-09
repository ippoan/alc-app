import type {
  TenkoSchedule, TenkoSession, TenkoSessionStatus, TenkoType,
  FaceAuthResult, SubmitAlcoholResult, SubmitMedicalData,
  SubmitSelfDeclaration, SubmitDailyInspection, SubmitOperationReport,
  StartTenkoSession, SafetyJudgment, CarryingItem, CarryingItemCheckInput,
} from '~/types'
import {
  getPendingSchedules, startTenkoSession,
  submitAlcohol, submitMedical, submitSelfDeclaration,
  submitDailyInspection, confirmInstruction, submitReport,
  cancelTenkoSession, uploadFacePhoto,
  getCarryingItems, submitCarryingItemChecks,
} from '~/utils/api'
import { noPendingSchedule } from '~/utils/employee-lookup-messages'

/** UI ステップ (バックエンド status とは別) */
export type TenkoStep =
  | 'nfc'
  | 'schedule_select'
  | 'face_auth'
  | 'alcohol'
  | 'medical'
  | 'self_declaration'
  | 'safety_result'
  | 'daily_inspection'
  | 'carrying_items'
  | 'instruction'
  | 'report'
  | 'completed'
  | 'interrupted'
  | 'cancelled'

export function useTenkoKiosk(options?: { remoteMode?: boolean }) {
  const remoteMode = options?.remoteMode ?? false
  const step = ref<TenkoStep>('nfc')
  const employeeId = ref('')
  const employeeName = ref('')
  const pendingSchedules = ref<TenkoSchedule[]>([])
  const selectedSchedule = ref<TenkoSchedule | null>(null)
  const session = ref<TenkoSession | null>(null)
  const carryingItems = ref<CarryingItem[]>([])
  const error = ref<string | null>(null)
  const isLoading = ref(false)

  // 顔認証結果
  const faceSnapshot = ref<Blob | null>(null)
  const facePhotoUrl = ref<string | null>(null)

  // 安全判定結果
  const safetyJudgment = ref<SafetyJudgment | null>(null)

  // --- 現在の点呼タイプ ---
  const tenkoType = computed<TenkoType | null>(() =>
    session.value?.tenko_type ?? selectedSchedule.value?.tenko_type ?? (remoteMode ? 'pre_operation' : null),
  )
  const isPreOperation = computed(() => tenkoType.value === 'pre_operation')

  // --- ステップ定義 (点呼タイプ別) ---
  const stepLabels = computed(() => {
    const scheduleLabel = remoteMode ? [] : ['予定選択']
    if (isPreOperation.value) {
      return ['NFC', ...scheduleLabel, '顔認証', '体温・血圧', '自己申告', '日常点検', 'アルコール', '指示確認', '完了']
    }
    return ['NFC', ...scheduleLabel, '顔認証', 'アルコール', '指示確認', '運行報告', '完了']
  })
  const stepKeys = computed<TenkoStep[]>(() => {
    const scheduleKey: TenkoStep[] = remoteMode ? [] : ['schedule_select']
    if (isPreOperation.value) {
      return ['nfc', ...scheduleKey, 'face_auth', 'medical', 'self_declaration', 'daily_inspection', 'carrying_items', 'alcohol', 'instruction', 'completed']
    }
    return ['nfc', ...scheduleKey, 'face_auth', 'alcohol', 'instruction', 'report', 'completed']
  })
  const currentStepIndex = computed(() => {
    const idx = stepKeys.value.indexOf(step.value)
    // safety_result / interrupted / cancelled はステップバーに表示しない
    if (idx === -1) {
      if (step.value === 'safety_result') return stepKeys.value.indexOf('self_declaration') + 1
      if (step.value === 'interrupted' || step.value === 'cancelled') return stepKeys.value.length - 1
    }
    return idx
  })

  // --- 乗務員特定 ---
  async function identifyEmployee(empId: string, empName: string) {
    error.value = null
    employeeId.value = empId
    employeeName.value = empName

    // 遠隔点呼: スケジュール不要 → 直接顔認証へ
    if (remoteMode) {
      step.value = 'face_auth'
      return
    }

    isLoading.value = true
    try {
      const schedules = await getPendingSchedules(empId)
      pendingSchedules.value = schedules
      if (schedules.length === 0) {
        error.value = noPendingSchedule()
        return
      }
      step.value = 'schedule_select'
    } catch (e) {
      error.value = e instanceof Error ? e.message : '予定取得に失敗しました'
    } finally {
      isLoading.value = false
    }
  }

  // --- スケジュール選択 → セッション開始 ---
  async function selectSchedule(schedule: TenkoSchedule) {
    error.value = null
    selectedSchedule.value = schedule
    step.value = 'face_auth'
  }

  // --- 顔認証完了 → セッション開始 + アルコール測定 ---
  async function onFaceAuthComplete(result: FaceAuthResult) {
    if (!result.verified) return
    if (!remoteMode && !selectedSchedule.value) return
    error.value = null
    isLoading.value = true

    faceSnapshot.value = result.snapshot ?? null

    try {
      // 顔写真アップロード
      let photoUrl: string | undefined
      if (result.snapshot) {
        photoUrl = await uploadFacePhoto(result.snapshot)
        facePhotoUrl.value = photoUrl
      }

      // セッション開始
      const body: StartTenkoSession = selectedSchedule.value
        ? { schedule_id: selectedSchedule.value.id, employee_id: employeeId.value, identity_face_photo_url: photoUrl }
        : { tenko_type: 'pre_operation', employee_id: employeeId.value, identity_face_photo_url: photoUrl }
      const s = await startTenkoSession(body)
      session.value = s
      _advanceByStatus(s.status)
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'セッション開始に失敗しました'
    } finally {
      isLoading.value = false
    }
  }

  // --- アルコール結果送信 ---
  async function onAlcoholResult(alcoholResult: string, alcoholValue: number, measurementId?: string, alcoholFacePhotoUrl?: string) {
    if (!session.value) return
    error.value = null
    isLoading.value = true

    try {
      const body: SubmitAlcoholResult = {
        measurement_id: measurementId,
        alcohol_result: alcoholResult,
        alcohol_value: alcoholValue,
        alcohol_face_photo_url: alcoholFacePhotoUrl,
      }
      const s = await submitAlcohol(session.value.id, body)
      session.value = s

      // アルコール検知 → cancelled
      if (s.status === 'cancelled') {
        step.value = 'cancelled'
        return
      }

      // 業務前: medical_pending → medical ステップ
      // 業務後: report_pending → instruction ステップ (後述)
      _advanceByStatus(s.status)
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'アルコール結果送信に失敗しました'
    } finally {
      isLoading.value = false
    }
  }

  // --- 医療データ送信 (業務前のみ) ---
  async function onMedicalSubmit(data: SubmitMedicalData) {
    if (!session.value) return
    error.value = null
    isLoading.value = true

    try {
      const s = await submitMedical(session.value.id, data)
      session.value = s
      _advanceByStatus(s.status)
    } catch (e) {
      error.value = e instanceof Error ? e.message : '医療データ送信に失敗しました'
    } finally {
      isLoading.value = false
    }
  }

  // --- 自己申告送信 ---
  async function onSelfDeclarationSubmit(data: SubmitSelfDeclaration) {
    if (!session.value) return
    error.value = null
    isLoading.value = true

    try {
      const s = await submitSelfDeclaration(session.value.id, data)
      session.value = s

      // 安全判定結果を取得
      if (s.safety_judgment) {
        safetyJudgment.value = s.safety_judgment
      }

      _advanceByStatus(s.status)
    } catch (e) {
      error.value = e instanceof Error ? e.message : '自己申告送信に失敗しました'
    } finally {
      isLoading.value = false
    }
  }

  // --- 日常点検送信 ---
  async function onDailyInspectionSubmit(data: SubmitDailyInspection) {
    if (!session.value) return
    error.value = null
    isLoading.value = true

    try {
      const s = await submitDailyInspection(session.value.id, data)
      session.value = s

      if (s.status === 'cancelled') {
        step.value = 'cancelled'
        return
      }
      _advanceByStatus(s.status)
    } catch (e) {
      error.value = e instanceof Error ? e.message : '日常点検送信に失敗しました'
    } finally {
      isLoading.value = false
    }
  }

  // --- 携行品チェック ---
  async function loadCarryingItems() {
    try {
      carryingItems.value = await getCarryingItems()
    } catch {
      carryingItems.value = []
    }
    // マスタが空なら自動スキップ
    if (carryingItems.value.length === 0 && step.value === 'carrying_items') {
      step.value = 'alcohol'
    }
  }

  async function onCarryingItemsSubmit(checks: CarryingItemCheckInput[]) {
    if (!session.value) return
    error.value = null
    isLoading.value = true

    try {
      const s = await submitCarryingItemChecks(session.value.id, checks)
      session.value = s
      _advanceByStatus(s.status)
    } catch (e) {
      error.value = e instanceof Error ? e.message : '携行品チェック送信に失敗しました'
    } finally {
      isLoading.value = false
    }
  }

  // --- 指示確認 ---
  async function onInstructionConfirm() {
    if (!session.value) return
    error.value = null
    isLoading.value = true

    try {
      const s = await confirmInstruction(session.value.id)
      session.value = s
      _advanceByStatus(s.status)
    } catch (e) {
      error.value = e instanceof Error ? e.message : '指示確認に失敗しました'
    } finally {
      isLoading.value = false
    }
  }

  // --- 運行報告送信 (業務後のみ) ---
  async function onReportSubmit(data: SubmitOperationReport) {
    if (!session.value) return
    error.value = null
    isLoading.value = true

    try {
      const s = await submitReport(session.value.id, data)
      session.value = s
      _advanceByStatus(s.status)
    } catch (e) {
      error.value = e instanceof Error ? e.message : '運行報告送信に失敗しました'
    } finally {
      isLoading.value = false
    }
  }

  // --- キャンセル ---
  async function cancel(reason: string) {
    if (!session.value) return
    error.value = null

    try {
      const s = await cancelTenkoSession(session.value.id, { reason })
      session.value = s
      step.value = 'cancelled'
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'キャンセルに失敗しました'
    }
  }

  // --- バックエンド status → UI step マッピング ---
  function _advanceByStatus(status: TenkoSessionStatus) {
    switch (status) {
      case 'identity_verified':
        step.value = 'alcohol'
        break
      case 'medical_pending':
        step.value = 'medical'
        break
      case 'self_declaration_pending':
        step.value = 'self_declaration'
        break
      case 'safety_judgment_pending':
        // 自動判定は即座にレスポンスに反映されるので
        // session.safety_judgment をチェック
        if (session.value?.safety_judgment?.status === 'fail') {
          step.value = 'interrupted'
        } else {
          step.value = 'daily_inspection'
        }
        break
      case 'daily_inspection_pending':
        step.value = 'daily_inspection'
        break
      case 'carrying_items_pending':
        step.value = 'carrying_items'
        break
      case 'instruction_pending':
        step.value = 'instruction'
        break
      case 'report_pending':
        step.value = 'report'
        break
      case 'completed':
        step.value = 'completed'
        break
      case 'cancelled':
        step.value = 'cancelled'
        break
      case 'interrupted':
        step.value = 'interrupted'
        break
      default:
        break
    }
  }

  // --- リセット ---
  function reset() {
    step.value = 'nfc'
    employeeId.value = ''
    employeeName.value = ''
    pendingSchedules.value = []
    selectedSchedule.value = null
    session.value = null
    error.value = null
    isLoading.value = false
    faceSnapshot.value = null
    facePhotoUrl.value = null
    safetyJudgment.value = null
  }

  return {
    // State
    step,
    employeeId,
    employeeName,
    pendingSchedules,
    selectedSchedule,
    session,
    error,
    isLoading,
    faceSnapshot,
    safetyJudgment,
    tenkoType,
    isPreOperation,

    // Step indicator
    stepLabels,
    stepKeys,
    currentStepIndex,

    // Actions
    identifyEmployee,
    selectSchedule,
    onFaceAuthComplete,
    onAlcoholResult,
    onMedicalSubmit,
    onSelfDeclarationSubmit,
    onDailyInspectionSubmit,
    carryingItems,
    loadCarryingItems,
    onCarryingItemsSubmit,
    onInstructionConfirm,
    onReportSubmit,
    cancel,
    reset,
  }
}
