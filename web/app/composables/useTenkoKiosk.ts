import type {
  TenkoSchedule, TenkoSession, TenkoSessionStatus, TenkoType,
  FaceAuthResult, SubmitAlcoholResult, SubmitMedicalData,
  SubmitSelfDeclaration, SubmitDailyInspection, SubmitOperationReport,
  StartTenkoSession, SafetyJudgment, CarryingItem, CarryingItemCheckInput,
  TenkoRemoteEscalationReason,
} from '~/types'
import {
  getPendingSchedules, startTenkoSession,
  submitAlcohol, submitMedical, submitSelfDeclaration,
  submitDailyInspection, confirmInstruction, submitReport,
  cancelTenkoSession, uploadFacePhoto, escalateTenkoSessionToRemote,
  getCarryingItems, submitCarryingItemChecks,
} from '~/utils/api'

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

/**
 * 業務前の自動点呼を入口で止めたときの文言 (Refs ippoan/alc-app#336)。
 * `BleStatus.vue` の「血圧計: 未確認 (…)」と同じ語を使い、言い回しを増やさない。
 * **次の行動 (もう一度試す / 運行管理者に連絡) を必ず書く。**
 */
export const BP_REQUIREMENT_UNKNOWN_MESSAGE
  = 'この端末では自動点呼の業務前を実施できません (血圧計: 未確認)。'
    + '「もう一度試す」を押して確認し直すか、運行管理者に連絡してください。'

export function useTenkoKiosk(options?: { remoteMode?: boolean }) {
  /**
   * 最初から遠隔点呼として始めたか。**setup の 1 回だけで決まる定数**で、
   * 途中では変わらない。段の一覧 (`stepLabels` / `stepKeys`) はこの値だけを見るので、
   * 遠隔へ切り替えても**段の数が変わらず現在地がずれない**。
   */
  const remoteMode = options?.remoteMode ?? false
  /**
   * 自動点呼の途中から遠隔点呼へ昇格したか (Refs ippoan/alc-app-s3#135)。
   * `remoteMode` とは**混ぜない** — 混ぜると段の一覧が途中で変わる。
   */
  const escalatedToRemote = ref(false)
  /** 切り替えた理由 (未切り替えは null)。画面の文言とサーバへの通知の両方が見る */
  const escalationReason = ref<TenkoRemoteEscalationReason | null>(null)
  /**
   * いま遠隔か。最初から遠隔 / 途中で昇格 のどちらでも true。
   * **画面の「遠隔かどうか」の判定はすべてこれ 1 つを見る。**
   */
  const isRemote = computed(() => remoteMode || escalatedToRemote.value)
  /**
   * サーバが `devices.bp_enabled` を引くための端末識別子 (Refs ippoan/alc-app#322)。
   * CoreS3 端末では `devices` に行が無いので**構造的に常に空**。
   */
  const { deviceId } = useAuth()
  /** 署名つきで auth-worker へ渡したボンド状態 (#336)。null = 不明 */
  const { signedBpBonded, refreshSignedBpBonded } = useDeviceToken()
  /** この端末で血圧を出せる見込みがあるか (BleStatus の `showBpUi` と同じ 2 つ、#336) */
  const { bpEnabled } = useBloodPressureSetting()
  const { hasBpHardware } = useBleGateway()
  const step = ref<TenkoStep>('nfc')
  const employeeId = ref('')
  const employeeName = ref('')
  const pendingSchedules = ref<TenkoSchedule[]>([])
  const selectedSchedule = ref<TenkoSchedule | null>(null)
  /** 画面で選んだ点呼種別 (遠隔点呼で使う)。未選択は null で、既定 (業務前) に委ねる */
  const selectedTenkoType = ref<TenkoType | null>(null)
  const session = ref<TenkoSession | null>(null)
  const carryingItems = ref<CarryingItem[]>([])
  const error = ref<string | null>(null)
  const isLoading = ref(false)

  // 顔認証結果
  const faceSnapshot = ref<Blob | null>(null)
  /**
   * 顔が未登録でスキップした本人確認か (Refs ippoan/alc-app-s3#135)。
   * いまサーバへ送るのは「顔写真なし」= `identity_face_photo_url` が無いことだけ。
   * サーバ側にスキップを表す欄が入る次の PR で、ここを送信本体へ繋ぐ。
   */
  const faceSkipped = ref(false)
  const facePhotoUrl = ref<string | null>(null)

  // 安全判定結果
  const safetyJudgment = ref<SafetyJudgment | null>(null)

  // --- 現在の点呼タイプ ---
  const tenkoType = computed<TenkoType | null>(() =>
    session.value?.tenko_type
      ?? selectedTenkoType.value
      ?? selectedSchedule.value?.tenko_type
      ?? (remoteMode ? 'pre_operation' : null),
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

    // 遠隔点呼: 予定選択の UI は出さないが、予定があれば種別 (業務前/業務後) を
    // 自動で引き継ぐ (Refs: 遠隔点呼が常に業務前固定になっていたバグ修正)。
    // 予定が取れない/無い場合は selectedSchedule なしのまま続行し、
    // onFaceAuthComplete が業務前として開始する (従来のフォールバック)。
    // 本番では予定を持つ社員が 0 件のためこの照会は常に空を返すだけだが、
    // 将来 予定を使う運用になれば自動で効くのでそのまま残す (Refs #310)。
    if (remoteMode) {
      try {
        const schedules = await getPendingSchedules(empId)
        pendingSchedules.value = schedules
        selectedSchedule.value = schedules[0] ?? null
      } catch {
        selectedSchedule.value = null
      }
      step.value = 'face_auth'
      return
    }

    isLoading.value = true
    try {
      const schedules = await getPendingSchedules(empId)
      pendingSchedules.value = schedules
      // 予定が 0 件でもエラーで止めず schedule_select へ進む。業務前は予定必須のまま
      // (指示事項が予定に載る) だが、業務後は予定が無くても進められる (Refs
      // ippoan/alc-app#322、法令上「設定することができる」= 任意)。画面が
      // 「予定なしで業務後として進む」導線を出す
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

  // --- 予定を選ばず業務後として進む (Refs ippoan/alc-app#322) ---
  // 業務前のセッションには絶対にならない — selectedTenkoType を必ず post_operation に
  // 固定するため。業務前は下の onFaceAuthComplete のガードで引き続き予定必須
  function proceedWithoutSchedule() {
    error.value = null
    selectedTenkoType.value = 'post_operation'
    step.value = 'face_auth'
  }

  /**
   * 業務前の自動点呼で、血圧の要否が確定できないか (Refs ippoan/alc-app#336)。
   *
   * サーバは「不明」を安全側 (血圧必須) に倒すので、このまま進めると体温を送った
   * 時点で必ず 400 (`bp_required`) になる。**体温を測る意味が無いのに測らせない。**
   *
   * - **遠隔点呼・業務後は対象外** — 既定を今までどおりに保つ (止めるのは業務前の自動点呼だけ)
   * - **`signedBpBonded === false` は通す** — 血圧計が無いと**確認できた**端末を
   *   締め出さない (混ぜると #322 で踏んだ形になる)
   * - **`deviceId` があれば止めない** — サーバが `devices.bp_enabled` を引けるので
   *   行き止まりにならない
   * - **血圧を出せる見込みがある端末は止めない** — 「不明」は「血圧必須」であって
   *   「進めない」ではない。血圧を測れる端末は測って通れるので行き止まりではなく、
   *   ここで締め出すと**古いファーム + 血圧計**の端末が今日できていることを失う。
   *   条件は `BleStatus.vue` の `showBpUi` (= 血圧の入力欄が出るか) と同じ 2 つ —
   *   **入力欄すら出ないまま血圧必須になる端末だけ**が行き止まり (issue の症状そのもの)。
   *   測れるはずが測れなかったときは、体温・血圧の段の「遠隔点呼へ切り替え」が受け皿になる。
   */
  function isBpRequirementUnknown(): boolean {
    if (remoteMode || tenkoType.value === 'post_operation') return false
    if (deviceId.value) return false
    if (signedBpBonded.value !== null) return false
    return !bpEnabled.value && !hasBpHardware.value
  }

  /**
   * 入口で止めたときの顔認証結果。「もう一度試す」で**続きから**再開するために持つ
   * (非 null = いま入口で止まっている)。
   */
  const blockedFaceAuthResult = ref<FaceAuthResult | null>(null)
  /** 血圧の要否が確定できず、業務前の自動点呼を入口で止めているか (#336) */
  const bpRequirementUnknown = computed(() => blockedFaceAuthResult.value !== null)

  /**
   * ボンド状態を取り直して、確定したら止めた所から再開する (#336)。
   * 「不明」は一時的なこともある (CoreS3 がその瞬間つながっていなかった等) ので、
   * **リロードなしで復帰できる導線**を必ず残す。取り直しても不明なら同じ画面に戻るだけ。
   */
  async function retryBpRequirement() {
    const pending = blockedFaceAuthResult.value
    if (!pending) return
    error.value = null
    isLoading.value = true
    try {
      await refreshSignedBpBonded()
    } finally {
      isLoading.value = false
    }
    await onFaceAuthComplete(pending)
  }

  // --- 顔認証完了 → セッション開始 + アルコール測定 ---
  async function onFaceAuthComplete(result: FaceAuthResult) {
    if (!result.verified) return
    // 業務後は予定が無くても進められる (selectedTenkoType='post_operation' が
    // proceedWithoutSchedule でセットされる)。業務前は引き続き予定必須
    if (!remoteMode && !selectedSchedule.value && tenkoType.value !== 'post_operation') return
    // 血圧の要否が確定できない端末は、体温・血圧まで歩かせずここで止める (#336)。
    // 無言では止めない — 理由と次の行動 (もう一度試す) を必ず出す
    if (isBpRequirementUnknown()) {
      blockedFaceAuthResult.value = result
      error.value = BP_REQUIREMENT_UNKNOWN_MESSAGE
      return
    }
    blockedFaceAuthResult.value = null
    error.value = null
    isLoading.value = true

    faceSnapshot.value = result.snapshot ?? null
    faceSkipped.value = result.skipped === true

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
        : { tenko_type: selectedTenkoType.value ?? 'pre_operation', employee_id: employeeId.value, identity_face_photo_url: photoUrl }
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
      // 端末の血圧計有無 (devices.bp_enabled) をサーバが判定するための端末識別子。
      // bp_enabled 自体は送らない (フェイルクローズ設計、Refs ippoan/alc-app#322)
      const body: SubmitMedicalData = deviceId.value ? { ...data, device_id: deviceId.value } : data
      const s = await submitMedical(session.value.id, body)
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

  // --- 遠隔点呼への切り替え (血圧が測れないとき。Refs ippoan/alc-app-s3#135) ---
  /**
   * 同じセッションのまま遠隔へ移す。**新しいセッションは起こさない** (点呼が二重になる)。
   *
   * `reason` は `TENKO_REMOTE_ESCALATION_REASONS` から画面で選ばせた語。サーバは必須で受ける。
   *
   * **画面の状態を先に遠隔へ移してから**サーバへ知らせる。握り潰すのは**通信の失敗だけ**で、
   * 「サーバが応えなかったから切り替わらない」は起こさない — 現場でそれが一番困る。
   */
  async function escalateToRemote(reason: TenkoRemoteEscalationReason) {
    if (isRemote.value) return
    escalatedToRemote.value = true
    escalationReason.value = reason
    if (!session.value) return
    try {
      session.value = await escalateTenkoSessionToRemote(session.value.id, reason)
    } catch {
      // サーバ側の口は別 PR。無くても遠隔の画面には入れる (ここで止めない)
    }
  }

  // --- リセット ---
  function reset() {
    step.value = 'nfc'
    employeeId.value = ''
    employeeName.value = ''
    pendingSchedules.value = []
    selectedSchedule.value = null
    selectedTenkoType.value = null
    session.value = null
    error.value = null
    isLoading.value = false
    faceSnapshot.value = null
    facePhotoUrl.value = null
    faceSkipped.value = false
    safetyJudgment.value = null
    escalatedToRemote.value = false
    escalationReason.value = null
    blockedFaceAuthResult.value = null
  }

  return {
    // State
    step,
    employeeId,
    employeeName,
    pendingSchedules,
    selectedSchedule,
    selectedTenkoType,
    session,
    error,
    isLoading,
    faceSnapshot,
    faceSkipped,
    safetyJudgment,
    tenkoType,
    isPreOperation,
    escalatedToRemote,
    escalationReason,
    isRemote,
    bpRequirementUnknown,

    // Step indicator
    stepLabels,
    stepKeys,
    currentStepIndex,

    // Actions
    identifyEmployee,
    selectSchedule,
    proceedWithoutSchedule,
    onFaceAuthComplete,
    retryBpRequirement,
    onAlcoholResult,
    onMedicalSubmit,
    onSelfDeclarationSubmit,
    onDailyInspectionSubmit,
    carryingItems,
    loadCarryingItems,
    onCarryingItemsSubmit,
    onInstructionConfirm,
    onReportSubmit,
    escalateToRemote,
    cancel,
    reset,
  }
}
