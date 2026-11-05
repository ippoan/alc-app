import type {
  TenkoSchedule, TenkoSession, TenkoSessionStatus, TenkoType,
  FaceAuthResult, SubmitMedicalData,
  SubmitSelfDeclaration, SubmitDailyInspection, SubmitOperationReport,
  StartTenkoSession, SafetyJudgment, CarryingItem, CarryingItemCheckInput,
  TenkoRemoteEscalationReason, UpdateTenkoSessionVehicle,
} from '~/types'
import {
  getPendingSchedules, startTenkoSession,
  updateMeasurement, submitMedical, submitSelfDeclaration,
  submitDailyInspection, confirmInstruction, submitReport,
  cancelTenkoSession, uploadFacePhoto, escalateTenkoSessionToRemote,
  getCarryingItems, submitCarryingItemChecks, listTenkoSessions,
  selfResumeTenkoSession, updateTenkoSessionVehicle, apiErrorCode, apiErrorMessage,
} from '~/utils/api'
import { reportApiFailure } from '~/utils/equipment-failure-report'
import type { KioskFailureType } from '~/utils/equipment-failure-report'
import { currentLocation } from '~/composables/useGpsFix'

/** UI ステップ (バックエンド status とは別) */
export type TenkoStep =
  | 'nfc'
  | 'schedule_select'
  | 'face_auth'
  | 'vehicle'
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

/**
 * 「続きから再開」をサーバに残すときの `resume_reason` (Refs ippoan/alc-app#351)。
 *
 * **固定文字列を必ず入れる。** キオスクは device token で通る = `AuthUser` が無いので
 * `resumed_by_user_id` は NULL のままになる。あの列は「どの管理者が再開を承認したか」で
 * あって、自己再開に管理者は居ない — 空のままだと後から「なぜ NULL か」が読めないので、
 * 理由の側に「管理者ではなくキオスクが自分で再開した」と書き残す。
 *
 * **本人確認は指静脈** (業務前 十三): 再開は指静脈で本人と分かってからしか self-resume を呼ばない。
 * 書いてあることと実際の確認方法が食い違わないようにする。
 */
export const KIOSK_SELF_RESUME_REASON = 'キオスク自己再開 (指静脈で本人確認済)'

/**
 * 体温・血圧の測定から有効時間を過ぎ、サーバーが `medical_pending` へ戻したときの案内
 * (業務前 八)。測り直しの段へ着いたときに出す。
 */
export const MEDICAL_EXPIRED_MESSAGE
  = '体温・血圧の測定から有効時間を過ぎました。もう一度測定してください'

/**
 * 終わっている (completed / cancelled) か管理者が中断した点呼を再開しようとしたときの文言
 * (Refs ippoan/alc-app#351、サーバの 400 `session_not_resumable`)。
 *
 * 一覧を引いた後に別の端末で閉じられた、といった行き違いで起きる。こちらも押し直しでは
 * 通らないので、**理由 (もう終わっている) と次の行動を必ず並べる**。
 */
export const SESSION_NOT_RESUMABLE_MESSAGE
  = 'この点呼は再開できません (すでに終了または中断されています)。新しく点呼をやり直してください'

/**
 * 「続きから再開」の対象にする status (Refs ippoan/alc-app#343)。
 *
 * **`alcohol_tested_at IS NULL` と同値。** アルコールの段は `identity_verified` の
 * ときしか進まない (alc-measurements-worker の `tenko/alcohol.rs`) ので、アルコールを
 * まだ測っていない状態はこの 5 つで尽きる。
 *
 * 入れないもの:
 * - **`interrupted`** — 管理者が中断したものの再開は `AuthUser` 必須の `resume` API の
 *   領分で、キオスクの鍵 (`auth-worker` の `KIOSK_ROUTES`) では通らない。管理者が再開した
 *   後の点呼は `self_declaration_pending` / `daily_inspection_pending` になる (上の 5 つに
 *   含まれる) ので、**管理者が再開済み (`resumed_at` あり) でも候補に出す** — キオスクの
 *   self-resume はそれを受ける (再開の時刻・理由は上書きしない)。
 * - **`completed` / `cancelled` / `judgment_pending`** — 終わっている (判定待ちは運行管理者が閉じる)。
 * - **`instruction_pending` / `report_pending`** — アルコール測定済み。続きを埋めること
 *   自体はできるが、**何時間も前に測った値のまま点呼記録が閉じる**ので入れない
 *   (オーナー要件「途中でアルコールチェック検知とかなければ再利用できるように」)。
 */
export const RESUMABLE_TENKO_STATUSES: readonly TenkoSessionStatus[] = [
  'identity_verified',
  'medical_pending',
  'self_declaration_pending',
  'daily_inspection_pending',
  'carrying_items_pending',
]

export function useTenkoKiosk(options?: { remoteMode?: boolean, allowResume?: boolean }) {
  /**
   * 最初から遠隔点呼として始めたか。**setup の 1 回だけで決まる定数**で、
   * 途中では変わらない。段の一覧 (`stepLabels` / `stepKeys`) はこの値だけを見るので、
   * 遠隔へ切り替えても**段の数が変わらず現在地がずれない**。
   */
  const remoteMode = options?.remoteMode ?? false
  /**
   * 本人特定のときに未完了セッションも引くか (Refs ippoan/alc-app#343)。
   * **既定は `false` = 今までどおり** — この composable は通常点呼・遠隔点呼と共有なので、
   * 新しい導線を足す側 (`TenkoKiosk.vue`) が明示的に有効化する
   * (`BleStatus.vue` の `showBpUi` を `TenkoKiosk.vue` だけが切るのと同じ流儀)。
   */
  const allowResume = options?.allowResume ?? false
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
  /**
   * 署名つきで auth-worker へ渡したボンド状態 (#336)。null = 不明。
   * **読む先は機種に依らない 1 か所** (`useSignedBpBond`、Refs ippoan/alc-app#353) —
   * CoreS3 キオスクも血圧測定台の ATOM S3 も、同じ値へ書き込む。
   * 取り直し (`refreshSignedBpBonded`) は CoreS3 の再探索そのものなので `useDeviceToken` 側。
   */
  const { signedBpBonded, hasProbedBpBond } = useSignedBpBond()
  const { refreshSignedBpBonded } = useDeviceToken()
  /**
   * この端末で血圧を出せる見込みがあるか。**入口ガード専用の 2 材料**で、
   * `BleStatus` の表示判定 (`useBpUiEnabled`) とは**意図的に別**
   * (Refs ippoan/alc-app#347)。表示側は `signedBpBonded` も足して 3 材料で判定するが、
   * ここは `signedBpBonded` を**その上の行で先に見て**いる (`!== null` なら通す) ため、
   * 同じ値を混ぜると `signedBpBonded === null` 以外に到達しない条件になり、
   * fail-closed のゲートが意味を失う。表示用の値とゲート用の判定は混ぜない。
   */
  const { bpEnabled } = useBloodPressureSetting()
  const { hasBpHardware } = useBleGateway()
  const step = ref<TenkoStep>('nfc')
  const employeeId = ref('')
  const employeeName = ref('')
  const pendingSchedules = ref<TenkoSchedule[]>([])
  /**
   * 途中で止まったまま残っている、アルコール未測定のセッション (Refs ippoan/alc-app#343)。
   * `allowResume` が false のあいだは**常に空**。
   */
  const resumableSessions = ref<TenkoSession[]>([])
  /**
   * 指静脈で本人確認が済むのを待っている「続きから再開」(業務前 十三)。
   * 非 null のあいだ `face_auth` の段に居て、本人確認が通ると `onFaceAuthComplete` が
   * 新しいセッションを起こさずにこのセッションを self-resume する。
   */
  const pendingResume = ref<TenkoSession | null>(null)
  /** 車両番号の段の入力欄の値 (予定・セッションの車両番号が初期値)。読み込み中の表示替えで消えないよう composable が持つ */
  const vehicleInput = ref('')
  /** 車検証で登録できなかった (一致しなかった) ので、車両番号の入力が要る */
  const vehicleManualRequired = ref(false)
  /** 体温・血圧が有効時間切れで戻された点呼。測り直しの段に着いたときに案内を出す */
  const medicalSentBack = ref(false)
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
  // stepLabels と stepKeys は同じ並び・同じ長さ (ずれると今の段と違う段が光る。2026-11-02 に「携行品」が抜けていた)
  const stepLabels = computed(() => {
    const scheduleLabel = remoteMode ? [] : ['予定選択']
    // 車両番号の段は自動点呼だけ (遠隔点呼は運行管理者が通話の中で確かめる)
    const vehicleLabel = remoteMode ? [] : ['車両番号']
    if (isPreOperation.value) {
      return ['NFC', ...scheduleLabel, '本人確認', ...vehicleLabel, '体温・血圧', '自己申告', '日常点検', '携行品', 'アルコール', '指示確認', '完了']
    }
    return ['NFC', ...scheduleLabel, '本人確認', ...vehicleLabel, 'アルコール', '指示確認', '運行報告', '完了']
  })
  const stepKeys = computed<TenkoStep[]>(() => {
    const scheduleKey: TenkoStep[] = remoteMode ? [] : ['schedule_select']
    const vehicleKey: TenkoStep[] = remoteMode ? [] : ['vehicle']
    if (isPreOperation.value) {
      return ['nfc', ...scheduleKey, 'face_auth', ...vehicleKey, 'medical', 'self_declaration', 'daily_inspection', 'carrying_items', 'alcohol', 'instruction', 'completed']
    }
    return ['nfc', ...scheduleKey, 'face_auth', ...vehicleKey, 'alcohol', 'instruction', 'report', 'completed']
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
    resumableSessions.value = []
    try {
      // 未完了セッションの照会は予定の取得と**同時に**投げる (待ち時間は 1 往復ぶんのまま)。
      // `_fetchResumableSessions` は決して reject しない — 再開は「あれば出る」付加機能で、
      // 照会が落ちたくらいで本人特定そのものを止めない (Refs ippoan/alc-app#343)
      const resumable = allowResume
        ? _fetchResumableSessions(empId)
        : Promise.resolve<TenkoSession[]>([])
      const schedules = await getPendingSchedules(empId)
      pendingSchedules.value = schedules
      resumableSessions.value = await resumable
      // 予定が 0 件でもエラーで止めず schedule_select へ進む。業務前は予定必須のまま
      // (指示事項が予定に載る) だが、業務後は予定が無くても進められる (Refs
      // ippoan/alc-app#322、法令上「設定することができる」= 任意)。画面が
      // 「予定なしで業務後として進む」導線を出す
      step.value = 'schedule_select'
    } catch (e) {
      _fail(e, '予定取得に失敗しました', '予定の取得')
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 途中で止まったままのセッションを引く (Refs ippoan/alc-app#343)。
   *
   * **status ごとに 1 本ずつ投げて並列で待つ。** `TenkoSessionFilter.status` は
   * **単一値一致しか無い**ので「未完了をまとめて 1 回」は引けず、かといって
   * フィルタ無しで引くと 1 ページ (既定 50 件) がその乗務員の過去の完了セッションで
   * 埋まって、拾いたい数本が落ちる。**件数より取りこぼさない方を取る** —
   * 5 本を並列で投げるので、増えるのは往復の本数だけで待ち時間は変わらない。
   *
   * **1 本でも落ちたら、取れた分だけ返す。** 決して reject しない。
   */
  async function _fetchResumableSessions(empId: string): Promise<TenkoSession[]> {
    const results = await Promise.allSettled(
      RESUMABLE_TENKO_STATUSES.map(status => listTenkoSessions({ employee_id: empId, status })),
    )
    const found: TenkoSession[] = []
    for (const r of results) {
      if (r.status === 'fulfilled') found.push(...r.value.sessions)
    }
    // status は上の 5 つに絞ってあるが、**オーナー要件そのもの (アルコール未測定) を
    // ここでも直接確かめる** — 判定を別 repo の不変条件だけに預けない。
    // `resumed_at` では落とさない — self-resume は管理者が再開済みの点呼も受ける
    // (再開の時刻・理由は上書きしない)。管理者が再開した点呼こそ、キオスクで続きを実施する対象
    return found
      .filter(s => s.alcohol_tested_at === null)
      .sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''))
  }

  /**
   * 拾った未完了セッションを続きから再開する (Refs ippoan/alc-app#343、業務前 十三)。
   *
   * **新しいセッションは起こさないし、新しいスイッチも書かない。** ここでは再開を
   * 「指静脈の本人確認待ち」に置くだけ (`pendingResume` + `face_auth` の段)。
   * 本人確認が通ると `onFaceAuthComplete` が self-resume を呼び、返ってきた status で
   * 既存の `_advanceByStatus` に渡す。**指静脈で本人と分かる前に、サーバーへは何も言わない。**
   *
   * **#336 の入口ガードを必ず通す。** 血圧の要否が確定できない端末で業務前を再開すると、
   * 体温を送った時点で必ず 400 (`bp_required`) になり行き止まりへ入る — 再開の経路が
   * そこを迂回しないように、`onFaceAuthComplete` と同じ判定を同じ文言で掛ける。
   */
  async function resumeSession(s: TenkoSession) {
    error.value = null
    // 指示事項と運行管理者名は予定側にしか無い。まだ未実施予定として残っていれば拾う
    // (消費済みなら取れないので、指示は出ないまま続きへ進む)
    selectedSchedule.value = pendingSchedules.value.find(p => p.id === s.schedule_id) ?? null
    // ガードが見る `tenkoType` はこのセッションの種別なので、判定より前に載せ替える
    session.value = s
    isLoading.value = true
    try {
      if (await isBpRequirementUnknown()) {
        blockedResumeSession.value = s
        error.value = BP_REQUIREMENT_UNKNOWN_MESSAGE
        return
      }
      blockedResumeSession.value = null
      pendingResume.value = s
      step.value = 'face_auth'
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 指静脈で本人確認が通ったあと、再開の事実と時刻をサーバーへ残して続きへ進む
   * (Refs ippoan/alc-app#351)。
   *
   * 返ってきた status で進める (`_enterAfterStart`) — 体温・血圧が有効時間切れなら
   * サーバーが `medical_pending` へ戻しているので、測り直しの段へ入る。
   *
   * **無言では止めない** — 失敗の種類ごとに、理由と次の行動を必ず画面に出す:
   *
   * - `session_not_resumable` — **押し直しても永久に通らない**ので、
   *   文言を出して `reset()` で最初の画面 (乗務員 ID) へ戻す。新しい点呼としてやり直す
   * - それ以外 (通信断・上流の不調など) — 本人確認の段に留めて**もう一度指を置かせる**
   *   (`pendingResume` は残す)。ここで黙って続きへ通すと、直そうとしている #351 の症状
   *   (実施時刻がどこにも残らない点呼) をそのまま作ってしまう
   */
  async function _finishResume(s: TenkoSession) {
    error.value = null
    isLoading.value = true
    try {
      const resumed = await selfResumeTenkoSession(s.id, { reason: KIOSK_SELF_RESUME_REASON })
      pendingResume.value = null
      medicalSentBack.value = _sentBackToMedical(s.status, resumed)
      _enterAfterStart(resumed, true)
    } catch (e) {
      if (apiErrorCode(e) === 'session_not_resumable') {
        // reset() が error も畳むので、文言は**戻した後**に載せる
        reset()
        error.value = SESSION_NOT_RESUMABLE_MESSAGE
        return
      }
      _fail(e, '点呼の再開に失敗しました', '点呼の再開')
    } finally {
      isLoading.value = false
    }
  }

  /** 前の status が体温・血圧の段より先なのに、サーバーが `medical_pending` へ戻したか (測定の有効時間切れ) */
  function _sentBackToMedical(prev: string, next: TenkoSession): boolean {
    return next.status === 'medical_pending' && prev !== 'medical_pending'
  }

  /**
   * 失敗を画面に出し、機器・保存・通信の失敗なら故障として記録する。
   * 4xx (入力の不備など) は記録されない (`reportApiFailure` が除く)。
   * `type` は何が失敗したか分かっている場面 (測定の記録など) だけ渡す。
   */
  function _fail(e: unknown, fallback: string, what: string, type?: KioskFailureType) {
    error.value = e instanceof Error ? e.message : fallback
    reportApiFailure(e, what, { sessionId: session.value?.id, type })
  }

  /**
   * 開始・再開の直後の行き先を決める。**車両番号の段 (業務前 二十 ハ) を先に挟む**:
   * 自動点呼だけ。車検証から取れた車両番号 (`carins`) があれば飛ばす。再開では、車両番号が
   * まだ無い点呼だけ通す (予定や手入力で入っていれば、前に確認済み)。
   * 段を終えたら `onVehicleSubmit` が同じ status で `_advanceByStatus` へ渡す。
   */
  function _enterAfterStart(s: TenkoSession, resumed: boolean) {
    session.value = s
    const needsVehicle = !remoteMode
      && s.vehicle_number_source !== 'carins'
      && (!resumed || !s.vehicle_number)
    if (!needsVehicle) {
      _advanceByStatus(s.status)
      return
    }
    vehicleInput.value = s.vehicle_number ?? selectedSchedule.value?.vehicle_number ?? ''
    vehicleManualRequired.value = false
    step.value = 'vehicle'
  }

  /**
   * 車両番号を登録して次の段へ進む (業務前 二十 ハ)。車検証の管理番号か、入力した車両番号を渡す。
   * 車検証が見つからない (`vehicle_required`) ときは文言を出して入力欄を開かせる。
   */
  async function onVehicleSubmit(data: UpdateTenkoSessionVehicle) {
    if (!session.value) return
    error.value = null
    isLoading.value = true
    try {
      const s = await updateTenkoSessionVehicle(session.value.id, data)
      session.value = s
      vehicleManualRequired.value = false
      _advanceByStatus(s.status)
    } catch (e) {
      if (apiErrorCode(e) === 'vehicle_required') {
        vehicleManualRequired.value = true
        error.value = apiErrorMessage(e) ?? '車両番号を入力してください'
      } else {
        _fail(e, '車両番号の登録に失敗しました', '車両番号の登録')
      }
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
   *   条件は `bpEnabled` / `hasBpHardware` の 2 つ — **入力欄すら出ないまま血圧必須に
   *   なる端末だけ**が行き止まり (issue の症状そのもの)。測れるはずが測れなかった
   *   ときは、体温・血圧の段の「遠隔点呼へ切り替え」が受け皿になる。
   *   **表示側 (`useBpUiEnabled` の `showBpUi`) は `signedBpBonded === true` も
   *   足した 3 材料だが、ここには足さない** (Refs ippoan/alc-app#347) — 1 つ上の
   *   `signedBpBonded.value !== null` で既に通しているので、足しても判定は変わらず、
   *   表示側の都合でゲートを緩める経路を作るだけになる。据え置きは意図的。
   * - **試す前には止めない** — `signedBpBonded` の `null` には「まだ署名を試していない」
   *   (起動直後・探索中) も乗る。そこで止めると**署名を試す前に端末を締め出す**ので、
   *   まだ試していなければ**ここで 1 度試してから**判定する (`hasProbedBpBond`)。
   *   止めるのは**試した結果、ボンド状態が分からなかったとき**だけ。
   *
   * (#401: `unused` の端末は index.vue が自動点呼のタブごと塞ぐので、ここには来ない。)
   */
  async function isBpRequirementUnknown(): Promise<boolean> {
    if (remoteMode || tenkoType.value === 'post_operation') return false
    if (deviceId.value) return false
    if (signedBpBonded.value !== null) return false
    if (bpEnabled.value || hasBpHardware.value) return false
    if (!hasProbedBpBond.value) await refreshSignedBpBonded()
    return signedBpBonded.value === null
  }

  /**
   * 入口で止めたときの顔認証結果。「もう一度試す」で**続きから**再開するために持つ
   * (非 null = いま入口で止まっている)。
   */
  const blockedFaceAuthResult = ref<FaceAuthResult | null>(null)
  /**
   * 入口で止めた「続きから再開」(Refs ippoan/alc-app#343)。顔認証と同じく、
   * 「もう一度試す」で**続きから**やり直せるように持つ。
   */
  const blockedResumeSession = ref<TenkoSession | null>(null)
  /** 血圧の要否が確定できず、業務前の自動点呼を入口で止めているか (#336) */
  const bpRequirementUnknown = computed(
    () => blockedFaceAuthResult.value !== null || blockedResumeSession.value !== null,
  )

  /**
   * ボンド状態を取り直して、確定したら止めた所から再開する (#336)。
   * 「不明」は一時的なこともある (CoreS3 がその瞬間つながっていなかった等) ので、
   * **リロードなしで復帰できる導線**を必ず残す。取り直しても不明なら同じ画面に戻るだけ。
   */
  async function retryBpRequirement() {
    const pendingResume = blockedResumeSession.value
    const pendingFace = blockedFaceAuthResult.value
    if (!pendingResume && !pendingFace) return
    error.value = null
    isLoading.value = true
    try {
      await refreshSignedBpBonded()
    } finally {
      isLoading.value = false
    }
    // 止めた経路へそのまま戻す。両方が同時に立つことはない (入口はどちらか一方)
    if (pendingResume) {
      blockedResumeSession.value = null
      await resumeSession(pendingResume)
    }
    if (pendingFace) {
      await onFaceAuthComplete(pendingFace)
    }
  }

  // --- 顔認証完了 → セッション開始 + アルコール測定 ---
  async function onFaceAuthComplete(result: FaceAuthResult) {
    if (!result.verified) return
    // 再開の本人確認 (業務前 十三): 新しいセッションは起こさず、止まっている点呼を self-resume する
    if (pendingResume.value) {
      await _finishResume(pendingResume.value)
      return
    }
    // 業務後は予定が無くても進められる (selectedTenkoType='post_operation' が
    // proceedWithoutSchedule でセットされる)。業務前は引き続き予定必須
    if (!remoteMode && !selectedSchedule.value && tenkoType.value !== 'post_operation') return
    error.value = null
    isLoading.value = true

    // 血圧の要否が確定できない端末は、体温・血圧まで歩かせずここで止める (#336)。
    // 判定は署名の取得を待つことがあるので isLoading の中で回す。
    // 無言では止めない — 理由と次の行動 (もう一度試す) を必ず出す
    if (await isBpRequirementUnknown()) {
      blockedFaceAuthResult.value = result
      error.value = BP_REQUIREMENT_UNKNOWN_MESSAGE
      isLoading.value = false
      return
    }
    blockedFaceAuthResult.value = null

    faceSnapshot.value = result.snapshot ?? null
    faceSkipped.value = result.skipped === true

    try {
      // 顔写真アップロード
      let photoUrl: string | undefined
      if (result.snapshot) {
        try {
          photoUrl = await uploadFacePhoto(result.snapshot)
        } catch (e) {
          // 写真が保存できなければ開始しない (従来どおり)。保存の失敗として記録する
          _fail(e, 'セッション開始に失敗しました', '顔写真の保存', 'photo_storage_error')
          return
        }
        facePhotoUrl.value = photoUrl
      }

      // セッション開始
      const body: StartTenkoSession = selectedSchedule.value
        ? { schedule_id: selectedSchedule.value.id, employee_id: employeeId.value, identity_face_photo_url: photoUrl }
        : { tenko_type: selectedTenkoType.value ?? 'pre_operation', employee_id: employeeId.value, identity_face_photo_url: photoUrl }
      // GPS 版の機体をつないでいれば位置を付ける (NOFIX でも止めない。Refs ippoan/alc-app#514)
      const location = currentLocation()
      if (location !== undefined) body.location = location
      const s = await startTenkoSession(body)
      _enterAfterStart(s, false)
    } catch (e) {
      _fail(e, 'セッション開始に失敗しました', '点呼の開始')
    } finally {
      isLoading.value = false
    }
  }

  // --- アルコールの段 (測定の保存で進める。Refs ippoan/rust-alc-api#680) ---
  /**
   * 測定を完了で保存し、**同じ保存で**アルコールの段を進める (`PUT /api/measurements/{id}` に
   * `tenko_session_id`)。段の結果はサーバが**測定の行の**結果・値・顔写真から決める (本文の結果を信じる
   * 旧い段の口 `PUT /tenko/sessions/{id}/alcohol` は使わない)。
   *
   * 戻り値は「測り直しが要るか」: 結果が点呼にならない (`error` など) とセッションは本人確認済みのまま
   * 返ってくるので、呼び手は新しい測定を起こして測り直させる。保存に失敗したときも `true`
   * (同じ測定は完了済みかもしれないので、測り直しは新しい測定で)。
   */
  async function onAlcoholMeasured(measurementId: string, fields: Record<string, unknown>): Promise<boolean> {
    if (!session.value) return false
    error.value = null
    isLoading.value = true

    try {
      const saved = await updateMeasurement(measurementId, { ...fields, tenko_session_id: session.value.id })
      const s = saved.tenko_session
      if (!s) {
        error.value = 'アルコール測定を点呼に載せられませんでした。もう一度測ってください'
        return true
      }
      session.value = s
      if (s.status === 'identity_verified') {
        error.value = '測定結果を点呼に使えませんでした。もう一度測ってください'
        return true
      }
      // 検知 → cancelled、業務前 → instruction_pending、業務後 → report_pending
      _advanceByStatus(s.status)
      return false
    } catch (e) {
      _fail(e, 'アルコール結果送信に失敗しました', 'アルコール測定の記録', 'measurement_recording_failed')
      return true
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
      if (apiErrorCode(e) === 'measurement_expired') {
        // 測定から有効時間を過ぎている (業務前 八)。体温・血圧の段に留まって測り直させる
        // (読み込み表示が終われば段が作り直され、前の測定値は消えている)
        error.value = apiErrorMessage(e) ?? MEDICAL_EXPIRED_MESSAGE
      } else {
        _fail(e, '医療データ送信に失敗しました', '体温・血圧の記録', 'measurement_recording_failed')
      }
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
      _fail(e, '自己申告送信に失敗しました', '自己申告の送信')
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
      _fail(e, '日常点検送信に失敗しました', '日常点検の送信')
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
      const prev = session.value.status
      const s = await submitCarryingItemChecks(session.value.id, checks)
      session.value = s
      // 携行品の後にアルコールの段へ進めるとき、体温・血圧の測定が有効時間を過ぎていると
      // サーバーが `medical_pending` へ戻す (業務前 八)。測り直しの段で理由を出す
      medicalSentBack.value = _sentBackToMedical(prev, s)
      _advanceByStatus(s.status)
    } catch (e) {
      _fail(e, '携行品チェック送信に失敗しました', '携行品チェックの送信')
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
      _fail(e, '指示確認に失敗しました', '指示確認の送信')
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
      _fail(e, '運行報告送信に失敗しました', '運行報告の送信')
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
      _fail(e, 'キャンセルに失敗しました', '点呼の中止の送信')
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
        if (medicalSentBack.value) {
          medicalSentBack.value = false
          error.value = MEDICAL_EXPIRED_MESSAGE
        }
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
      // 遠隔点呼の乗務員の側の終わり。完了の画面で「判定待ち」を出す (閉じるのは運行管理者の判定)
      case 'judgment_pending':
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
    resumableSessions.value = []
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
    blockedResumeSession.value = null
    pendingResume.value = null
    vehicleInput.value = ''
    vehicleManualRequired.value = false
    medicalSentBack.value = false
  }

  return {
    // State
    step,
    employeeId,
    employeeName,
    pendingSchedules,
    resumableSessions,
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
    pendingResume,
    vehicleInput,
    vehicleManualRequired,

    // Step indicator
    stepLabels,
    stepKeys,
    currentStepIndex,

    // Actions
    identifyEmployee,
    selectSchedule,
    resumeSession,
    proceedWithoutSchedule,
    onFaceAuthComplete,
    onVehicleSubmit,
    retryBpRequirement,
    onAlcoholMeasured,
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
