import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import type { TenkoSchedule, TenkoSession, SafetyJudgment } from '~/types'
import { FETCH_TIMEOUT_MESSAGE_WRITE } from '~/utils/fetch-timeout'

const deviceId = ref<string | null>('device-1')
mockNuxtImport('useAuth', () => () => ({ deviceId }))

// 署名つきボンド状態 (Refs ippoan/alc-app#336)。null = 不明
const signedBpBonded = ref<boolean | null>(false)
// ボンド状態を一度でも取りに行ったか。false = 「未取得」であって「不明」ではない
const hasProbedBpBond = ref(true)
const refreshSignedBpBonded = vi.fn(async () => {
  hasProbedBpBond.value = true
  return signedBpBonded.value
})
// 値の置き場所は機種に依らない 1 か所 (`useSignedBpBond`、Refs ippoan/alc-app#353)。
// 取り直しだけが CoreS3 の再探索なので `useDeviceToken` 側に残る
mockNuxtImport('useSignedBpBond', () => () => ({ signedBpBonded, hasProbedBpBond }))
mockNuxtImport('useDeviceToken', () => () => ({ refreshSignedBpBonded }))

// 血圧を出せる見込み (BleStatus の showBpUi と同じ 2 つ)。既定は「出せない端末」
const bpEnabled = ref(false)
const hasBpHardware = ref(false)
mockNuxtImport('useBloodPressureSetting', () => () => ({ bpEnabled, setBpEnabled: vi.fn() }))
mockNuxtImport('useBleGateway', () => () => ({ hasBpHardware }))

// `apiErrorCode` は**実物を使う** (Refs ippoan/alc-app#351) — 400 の body から
// コードを取り出すのは api.ts が作った文言の読み方そのものなので、ここで差し替えると
// 「文言の作り方と読み方が揃っているか」という肝心の所を素通りする。
vi.mock('~/utils/api', async () => ({
  ...(await vi.importActual<typeof import('~/utils/api')>('~/utils/api')),
  getPendingSchedules: vi.fn(),
  startTenkoSession: vi.fn(),
  submitAlcohol: vi.fn(),
  submitMedical: vi.fn(),
  submitSelfDeclaration: vi.fn(),
  submitDailyInspection: vi.fn(),
  confirmInstruction: vi.fn(),
  submitReport: vi.fn(),
  cancelTenkoSession: vi.fn(),
  escalateTenkoSessionToRemote: vi.fn(),
  uploadFacePhoto: vi.fn(),
  getCarryingItems: vi.fn(),
  submitCarryingItemChecks: vi.fn(),
  listTenkoSessions: vi.fn(),
  selfResumeTenkoSession: vi.fn(),
}))

import {
  useTenkoKiosk, BP_REQUIREMENT_UNKNOWN_MESSAGE, RESUMABLE_TENKO_STATUSES,
  KIOSK_SELF_RESUME_REASON, ALREADY_RESUMED_MESSAGE, SESSION_NOT_RESUMABLE_MESSAGE,
} from '~/composables/useTenkoKiosk'
import {
  getPendingSchedules,
  startTenkoSession,
  submitAlcohol,
  submitMedical,
  submitSelfDeclaration,
  submitDailyInspection,
  confirmInstruction,
  submitReport,
  cancelTenkoSession,
  escalateTenkoSessionToRemote,
  uploadFacePhoto,
  getCarryingItems,
  submitCarryingItemChecks,
  listTenkoSessions,
  selfResumeTenkoSession,
} from '~/utils/api'

// --- helpers ---

function makeSchedule(overrides?: Partial<TenkoSchedule>): TenkoSchedule {
  return {
    id: 'sched-1',
    tenant_id: 't-1',
    employee_id: 'emp-1',
    tenko_type: 'pre_operation',
    responsible_manager_name: '管理者',
    scheduled_at: '2026-03-31T08:00:00Z',
    instruction: null,
    consumed: false,
    consumed_by_session_id: null,
    overdue_notified_at: null,
    created_at: '2026-03-31T00:00:00Z',
    updated_at: '2026-03-31T00:00:00Z',
    ...overrides,
  }
}

function makeSession(overrides?: Partial<TenkoSession>): TenkoSession {
  return {
    id: 'sess-1',
    tenant_id: 't-1',
    employee_id: 'emp-1',
    schedule_id: 'sched-1',
    tenko_type: 'pre_operation',
    status: 'identity_verified',
    identity_verified_at: null,
    identity_face_photo_url: null,
    measurement_id: null,
    alcohol_result: null,
    alcohol_value: null,
    alcohol_tested_at: null,
    alcohol_face_photo_url: null,
    temperature: null,
    systolic: null,
    diastolic: null,
    pulse: null,
    medical_measured_at: null,
    medical_manual_input: null,
    instruction_confirmed_at: null,
    report_vehicle_road_status: null,
    report_driver_alternation: null,
    report_no_report: null,
    report_submitted_at: null,
    location: null,
    responsible_manager_name: null,
    cancel_reason: null,
    interrupted_at: null,
    resumed_at: null,
    resume_reason: null,
    resumed_by_user_id: null,
    self_declaration: null,
    safety_judgment: null,
    daily_inspection: null,
    carrying_items_checked: null,
    started_at: null,
    completed_at: null,
    created_at: '2026-03-31T00:00:00Z',
    updated_at: '2026-03-31T00:00:00Z',
    ...overrides,
  }
}

describe('useTenkoKiosk', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deviceId.value = 'device-1'
    signedBpBonded.value = false
    hasProbedBpBond.value = true
    bpEnabled.value = false
    hasBpHardware.value = false
  })

  // ---------- 初期状態 ----------

  it('初期値が正しい', () => {
    const k = useTenkoKiosk()
    expect(k.step.value).toBe('nfc')
    expect(k.employeeId.value).toBe('')
    expect(k.employeeName.value).toBe('')
    expect(k.pendingSchedules.value).toEqual([])
    expect(k.selectedSchedule.value).toBeNull()
    expect(k.selectedTenkoType.value).toBeNull()
    expect(k.session.value).toBeNull()
    expect(k.error.value).toBeNull()
    expect(k.isLoading.value).toBe(false)
    expect(k.faceSnapshot.value).toBeNull()
    expect(k.safetyJudgment.value).toBeNull()
    expect(k.tenkoType.value).toBeNull()
    expect(k.isPreOperation.value).toBe(false)
  })

  // ---------- stepLabels / stepKeys ----------

  describe('stepLabels / stepKeys', () => {
    it('pre_operation (通常モード) のステップ', () => {
      const k = useTenkoKiosk()
      // tenkoType は session / selectedSchedule / remoteMode で決まる
      // selectedSchedule を pre_operation に設定
      k.selectedSchedule.value = makeSchedule({ tenko_type: 'pre_operation' })
      expect(k.isPreOperation.value).toBe(true)
      expect(k.stepLabels.value).toContain('予定選択')
      expect(k.stepKeys.value).toContain('schedule_select')
      expect(k.stepKeys.value).toContain('medical')
      expect(k.stepKeys.value).toContain('self_declaration')
      expect(k.stepKeys.value).toContain('daily_inspection')
      expect(k.stepKeys.value).toContain('carrying_items')
      expect(k.stepKeys.value).not.toContain('report')
    })

    it('post_operation (通常モード) のステップ', () => {
      const k = useTenkoKiosk()
      k.selectedSchedule.value = makeSchedule({ tenko_type: 'post_operation' })
      expect(k.isPreOperation.value).toBe(false)
      expect(k.stepKeys.value).toContain('report')
      expect(k.stepKeys.value).not.toContain('medical')
      expect(k.stepKeys.value).not.toContain('self_declaration')
      expect(k.stepKeys.value).not.toContain('daily_inspection')
      // stepLabels もカバー (post_operation ブランチ)
      expect(k.stepLabels.value).toContain('運行報告')
      expect(k.stepLabels.value).not.toContain('日常点検')
    })

    it('remoteMode では schedule_select / 予定選択 がない', () => {
      const k = useTenkoKiosk({ remoteMode: true })
      expect(k.stepKeys.value).not.toContain('schedule_select')
      expect(k.stepLabels.value).not.toContain('予定選択')
      // remoteMode default → pre_operation
      expect(k.tenkoType.value).toBe('pre_operation')
      expect(k.isPreOperation.value).toBe(true)
    })
  })

  // ---------- currentStepIndex ----------

  describe('currentStepIndex', () => {
    it('通常ステップのインデックス', () => {
      const k = useTenkoKiosk()
      k.step.value = 'nfc'
      expect(k.currentStepIndex.value).toBe(0)
    })

    it('safety_result は self_declaration + 1', () => {
      const k = useTenkoKiosk()
      k.selectedSchedule.value = makeSchedule({ tenko_type: 'pre_operation' })
      k.step.value = 'safety_result'
      const sdIdx = k.stepKeys.value.indexOf('self_declaration')
      expect(k.currentStepIndex.value).toBe(sdIdx + 1)
    })

    it('interrupted は最後のインデックス', () => {
      const k = useTenkoKiosk()
      k.step.value = 'interrupted'
      expect(k.currentStepIndex.value).toBe(k.stepKeys.value.length - 1)
    })

    it('cancelled は最後のインデックス', () => {
      const k = useTenkoKiosk()
      k.step.value = 'cancelled'
      expect(k.currentStepIndex.value).toBe(k.stepKeys.value.length - 1)
    })

    it('未知のステップ値で idx=-1 (fall-through → -1 返却)', () => {
      const k = useTenkoKiosk()
      ;(k.step as any).value = 'unknown_step'
      expect(k.currentStepIndex.value).toBe(-1)
    })

    it('safety_result + post_operation (self_declaration not in stepKeys) → 0', () => {
      const k = useTenkoKiosk()
      k.selectedSchedule.value = makeSchedule({ tenko_type: 'post_operation' })
      k.step.value = 'safety_result'
      // post_operation stepKeys doesn't include 'self_declaration'
      // indexOf('self_declaration') returns -1, so -1 + 1 = 0
      expect(k.currentStepIndex.value).toBe(0)
    })
  })

  // ---------- identifyEmployee ----------

  describe('identifyEmployee', () => {
    it('remoteMode: 予定なし → schedule_select は出さず face_auth に直接遷移', async () => {
      vi.mocked(getPendingSchedules).mockResolvedValue([])
      const k = useTenkoKiosk({ remoteMode: true })
      await k.identifyEmployee('emp-1', '田中')
      expect(k.step.value).not.toBe('alcohol')
      expect(k.employeeId.value).toBe('emp-1')
      expect(k.employeeName.value).toBe('田中')
      expect(getPendingSchedules).toHaveBeenCalledWith('emp-1')
      expect(k.selectedSchedule.value).toBeNull()
    })

    it('remoteMode: 予定あり(業務後) → selectedSchedule に自動セットされ tenkoType に反映される', async () => {
      vi.mocked(getPendingSchedules).mockResolvedValue([makeSchedule({ tenko_type: 'post_operation' })])
      const k = useTenkoKiosk({ remoteMode: true })
      await k.identifyEmployee('emp-1', '田中')
      expect(k.step.value).not.toBe('alcohol')
      expect(k.selectedSchedule.value?.tenko_type).toBe('post_operation')
      expect(k.tenkoType.value).toBe('post_operation')
    })

    it('remoteMode: 予定取得エラーでもブロックせず face_auth へ進む', async () => {
      vi.mocked(getPendingSchedules).mockRejectedValue(new Error('network'))
      const k = useTenkoKiosk({ remoteMode: true })
      await k.identifyEmployee('emp-1', '田中')
      expect(k.step.value).not.toBe('alcohol')
      expect(k.error.value).toBeNull()
      expect(k.selectedSchedule.value).toBeNull()
    })

    it('スケジュールあり → schedule_select に遷移', async () => {
      vi.mocked(getPendingSchedules).mockResolvedValue([makeSchedule()])
      const k = useTenkoKiosk()
      await k.identifyEmployee('emp-1', '田中')
      expect(k.step.value).toBe('schedule_select')
      expect(k.pendingSchedules.value).toHaveLength(1)
      expect(k.isLoading.value).toBe(false)
    })

    it('スケジュール空 → エラーにせず schedule_select へ進む (業務後は予定なしで進められる、Refs #322)', async () => {
      vi.mocked(getPendingSchedules).mockResolvedValue([])
      const k = useTenkoKiosk()
      await k.identifyEmployee('emp-1', '田中')
      expect(k.error.value).toBeNull()
      expect(k.step.value).toBe('schedule_select')
      expect(k.pendingSchedules.value).toEqual([])
    })

    it('API エラー → error 設定', async () => {
      vi.mocked(getPendingSchedules).mockRejectedValue(new Error('network'))
      const k = useTenkoKiosk()
      await k.identifyEmployee('emp-1', '田中')
      expect(k.error.value).toBe('network')
      expect(k.isLoading.value).toBe(false)
    })

    it('API エラー (非Error) → 汎用メッセージ', async () => {
      vi.mocked(getPendingSchedules).mockRejectedValue('unknown')
      const k = useTenkoKiosk()
      await k.identifyEmployee('emp-1', '田中')
      expect(k.error.value).toBe('予定取得に失敗しました')
    })
  })

  // ---------- selectSchedule ----------

  it('selectSchedule → face_auth に遷移', async () => {
    const k = useTenkoKiosk()
    const sched = makeSchedule()
    await k.selectSchedule(sched)
    expect(k.selectedSchedule.value).toStrictEqual(sched)
    expect(k.step.value).toBe('face_auth')
    expect(k.error.value).toBeNull()
  })

  // ---------- proceedWithoutSchedule (Refs ippoan/alc-app#322) ----------
  // 業務後は法令上「設定することができる」= 任意なので、予定が無くても進められる

  describe('proceedWithoutSchedule', () => {
    it('selectedTenkoType が post_operation になり face_auth へ進む (selectedSchedule はセットしない)', () => {
      const k = useTenkoKiosk()
      k.proceedWithoutSchedule()
      expect(k.selectedTenkoType.value).toBe('post_operation')
      expect(k.selectedSchedule.value).toBeNull()
      expect(k.step.value).not.toBe('alcohol')
      expect(k.tenkoType.value).toBe('post_operation')
      expect(k.isPreOperation.value).toBe(false)
    })
  })

  // ---------- onFaceAuthComplete ----------

  describe('onFaceAuthComplete', () => {
    it('verified=false → 何もしない', async () => {
      const k = useTenkoKiosk()
      await k.onFaceAuthComplete({ verified: false, similarity: 0.3 })
      expect(startTenkoSession).not.toHaveBeenCalled()
    })

    it('通常モード: selectedSchedule なし → 何もしない (業務前は引き続き予定必須)', async () => {
      const k = useTenkoKiosk()
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })
      expect(startTenkoSession).not.toHaveBeenCalled()
    })

    it('通常モード: proceedWithoutSchedule 後 (業務後) は予定が無くてもセッションを開始する (Refs #322)', async () => {
      const sess = makeSession({ tenko_type: 'post_operation', status: 'identity_verified' })
      vi.mocked(startTenkoSession).mockResolvedValue(sess)

      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.proceedWithoutSchedule()

      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })

      expect(startTenkoSession).toHaveBeenCalledWith({
        tenko_type: 'post_operation',
        employee_id: 'emp-1',
        identity_face_photo_url: undefined,
      })
      expect(k.step.value).toBe('alcohol')
    })

    it('スケジュール選択後: セッション開始 + status による遷移', async () => {
      const sess = makeSession({ status: 'medical_pending' })
      vi.mocked(startTenkoSession).mockResolvedValue(sess)
      vi.mocked(uploadFacePhoto).mockResolvedValue('https://photo.url')

      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()

      const blob = new Blob(['img'])
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9, snapshot: blob })

      expect(uploadFacePhoto).toHaveBeenCalledWith(blob)
      expect(startTenkoSession).toHaveBeenCalledWith({
        schedule_id: 'sched-1',
        employee_id: 'emp-1',
        identity_face_photo_url: 'https://photo.url',
      })
      expect(k.session.value).toStrictEqual(sess)
      expect(k.step.value).toBe('medical')
      expect(k.isLoading.value).toBe(false)
    })

    it('remoteMode: schedule なしで tenko_type 指定', async () => {
      const sess = makeSession({ status: 'medical_pending' })
      vi.mocked(startTenkoSession).mockResolvedValue(sess)

      const k = useTenkoKiosk({ remoteMode: true })
      k.employeeId.value = 'emp-1'

      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })

      expect(startTenkoSession).toHaveBeenCalledWith({
        tenko_type: 'pre_operation',
        employee_id: 'emp-1',
        identity_face_photo_url: undefined,
      })
    })

    it('snapshot なしでも動作', async () => {
      const sess = makeSession({ status: 'identity_verified' })
      vi.mocked(startTenkoSession).mockResolvedValue(sess)

      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()

      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })

      expect(uploadFacePhoto).not.toHaveBeenCalled()
      expect(k.step.value).toBe('alcohol')
    })

    it('API エラー → error 設定', async () => {
      vi.mocked(startTenkoSession).mockRejectedValue(new Error('start fail'))

      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()

      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })
      expect(k.error.value).toBe('start fail')
      expect(k.isLoading.value).toBe(false)
    })

    it('API エラー (非Error) → 汎用メッセージ', async () => {
      vi.mocked(startTenkoSession).mockRejectedValue('unknown')

      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()

      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })
      expect(k.error.value).toBe('セッション開始に失敗しました')
    })

    // 応答が返らない fetch は解決も拒否もしないのでスピナーが消えなかった
    // (Refs ippoan/alc-app#338)。api.ts が上限で reject するようになったので、
    // ここは既存の catch に落ちて「無言で止まらない」ことを固定する。
    it('セッション開始が timeout → 再試行を促さない文言を出して spinner を止める', async () => {
      vi.mocked(startTenkoSession).mockRejectedValue(new Error(FETCH_TIMEOUT_MESSAGE_WRITE))

      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()

      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })

      // サーバ側では点呼が始まっている可能性があるので、押し直させない
      expect(k.error.value).toBe(FETCH_TIMEOUT_MESSAGE_WRITE)
      expect(k.error.value).not.toContain('もう一度')
      expect(k.isLoading.value).toBe(false)
      expect(k.step.value).not.toBe('alcohol')
    })

    it('顔写真アップロードが timeout → 文言を出して spinner を止める', async () => {
      const blob = new Blob(['x'])
      vi.mocked(uploadFacePhoto).mockRejectedValue(new Error(FETCH_TIMEOUT_MESSAGE_WRITE))

      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()

      await k.onFaceAuthComplete({ verified: true, similarity: 0.9, snapshot: blob })

      expect(startTenkoSession).not.toHaveBeenCalled()
      expect(k.error.value).toBe(FETCH_TIMEOUT_MESSAGE_WRITE)
      expect(k.isLoading.value).toBe(false)
    })
  })

  // ---------- 血圧の要否が確定できない端末を入口で止める (Refs ippoan/alc-app#336) ----------

  describe('業務前の自動点呼: 血圧の要否が確定できない端末は入口で止める (Refs #336)', () => {
    /**
     * 「不明」の端末 = 署名でボンド状態を得られず (`signedBpBonded === null`)、
     * device_id も無い (CoreS3 端末は devices に行が無く構造的にこうなる)。
     * この端末で進むと、体温を送った時点で必ず 400 (`bp_required`) になる。
     */
    function unknownDevice() {
      deviceId.value = null
      signedBpBonded.value = null
      // 「試した結果、分からなかった」端末。「まだ試していない」とは区別する
      hasProbedBpBond.value = true
    }

    function startedSession() {
      const sess = makeSession({ status: 'identity_verified' })
      vi.mocked(startTenkoSession).mockResolvedValue(sess)
      return sess
    }

    it('★ 不明 → セッションを開始せず、理由を出して止まる (体温まで歩かせない)', async () => {
      unknownDevice()
      startedSession()

      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })

      expect(startTenkoSession).not.toHaveBeenCalled()
      expect(k.bpRequirementUnknown.value).toBe(true)
      // 無言で止めない — 理由と次の行動が出ている
      expect(k.error.value).toBe(BP_REQUIREMENT_UNKNOWN_MESSAGE)
      expect(k.isLoading.value).toBe(false)
    })

    it('★ 未ボンド (false = 血圧計が無いと確認できた) は通す — 「不明」と混ぜない (#322 の踏み方)', async () => {
      unknownDevice()
      signedBpBonded.value = false
      startedSession()

      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })

      expect(startTenkoSession).toHaveBeenCalled()
      expect(k.bpRequirementUnknown.value).toBe(false)
    })

    it('ボンドあり (true) は通す (血圧を測って進む端末)', async () => {
      unknownDevice()
      signedBpBonded.value = true
      startedSession()

      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })

      expect(startTenkoSession).toHaveBeenCalled()
    })

    it('device_id がある端末は止めない (サーバが devices.bp_enabled を引ける)', async () => {
      signedBpBonded.value = null
      deviceId.value = 'device-1'
      startedSession()

      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })

      expect(startTenkoSession).toHaveBeenCalled()
    })

    it('★ 血圧計の設定が入っている端末は止めない — 不明 (= 血圧必須) でも測って通れる', async () => {
      unknownDevice()
      bpEnabled.value = true
      startedSession()

      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })

      expect(startTenkoSession).toHaveBeenCalled()
      expect(k.bpRequirementUnknown.value).toBe(false)
    })

    it('★ 血圧計が繋がっている端末は止めない (古いファーム + 血圧計を締め出さない)', async () => {
      unknownDevice()
      hasBpHardware.value = true
      startedSession()

      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })

      expect(startTenkoSession).toHaveBeenCalled()
      expect(k.bpRequirementUnknown.value).toBe(false)
    })

    it('★ まだ署名を試していない端末は止めない — その場で 1 度取りに行ってから判定する', async () => {
      deviceId.value = null
      signedBpBonded.value = null
      hasProbedBpBond.value = false
      // 取りに行ったら「血圧計は無い」と確認できた
      refreshSignedBpBonded.mockImplementationOnce(async () => {
        hasProbedBpBond.value = true
        signedBpBonded.value = false
        return false
      })
      startedSession()

      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })

      expect(refreshSignedBpBonded).toHaveBeenCalledTimes(1)
      expect(startTenkoSession).toHaveBeenCalled()
      expect(k.bpRequirementUnknown.value).toBe(false)
    })

    it('★ 未取得のまま取りに行っても分からなければ止める (試した結果が不明なときだけ止まる)', async () => {
      deviceId.value = null
      signedBpBonded.value = null
      hasProbedBpBond.value = false
      startedSession()

      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })

      expect(refreshSignedBpBonded).toHaveBeenCalledTimes(1)
      expect(startTenkoSession).not.toHaveBeenCalled()
      expect(k.bpRequirementUnknown.value).toBe(true)
    })

    it('取得済みなら入口で取りに行かない (毎回署名しなおさない)', async () => {
      unknownDevice()

      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })

      expect(refreshSignedBpBonded).not.toHaveBeenCalled()
      expect(k.bpRequirementUnknown.value).toBe(true)
    })

    it('業務後は対象外 — 不明でも進める', async () => {
      unknownDevice()
      vi.mocked(startTenkoSession).mockResolvedValue(
        makeSession({ tenko_type: 'post_operation', status: 'identity_verified' }),
      )

      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.proceedWithoutSchedule()
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })

      expect(startTenkoSession).toHaveBeenCalled()
      expect(k.bpRequirementUnknown.value).toBe(false)
    })

    it('遠隔点呼は対象外 — 不明でも進める (自動点呼だけを止める)', async () => {
      unknownDevice()
      startedSession()

      const k = useTenkoKiosk({ remoteMode: true })
      k.employeeId.value = 'emp-1'
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })

      expect(startTenkoSession).toHaveBeenCalled()
      expect(k.bpRequirementUnknown.value).toBe(false)
    })

    it('★ もう一度試す → 取得しなおして確定したら、止めた所から再開する', async () => {
      unknownDevice()
      startedSession()

      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })
      expect(k.bpRequirementUnknown.value).toBe(true)

      // CoreS3 が繋がり直し、「この端末に血圧計は無い」と確認できた
      refreshSignedBpBonded.mockImplementationOnce(async () => {
        signedBpBonded.value = false
        return false
      })
      await k.retryBpRequirement()

      expect(refreshSignedBpBonded).toHaveBeenCalledTimes(1)
      expect(k.bpRequirementUnknown.value).toBe(false)
      expect(k.error.value).toBeNull()
      expect(startTenkoSession).toHaveBeenCalledWith({
        schedule_id: 'sched-1',
        employee_id: 'emp-1',
        identity_face_photo_url: undefined,
      })
      expect(k.step.value).toBe('alcohol')
    })

    it('★ もう一度試してもなお不明 → 同じ画面に戻るだけ (リロードなしで再試行できる)', async () => {
      unknownDevice()
      startedSession()

      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })

      await k.retryBpRequirement()

      expect(refreshSignedBpBonded).toHaveBeenCalledTimes(1)
      expect(k.bpRequirementUnknown.value).toBe(true)
      expect(k.error.value).toBe(BP_REQUIREMENT_UNKNOWN_MESSAGE)
      expect(startTenkoSession).not.toHaveBeenCalled()
      expect(k.isLoading.value).toBe(false)
    })

    it('止まっていないときの もう一度試す は何もしない', async () => {
      const k = useTenkoKiosk()
      await k.retryBpRequirement()

      expect(refreshSignedBpBonded).not.toHaveBeenCalled()
      expect(k.bpRequirementUnknown.value).toBe(false)
    })

    it('reset() で止めた状態が残らない (次の乗務員に引きずらない)', async () => {
      unknownDevice()

      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })
      expect(k.bpRequirementUnknown.value).toBe(true)

      k.reset()
      expect(k.bpRequirementUnknown.value).toBe(false)
      expect(k.error.value).toBeNull()
    })
  })

  // ---------- 遠隔点呼: 画面で選んだ点呼種別 (Refs #310) ----------
  // 本番には予定 (pending schedule) を持つ社員が 1 人もいないため #309 の
  // 「予定があれば種別を引き継ぐ」修正は一度も発火しなかった。予定に依存せず
  // 画面で選んだ種別を送る経路そのものをテストする (mock で予定を作る代替はしない)。

  describe('遠隔点呼: 画面で選んだ点呼種別 (予定 0 件のまま)', () => {
    it('(a) ★ selectedTenkoType が post_operation なら startTenkoSession に post_operation で送られる (#309 の再発防止)', async () => {
      vi.mocked(getPendingSchedules).mockResolvedValue([])
      const sess = makeSession({ tenko_type: 'post_operation', status: 'identity_verified' })
      vi.mocked(startTenkoSession).mockResolvedValue(sess)

      const k = useTenkoKiosk({ remoteMode: true })
      await k.identifyEmployee('emp-1', '田中')
      expect(k.selectedSchedule.value).toBeNull()

      k.selectedTenkoType.value = 'post_operation'
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })

      expect(startTenkoSession).toHaveBeenCalledWith({
        tenko_type: 'post_operation',
        employee_id: 'emp-1',
        identity_face_photo_url: undefined,
      })
    })

    it('(b) 何も選ばなければ従来どおり業務前が送られる', async () => {
      vi.mocked(getPendingSchedules).mockResolvedValue([])
      const sess = makeSession({ status: 'identity_verified' })
      vi.mocked(startTenkoSession).mockResolvedValue(sess)

      const k = useTenkoKiosk({ remoteMode: true })
      await k.identifyEmployee('emp-1', '田中')

      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })

      expect(startTenkoSession).toHaveBeenCalledWith({
        tenko_type: 'pre_operation',
        employee_id: 'emp-1',
        identity_face_photo_url: undefined,
      })
    })

    it('(c) 業務後を選ぶと stepKeys / stepLabels も業務後の並びになる', () => {
      const k = useTenkoKiosk({ remoteMode: true })
      k.selectedTenkoType.value = 'post_operation'
      expect(k.stepKeys.value).toEqual(['nfc', 'face_auth', 'alcohol', 'instruction', 'report', 'completed'])
      expect(k.stepLabels.value).toEqual(['NFC', '顔認証', 'アルコール', '指示確認', '運行報告', '完了'])
    })

    it('(d) 回帰: 予定がある枝は従来どおり schedule_id を送り、選んだ種別があっても tenko_type は送らない', async () => {
      const sess = makeSession({ status: 'identity_verified' })
      vi.mocked(startTenkoSession).mockResolvedValue(sess)

      const k = useTenkoKiosk({ remoteMode: true })
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule({ tenko_type: 'pre_operation' })
      k.selectedTenkoType.value = 'post_operation'

      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })

      expect(startTenkoSession).toHaveBeenCalledWith({
        schedule_id: 'sched-1',
        employee_id: 'emp-1',
        identity_face_photo_url: undefined,
      })
    })

    it('(f) ★ reset() 後は前の乗務員が選んだ種別が残らない', async () => {
      vi.mocked(getPendingSchedules).mockResolvedValue([])
      const sess1 = makeSession({ tenko_type: 'post_operation', status: 'identity_verified' })
      vi.mocked(startTenkoSession).mockResolvedValueOnce(sess1)

      const k = useTenkoKiosk({ remoteMode: true })
      await k.identifyEmployee('emp-1', '田中')
      k.selectedTenkoType.value = 'post_operation'
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })
      expect(k.selectedTenkoType.value).toBe('post_operation')

      k.reset()
      expect(k.selectedTenkoType.value).toBeNull()

      const sess2 = makeSession({ status: 'identity_verified' })
      vi.mocked(startTenkoSession).mockResolvedValueOnce(sess2)
      await k.identifyEmployee('emp-2', '鈴木')
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })

      expect(startTenkoSession).toHaveBeenLastCalledWith({
        tenko_type: 'pre_operation',
        employee_id: 'emp-2',
        identity_face_photo_url: undefined,
      })
    })
  })

  // ---------- onAlcoholResult ----------

  describe('onAlcoholResult', () => {
    it('session なし → 何もしない', async () => {
      const k = useTenkoKiosk()
      await k.onAlcoholResult('normal', 0.0)
      expect(submitAlcohol).not.toHaveBeenCalled()
    })

    it('正常 → status による遷移', async () => {
      const sess = makeSession({ status: 'instruction_pending' })
      vi.mocked(submitAlcohol).mockResolvedValue(sess)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onAlcoholResult('normal', 0.0, 'meas-1', 'https://face.url')
      expect(submitAlcohol).toHaveBeenCalledWith('sess-1', {
        measurement_id: 'meas-1',
        alcohol_result: 'normal',
        alcohol_value: 0.0,
        alcohol_face_photo_url: 'https://face.url',
      })
      expect(k.step.value).toBe('instruction')
      expect(k.isLoading.value).toBe(false)
    })

    it('アルコール検知 → cancelled', async () => {
      const sess = makeSession({ status: 'cancelled' })
      vi.mocked(submitAlcohol).mockResolvedValue(sess)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onAlcoholResult('over', 0.15)
      expect(k.step.value).toBe('cancelled')
    })

    it('API エラー', async () => {
      vi.mocked(submitAlcohol).mockRejectedValue(new Error('alc fail'))

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onAlcoholResult('normal', 0.0)
      expect(k.error.value).toBe('alc fail')
    })

    it('API エラー (非Error)', async () => {
      vi.mocked(submitAlcohol).mockRejectedValue(42)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onAlcoholResult('normal', 0.0)
      expect(k.error.value).toBe('アルコール結果送信に失敗しました')
    })
  })

  // ---------- onMedicalSubmit ----------

  describe('onMedicalSubmit', () => {
    it('session なし → 何もしない', async () => {
      const k = useTenkoKiosk()
      await k.onMedicalSubmit({ temperature: 36.5 })
      expect(submitMedical).not.toHaveBeenCalled()
    })

    it('正常送信 → status 遷移', async () => {
      const sess = makeSession({ status: 'self_declaration_pending' })
      vi.mocked(submitMedical).mockResolvedValue(sess)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onMedicalSubmit({ temperature: 36.5 })
      expect(k.step.value).toBe('self_declaration')
      expect(k.isLoading.value).toBe(false)
    })

    it('device_id が取れる端末 → device_id を付けて送信 (Refs ippoan/alc-app#322)', async () => {
      const sess = makeSession({ status: 'self_declaration_pending' })
      vi.mocked(submitMedical).mockResolvedValue(sess)
      deviceId.value = 'device-1'

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onMedicalSubmit({ temperature: 36.5 })
      expect(submitMedical).toHaveBeenCalledWith('sess-1', { temperature: 36.5, device_id: 'device-1' })
    })

    it('device_id が取れない端末 → device_id を付けずに送信 (サーバはフェイルクローズ)', async () => {
      const sess = makeSession({ status: 'self_declaration_pending' })
      vi.mocked(submitMedical).mockResolvedValue(sess)
      deviceId.value = null

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onMedicalSubmit({ temperature: 36.5 })
      expect(submitMedical).toHaveBeenCalledWith('sess-1', { temperature: 36.5 })
    })

    it('API エラー', async () => {
      vi.mocked(submitMedical).mockRejectedValue(new Error('med fail'))

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onMedicalSubmit({ temperature: 36.5 })
      expect(k.error.value).toBe('med fail')
    })

    it('API エラー (非Error)', async () => {
      vi.mocked(submitMedical).mockRejectedValue(null)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onMedicalSubmit({ temperature: 36.5 })
      expect(k.error.value).toBe('医療データ送信に失敗しました')
    })
  })

  // ---------- onSelfDeclarationSubmit ----------

  describe('onSelfDeclarationSubmit', () => {
    const declData = { illness: false, fatigue: false, sleep_deprivation: false }

    it('session なし → 何もしない', async () => {
      const k = useTenkoKiosk()
      await k.onSelfDeclarationSubmit(declData)
      expect(submitSelfDeclaration).not.toHaveBeenCalled()
    })

    it('safety_judgment あり → safetyJudgment 設定', async () => {
      const sj: SafetyJudgment = { status: 'pass', failed_items: [], judged_at: '2026-03-31T00:00:00Z', medical_diffs: null }
      const sess = makeSession({ status: 'daily_inspection_pending', safety_judgment: sj })
      vi.mocked(submitSelfDeclaration).mockResolvedValue(sess)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onSelfDeclarationSubmit(declData)
      expect(k.safetyJudgment.value).toStrictEqual(sj)
      expect(k.step.value).toBe('daily_inspection')
    })

    it('safety_judgment なし → safetyJudgment 未設定', async () => {
      const sess = makeSession({ status: 'daily_inspection_pending', safety_judgment: null })
      vi.mocked(submitSelfDeclaration).mockResolvedValue(sess)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onSelfDeclarationSubmit(declData)
      expect(k.safetyJudgment.value).toBeNull()
    })

    it('API エラー', async () => {
      vi.mocked(submitSelfDeclaration).mockRejectedValue(new Error('sd fail'))

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onSelfDeclarationSubmit(declData)
      expect(k.error.value).toBe('sd fail')
    })

    it('API エラー (非Error)', async () => {
      vi.mocked(submitSelfDeclaration).mockRejectedValue(undefined)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onSelfDeclarationSubmit(declData)
      expect(k.error.value).toBe('自己申告送信に失敗しました')
    })
  })

  // ---------- onDailyInspectionSubmit ----------

  describe('onDailyInspectionSubmit', () => {
    const diData = {
      brakes: 'ok', tires: 'ok', lights: 'ok', steering: 'ok',
      wipers: 'ok', mirrors: 'ok', horn: 'ok', seatbelts: 'ok',
    }

    it('session なし → 何もしない', async () => {
      const k = useTenkoKiosk()
      await k.onDailyInspectionSubmit(diData)
      expect(submitDailyInspection).not.toHaveBeenCalled()
    })

    it('正常 → status 遷移', async () => {
      const sess = makeSession({ status: 'carrying_items_pending' })
      vi.mocked(submitDailyInspection).mockResolvedValue(sess)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onDailyInspectionSubmit(diData)
      expect(k.step.value).toBe('carrying_items')
      expect(k.isLoading.value).toBe(false)
    })

    it('NG → cancelled', async () => {
      const sess = makeSession({ status: 'cancelled' })
      vi.mocked(submitDailyInspection).mockResolvedValue(sess)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onDailyInspectionSubmit(diData)
      expect(k.step.value).toBe('cancelled')
    })

    it('API エラー', async () => {
      vi.mocked(submitDailyInspection).mockRejectedValue(new Error('di fail'))

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onDailyInspectionSubmit(diData)
      expect(k.error.value).toBe('di fail')
    })

    it('API エラー (非Error)', async () => {
      vi.mocked(submitDailyInspection).mockRejectedValue(false)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onDailyInspectionSubmit(diData)
      expect(k.error.value).toBe('日常点検送信に失敗しました')
    })
  })

  // ---------- loadCarryingItems / onCarryingItemsSubmit ----------

  describe('loadCarryingItems', () => {
    it('マスタあり → carryingItems にセット', async () => {
      const items = [{ id: 'ci-1', tenant_id: 't-1', item_name: '工具', is_required: true, sort_order: 1, created_at: '', vehicle_conditions: [] }]
      vi.mocked(getCarryingItems).mockResolvedValue(items)

      const k = useTenkoKiosk()
      k.step.value = 'carrying_items'
      await k.loadCarryingItems()
      expect(k.carryingItems.value).toEqual(items)
      // step は carrying_items のまま (空でないためスキップしない)
      expect(k.step.value).toBe('carrying_items')
    })

    it('マスタ空 + step=carrying_items → alcohol にスキップ', async () => {
      vi.mocked(getCarryingItems).mockResolvedValue([])

      const k = useTenkoKiosk()
      k.step.value = 'carrying_items'
      await k.loadCarryingItems()
      expect(k.step.value).toBe('alcohol')
    })

    it('マスタ空 + step≠carrying_items → スキップしない', async () => {
      vi.mocked(getCarryingItems).mockResolvedValue([])

      const k = useTenkoKiosk()
      k.step.value = 'nfc'
      await k.loadCarryingItems()
      expect(k.step.value).toBe('nfc')
    })

    it('API エラー → 空配列 + スキップ', async () => {
      vi.mocked(getCarryingItems).mockRejectedValue(new Error('fail'))

      const k = useTenkoKiosk()
      k.step.value = 'carrying_items'
      await k.loadCarryingItems()
      expect(k.carryingItems.value).toEqual([])
      expect(k.step.value).toBe('alcohol')
    })
  })

  describe('onCarryingItemsSubmit', () => {
    it('session なし → 何もしない', async () => {
      const k = useTenkoKiosk()
      await k.onCarryingItemsSubmit([])
      expect(submitCarryingItemChecks).not.toHaveBeenCalled()
    })

    it('正常 → status 遷移', async () => {
      const sess = makeSession({ status: 'instruction_pending' })
      vi.mocked(submitCarryingItemChecks).mockResolvedValue(sess)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onCarryingItemsSubmit([{ item_id: 'ci-1', checked: true }])
      expect(submitCarryingItemChecks).toHaveBeenCalledWith('sess-1', [{ item_id: 'ci-1', checked: true }])
      expect(k.isLoading.value).toBe(false)
    })

    it('API エラー', async () => {
      vi.mocked(submitCarryingItemChecks).mockRejectedValue(new Error('ci fail'))

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onCarryingItemsSubmit([])
      expect(k.error.value).toBe('ci fail')
    })

    it('API エラー (非Error)', async () => {
      vi.mocked(submitCarryingItemChecks).mockRejectedValue(0)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onCarryingItemsSubmit([])
      expect(k.error.value).toBe('携行品チェック送信に失敗しました')
    })
  })

  // ---------- onInstructionConfirm ----------

  describe('onInstructionConfirm', () => {
    it('session なし → 何もしない', async () => {
      const k = useTenkoKiosk()
      await k.onInstructionConfirm()
      expect(confirmInstruction).not.toHaveBeenCalled()
    })

    it('正常 → status 遷移 (completed)', async () => {
      const sess = makeSession({ status: 'completed' })
      vi.mocked(confirmInstruction).mockResolvedValue(sess)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onInstructionConfirm()
      expect(k.step.value).toBe('completed')
      expect(k.isLoading.value).toBe(false)
    })

    it('API エラー', async () => {
      vi.mocked(confirmInstruction).mockRejectedValue(new Error('instr fail'))

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onInstructionConfirm()
      expect(k.error.value).toBe('instr fail')
    })

    it('API エラー (非Error)', async () => {
      vi.mocked(confirmInstruction).mockRejectedValue({})

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onInstructionConfirm()
      expect(k.error.value).toBe('指示確認に失敗しました')
    })
  })

  // ---------- onReportSubmit ----------

  describe('onReportSubmit', () => {
    const reportData = { vehicle_road_status: '良好', driver_alternation: 'なし' }

    it('session なし → 何もしない', async () => {
      const k = useTenkoKiosk()
      await k.onReportSubmit(reportData)
      expect(submitReport).not.toHaveBeenCalled()
    })

    it('正常 → completed', async () => {
      const sess = makeSession({ status: 'completed' })
      vi.mocked(submitReport).mockResolvedValue(sess)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onReportSubmit(reportData)
      expect(k.step.value).toBe('completed')
      expect(k.isLoading.value).toBe(false)
    })

    it('API エラー', async () => {
      vi.mocked(submitReport).mockRejectedValue(new Error('report fail'))

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onReportSubmit(reportData)
      expect(k.error.value).toBe('report fail')
    })

    it('API エラー (非Error)', async () => {
      vi.mocked(submitReport).mockRejectedValue(null)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onReportSubmit(reportData)
      expect(k.error.value).toBe('運行報告送信に失敗しました')
    })
  })

  // ---------- cancel ----------

  describe('cancel', () => {
    it('session なし → 何もしない', async () => {
      const k = useTenkoKiosk()
      await k.cancel('理由')
      expect(cancelTenkoSession).not.toHaveBeenCalled()
    })

    it('正常 → cancelled', async () => {
      const sess = makeSession({ status: 'cancelled' })
      vi.mocked(cancelTenkoSession).mockResolvedValue(sess)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.cancel('テスト理由')
      expect(cancelTenkoSession).toHaveBeenCalledWith('sess-1', { reason: 'テスト理由' })
      expect(k.step.value).toBe('cancelled')
    })

    it('API エラー', async () => {
      vi.mocked(cancelTenkoSession).mockRejectedValue(new Error('cancel fail'))

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.cancel('理由')
      expect(k.error.value).toBe('cancel fail')
    })

    it('API エラー (非Error)', async () => {
      vi.mocked(cancelTenkoSession).mockRejectedValue(Symbol('x'))

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.cancel('理由')
      expect(k.error.value).toBe('キャンセルに失敗しました')
    })
  })

  // ---------- _advanceByStatus (全ステータス網羅) ----------

  describe('_advanceByStatus (各ステータス)', () => {
    // _advanceByStatus は private なので、各 API レスポンスの status を通じてテスト

    it('identity_verified → alcohol', async () => {
      vi.mocked(submitMedical).mockResolvedValue(makeSession({ status: 'identity_verified' }))
      const k = useTenkoKiosk()
      k.session.value = makeSession()
      await k.onMedicalSubmit({ temperature: 36.5 })
      expect(k.step.value).toBe('alcohol')
    })

    it('safety_judgment_pending + fail → interrupted', async () => {
      const sj: SafetyJudgment = { status: 'fail', failed_items: ['blood_pressure'], judged_at: '2026-03-31T00:00:00Z', medical_diffs: null }
      const sess = makeSession({ status: 'safety_judgment_pending', safety_judgment: sj })
      vi.mocked(submitSelfDeclaration).mockResolvedValue(sess)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onSelfDeclarationSubmit({ illness: false, fatigue: false, sleep_deprivation: false })
      expect(k.step.value).toBe('interrupted')
    })

    it('safety_judgment_pending + pass → daily_inspection', async () => {
      const sj: SafetyJudgment = { status: 'pass', failed_items: [], judged_at: '2026-03-31T00:00:00Z', medical_diffs: null }
      const sess = makeSession({ status: 'safety_judgment_pending', safety_judgment: sj })
      vi.mocked(submitSelfDeclaration).mockResolvedValue(sess)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onSelfDeclarationSubmit({ illness: false, fatigue: false, sleep_deprivation: false })
      expect(k.step.value).toBe('daily_inspection')
    })

    it('safety_judgment_pending + safety_judgment=null → daily_inspection', async () => {
      const sess = makeSession({ status: 'safety_judgment_pending', safety_judgment: null })
      vi.mocked(submitSelfDeclaration).mockResolvedValue(sess)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onSelfDeclarationSubmit({ illness: false, fatigue: false, sleep_deprivation: false })
      expect(k.step.value).toBe('daily_inspection')
    })

    it('report_pending → report', async () => {
      vi.mocked(submitAlcohol).mockResolvedValue(makeSession({ status: 'report_pending' }))
      const k = useTenkoKiosk()
      k.session.value = makeSession()
      await k.onAlcoholResult('normal', 0.0)
      expect(k.step.value).toBe('report')
    })

    it('interrupted → interrupted', async () => {
      vi.mocked(confirmInstruction).mockResolvedValue(makeSession({ status: 'interrupted' }))
      const k = useTenkoKiosk()
      k.session.value = makeSession()
      await k.onInstructionConfirm()
      expect(k.step.value).toBe('interrupted')
    })

    it('cancelled → cancelled (_advanceByStatus 経由)', async () => {
      vi.mocked(confirmInstruction).mockResolvedValue(makeSession({ status: 'cancelled' }))
      const k = useTenkoKiosk()
      k.session.value = makeSession()
      await k.onInstructionConfirm()
      expect(k.step.value).toBe('cancelled')
    })

    it('unknown status → step 変更なし', async () => {
      const sess = makeSession({ status: 'alcohol_testing' as any })
      vi.mocked(submitMedical).mockResolvedValue(sess)

      const k = useTenkoKiosk()
      k.session.value = makeSession()
      k.step.value = 'medical'

      await k.onMedicalSubmit({ temperature: 36.5 })
      // default case does nothing, so step stays
      expect(k.step.value).toBe('medical')
    })

    it('safety_judgment_pending + fail via onMedicalSubmit → interrupted', async () => {
      const sj: SafetyJudgment = { status: 'fail', failed_items: ['temperature'], judged_at: '2026-03-31T00:00:00Z', medical_diffs: null }
      const sess = makeSession({ status: 'safety_judgment_pending', safety_judgment: sj })
      vi.mocked(submitMedical).mockResolvedValue(sess)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onMedicalSubmit({ temperature: 39.0 })
      expect(k.session.value?.safety_judgment?.status).toBe('fail')
      expect(k.step.value).toBe('interrupted')
    })
  })

  // ---------- reset ----------

  it('reset で全状態が初期化される', () => {
    const k = useTenkoKiosk()
    k.step.value = 'completed'
    k.employeeId.value = 'emp-1'
    k.employeeName.value = '田中'
    k.pendingSchedules.value = [makeSchedule()]
    k.selectedSchedule.value = makeSchedule()
    k.selectedTenkoType.value = 'post_operation'
    k.session.value = makeSession()
    k.error.value = 'some error'
    k.isLoading.value = true
    k.faceSnapshot.value = new Blob()
    k.safetyJudgment.value = { status: 'pass', failed_items: [], judged_at: '', medical_diffs: null }

    k.reset()

    expect(k.step.value).toBe('nfc')
    expect(k.employeeId.value).toBe('')
    expect(k.employeeName.value).toBe('')
    expect(k.pendingSchedules.value).toEqual([])
    expect(k.selectedSchedule.value).toBeNull()
    expect(k.selectedTenkoType.value).toBeNull()
    expect(k.session.value).toBeNull()
    expect(k.error.value).toBeNull()
    expect(k.isLoading.value).toBe(false)
    expect(k.faceSnapshot.value).toBeNull()
    expect(k.safetyJudgment.value).toBeNull()
  })

  // ---------- tenkoType computed ----------

  describe('tenkoType computed', () => {
    it('session.tenko_type が最優先', () => {
      const k = useTenkoKiosk()
      k.session.value = makeSession({ tenko_type: 'post_operation' })
      k.selectedSchedule.value = makeSchedule({ tenko_type: 'pre_operation' })
      expect(k.tenkoType.value).toBe('post_operation')
    })

    it('session なし → selectedSchedule.tenko_type', () => {
      const k = useTenkoKiosk()
      k.selectedSchedule.value = makeSchedule({ tenko_type: 'post_operation' })
      expect(k.tenkoType.value).toBe('post_operation')
    })

    it('selectedTenkoType は session に上書きされない (session が最優先)', () => {
      const k = useTenkoKiosk()
      k.session.value = makeSession({ tenko_type: 'pre_operation' })
      k.selectedTenkoType.value = 'post_operation'
      expect(k.tenkoType.value).toBe('pre_operation')
    })

    it('selectedTenkoType は selectedSchedule より優先される', () => {
      const k = useTenkoKiosk()
      k.selectedSchedule.value = makeSchedule({ tenko_type: 'pre_operation' })
      k.selectedTenkoType.value = 'post_operation'
      expect(k.tenkoType.value).toBe('post_operation')
    })

    it('remoteMode → pre_operation', () => {
      const k = useTenkoKiosk({ remoteMode: true })
      expect(k.tenkoType.value).toBe('pre_operation')
    })

    it('何もなし → null', () => {
      const k = useTenkoKiosk()
      expect(k.tenkoType.value).toBeNull()
    })
  })

  // ---------- 遠隔点呼への切り替え (Refs ippoan/alc-app-s3#135) ----------

  describe('escalateToRemote — 血圧が測れないとき遠隔へ移す', () => {
    it('昇格すると isRemote が立ち、同じセッションのままサーバへ伝える', async () => {
      const k = useTenkoKiosk()
      k.session.value = makeSession()
      const escalated = makeSession({ escalated_to_remote_at: '2026-09-16T08:05:00Z' })
      vi.mocked(escalateTenkoSessionToRemote).mockResolvedValue(escalated)

      await k.escalateToRemote('血圧計の故障')

      expect(k.escalatedToRemote.value).toBe(true)
      expect(k.isRemote.value).toBe(true)
      expect(k.escalationReason.value).toBe('血圧計の故障')
      expect(escalateTenkoSessionToRemote).toHaveBeenCalledWith('sess-1', '血圧計の故障')
      expect(k.session.value).toEqual(escalated)
    })

    it('最初から遠隔なら何もしない (昇格と混ぜない)', async () => {
      const k = useTenkoKiosk({ remoteMode: true })
      k.session.value = makeSession()

      await k.escalateToRemote('血圧計の故障')

      expect(k.isRemote.value).toBe(true)
      // 最初から遠隔の点呼を「昇格した点呼」に見せない
      expect(k.escalatedToRemote.value).toBe(false)
      expect(k.escalationReason.value).toBeNull()
      expect(escalateTenkoSessionToRemote).not.toHaveBeenCalled()
    })

    it('セッション開始前でも落ちず、遠隔にはなる', async () => {
      const k = useTenkoKiosk()

      await k.escalateToRemote('その他')

      expect(k.isRemote.value).toBe(true)
      expect(escalateTenkoSessionToRemote).not.toHaveBeenCalled()
    })

    it('サーバへの通知が失敗しても遠隔のまま (口はまだ無い)', async () => {
      const k = useTenkoKiosk()
      const before = makeSession()
      k.session.value = before
      vi.mocked(escalateTenkoSessionToRemote).mockRejectedValue(new Error('API エラー (404)'))

      await k.escalateToRemote('血圧計が繋がっていない')

      // 握り潰すのは通信の失敗だけ。画面の状態は必ず遠隔へ移る
      expect(k.isRemote.value).toBe(true)
      expect(k.escalationReason.value).toBe('血圧計が繋がっていない')
      expect(k.error.value).toBeNull()
      expect(k.session.value).toEqual(before)
    })

    it('段の一覧は昇格しても変わらない (現在地がずれない)', async () => {
      const k = useTenkoKiosk()
      k.selectedSchedule.value = makeSchedule({ tenko_type: 'pre_operation' })
      k.step.value = 'medical'
      const labelsBefore = [...k.stepLabels.value]
      const indexBefore = k.currentStepIndex.value

      await k.escalateToRemote('血圧計の故障')

      expect(k.stepLabels.value).toEqual(labelsBefore)
      expect(k.currentStepIndex.value).toBe(indexBefore)
      expect(k.stepLabels.value).toContain('予定選択')
    })

    it('reset で昇格は畳まれる', async () => {
      const k = useTenkoKiosk()
      await k.escalateToRemote('血圧計の故障')
      expect(k.isRemote.value).toBe(true)

      k.reset()

      expect(k.escalatedToRemote.value).toBe(false)
      expect(k.escalationReason.value).toBeNull()
      expect(k.isRemote.value).toBe(false)
    })
  })
  // ---------- 途中で止まった点呼の再開 (Refs ippoan/alc-app#343) ----------

  describe('未完了セッションの再開', () => {
    /** listTenkoSessions の 1 回ぶんの応答 */
    function page(sessions: TenkoSession[]) {
      return { sessions, total: sessions.length, page: 1, per_page: 50 }
    }

    /** status ごとの問い合わせに、その status の行だけを返させる */
    function serveByStatus(rows: TenkoSession[]) {
      vi.mocked(listTenkoSessions).mockImplementation(async (filter) => {
        return page(rows.filter(r => r.status === filter?.status))
      })
    }

    /** サーバが返す「再開済みにした行」 (Refs ippoan/alc-app#351) */
    const RESUMED_AT = '2026-03-31T23:05:00Z'

    beforeEach(() => {
      vi.mocked(getPendingSchedules).mockResolvedValue([])
      vi.mocked(listTenkoSessions).mockResolvedValue(page([]))
      // 既定はサーバが受け付ける。`started_at` は**サーバも書き換えない**ので、
      // 返ってくるのは元の行に resumed_at / resume_reason が乗ったものになる
      vi.mocked(selfResumeTenkoSession).mockImplementation(async (id, data) =>
        makeSession({ id, resumed_at: RESUMED_AT, resume_reason: data.reason }),
      )
    })

    it('allowResume を渡さないと 1 回も引かない (既定は今までどおり)', async () => {
      const k = useTenkoKiosk()
      await k.identifyEmployee('emp-1', '田中')
      expect(listTenkoSessions).not.toHaveBeenCalled()
      expect(k.resumableSessions.value).toEqual([])
      expect(k.step.value).toBe('schedule_select')
    })

    it('★ 未完了が無い乗務員では、いままでどおり予定一覧だけが出る', async () => {
      vi.mocked(getPendingSchedules).mockResolvedValue([makeSchedule()])
      const k = useTenkoKiosk({ allowResume: true })
      await k.identifyEmployee('emp-1', '田中')
      expect(k.step.value).toBe('schedule_select')
      expect(k.pendingSchedules.value).toHaveLength(1)
      expect(k.resumableSessions.value).toEqual([])
    })

    it('★ アルコール未測定の status だけを、status ごとに 1 回ずつ引く', async () => {
      const stuck = makeSession({ id: 'sess-stuck', status: 'medical_pending', started_at: '2026-03-31T22:52:00Z' })
      serveByStatus([stuck])

      const k = useTenkoKiosk({ allowResume: true })
      await k.identifyEmployee('emp-1', '田中')

      expect(listTenkoSessions).toHaveBeenCalledTimes(RESUMABLE_TENKO_STATUSES.length)
      for (const status of RESUMABLE_TENKO_STATUSES) {
        expect(listTenkoSessions).toHaveBeenCalledWith({ employee_id: 'emp-1', status })
      }
      expect(k.resumableSessions.value).toEqual([stuck])
    })

    it('★ interrupted / completed / cancelled は再開候補に出ない', async () => {
      // サーバが返し得る全 status を用意しても、問い合わせる status に無いものは出ない
      const rows = [
        makeSession({ id: 'a', status: 'interrupted' }),
        makeSession({ id: 'b', status: 'completed' }),
        makeSession({ id: 'c', status: 'cancelled' }),
        makeSession({ id: 'd', status: 'medical_pending' }),
      ]
      serveByStatus(rows)

      const k = useTenkoKiosk({ allowResume: true })
      await k.identifyEmployee('emp-1', '田中')

      expect(RESUMABLE_TENKO_STATUSES).not.toContain('interrupted')
      expect(RESUMABLE_TENKO_STATUSES).not.toContain('completed')
      expect(RESUMABLE_TENKO_STATUSES).not.toContain('cancelled')
      expect(k.resumableSessions.value.map(s => s.id)).toEqual(['d'])
    })

    it('★ アルコール測定済み (instruction_pending / report_pending) も候補に出ない', async () => {
      expect(RESUMABLE_TENKO_STATUSES).not.toContain('instruction_pending')
      expect(RESUMABLE_TENKO_STATUSES).not.toContain('report_pending')
    })

    it('status は合っていても alcohol_tested_at が入っている行は落とす', async () => {
      serveByStatus([
        makeSession({ id: 'measured', status: 'medical_pending', alcohol_tested_at: '2026-03-31T22:00:00Z' }),
        makeSession({ id: 'clean', status: 'medical_pending' }),
      ])

      const k = useTenkoKiosk({ allowResume: true })
      await k.identifyEmployee('emp-1', '田中')

      expect(k.resumableSessions.value.map(s => s.id)).toEqual(['clean'])
    })

    it('新しいものから並ぶ (started_at が無い行は最後)', async () => {
      serveByStatus([
        makeSession({ id: 'old', status: 'medical_pending', started_at: '2026-03-30T08:00:00Z' }),
        makeSession({ id: 'none', status: 'self_declaration_pending', started_at: null }),
        makeSession({ id: 'new', status: 'daily_inspection_pending', started_at: '2026-03-31T22:52:00Z' }),
      ])

      const k = useTenkoKiosk({ allowResume: true })
      await k.identifyEmployee('emp-1', '田中')

      expect(k.resumableSessions.value.map(s => s.id)).toEqual(['new', 'old', 'none'])
    })

    it('★ 照会が全部落ちても本人特定は止めず、予定一覧は今までどおり出る', async () => {
      vi.mocked(getPendingSchedules).mockResolvedValue([makeSchedule()])
      vi.mocked(listTenkoSessions).mockRejectedValue(new Error('network'))

      const k = useTenkoKiosk({ allowResume: true })
      await k.identifyEmployee('emp-1', '田中')

      expect(k.error.value).toBeNull()
      expect(k.step.value).toBe('schedule_select')
      expect(k.pendingSchedules.value).toHaveLength(1)
      expect(k.resumableSessions.value).toEqual([])
    })

    it('一部の status だけ落ちたら、取れた分だけ出す', async () => {
      const stuck = makeSession({ id: 'sess-stuck', status: 'medical_pending' })
      vi.mocked(listTenkoSessions).mockImplementation(async (filter) => {
        if (filter?.status === 'medical_pending') return page([stuck])
        throw new Error('network')
      })

      const k = useTenkoKiosk({ allowResume: true })
      await k.identifyEmployee('emp-1', '田中')

      expect(k.error.value).toBeNull()
      expect(k.resumableSessions.value).toEqual([stuck])
    })

    it('予定取得が落ちたときは今までどおり error を出す (再開の照会は道連れにしない)', async () => {
      vi.mocked(getPendingSchedules).mockRejectedValue(new Error('network'))
      const k = useTenkoKiosk({ allowResume: true })
      await k.identifyEmployee('emp-1', '田中')
      expect(k.error.value).toBe('network')
      expect(k.step.value).not.toBe('schedule_select')
      expect(k.resumableSessions.value).toEqual([])
    })

    it('次の乗務員に前の候補を引きずらない', async () => {
      const stuck = makeSession({ id: 'sess-stuck', status: 'medical_pending' })
      serveByStatus([stuck])
      const k = useTenkoKiosk({ allowResume: true })
      await k.identifyEmployee('emp-1', '田中')
      expect(k.resumableSessions.value).toHaveLength(1)

      k.reset()
      expect(k.resumableSessions.value).toEqual([])
    })

    // ----- resumeSession: 拾った status から正しい step へ -----

    it.each([
      ['identity_verified', 'alcohol'],
      ['medical_pending', 'medical'],
      ['self_declaration_pending', 'self_declaration'],
      ['daily_inspection_pending', 'daily_inspection'],
      ['carrying_items_pending', 'carrying_items'],
    ] as const)('★ %s のセッションを選ぶと %s から続く', async (status, expected) => {
      const stuck = makeSession({ id: 'sess-stuck', status })
      const k = useTenkoKiosk({ allowResume: true })
      await k.resumeSession(stuck)

      // サーバが返した「再開済みにした行」を載せる (Refs ippoan/alc-app#351)
      expect(k.session.value?.id).toBe('sess-stuck')
      expect(k.session.value?.resumed_at).toBe(RESUMED_AT)
      expect(k.step.value).toBe(expected)
      expect(k.error.value).toBeNull()
      expect(k.isLoading.value).toBe(false)
      // 新しいセッションは起こさない
      expect(startTenkoSession).not.toHaveBeenCalled()
    })

    it('まだ未実施として残っている予定を拾って指示事項に繋ぐ', async () => {
      const sched = makeSchedule({ id: 'sched-1', instruction: '安全運転で' })
      vi.mocked(getPendingSchedules).mockResolvedValue([sched])
      const stuck = makeSession({ status: 'medical_pending', schedule_id: 'sched-1' })

      const k = useTenkoKiosk({ allowResume: true })
      await k.identifyEmployee('emp-1', '田中')
      await k.resumeSession(stuck)

      expect(k.selectedSchedule.value).toStrictEqual(sched)
    })

    it('予定が消費済みで拾えなくても続きへ進む (指示は出ないだけ)', async () => {
      const stuck = makeSession({ status: 'medical_pending', schedule_id: 'sched-gone' })
      const k = useTenkoKiosk({ allowResume: true })
      await k.resumeSession(stuck)

      expect(k.selectedSchedule.value).toBeNull()
      expect(k.step.value).toBe('medical')
    })

    it('★ 再開の経路も #336 の入口ガードを通る — 血圧の要否が不明な端末の業務前は止める', async () => {
      deviceId.value = null
      signedBpBonded.value = null
      hasProbedBpBond.value = true
      const stuck = makeSession({ status: 'medical_pending', tenko_type: 'pre_operation' })

      const k = useTenkoKiosk({ allowResume: true })
      await k.resumeSession(stuck)

      expect(k.step.value).not.toBe('medical')
      expect(k.bpRequirementUnknown.value).toBe(true)
      expect(k.error.value).toBe(BP_REQUIREMENT_UNKNOWN_MESSAGE)
      expect(k.isLoading.value).toBe(false)
    })

    it('要否が不明でも業務後の再開は止めない (既定を今までどおりに保つ)', async () => {
      deviceId.value = null
      signedBpBonded.value = null
      hasProbedBpBond.value = true
      const stuck = makeSession({ status: 'identity_verified', tenko_type: 'post_operation' })

      const k = useTenkoKiosk({ allowResume: true })
      await k.resumeSession(stuck)

      expect(k.bpRequirementUnknown.value).toBe(false)
      expect(k.step.value).toBe('alcohol')
    })

    it('★ 止めた再開も「もう一度試す」で続きから戻れる (リロードなし)', async () => {
      deviceId.value = null
      signedBpBonded.value = null
      hasProbedBpBond.value = true
      const stuck = makeSession({ status: 'medical_pending', tenko_type: 'pre_operation' })

      const k = useTenkoKiosk({ allowResume: true })
      await k.resumeSession(stuck)
      expect(k.bpRequirementUnknown.value).toBe(true)

      refreshSignedBpBonded.mockImplementationOnce(async () => {
        signedBpBonded.value = false
        return false
      })
      await k.retryBpRequirement()

      expect(refreshSignedBpBonded).toHaveBeenCalledTimes(1)
      expect(k.bpRequirementUnknown.value).toBe(false)
      expect(k.error.value).toBeNull()
      expect(k.step.value).toBe('medical')
      // 顔認証の経路を巻き込まない
      expect(startTenkoSession).not.toHaveBeenCalled()
    })

    it('もう一度試してもなお不明なら、同じ画面に戻るだけ', async () => {
      deviceId.value = null
      signedBpBonded.value = null
      hasProbedBpBond.value = true
      const stuck = makeSession({ status: 'medical_pending', tenko_type: 'pre_operation' })

      const k = useTenkoKiosk({ allowResume: true })
      await k.resumeSession(stuck)
      await k.retryBpRequirement()

      expect(k.bpRequirementUnknown.value).toBe(true)
      expect(k.error.value).toBe(BP_REQUIREMENT_UNKNOWN_MESSAGE)
      expect(k.step.value).not.toBe('medical')
    })

    // ----- 再開した時刻をサーバに残す (Refs ippoan/alc-app#351) -----

    /** サーバの 400 (`{"error": …, "message": …}`) と同じ形の失敗 */
    function badRequest(code: string, message: string): Error {
      return Object.assign(
        new Error(`API エラー (400): ${JSON.stringify({ error: code, message })}`),
        { status: 400 },
      )
    }

    it('★ 再開したらサーバに知らせる — 固定の理由を添えて self-resume を 1 回だけ呼ぶ', async () => {
      const stuck = makeSession({ id: 'sess-stuck', status: 'medical_pending' })
      const k = useTenkoKiosk({ allowResume: true })

      await k.resumeSession(stuck)

      expect(selfResumeTenkoSession).toHaveBeenCalledTimes(1)
      expect(selfResumeTenkoSession).toHaveBeenCalledWith('sess-stuck', { reason: KIOSK_SELF_RESUME_REASON })
      expect(k.step.value).toBe('medical')
      expect(k.error.value).toBeNull()
      expect(k.isLoading.value).toBe(false)
    })

    it('★ `started_at` は送らない — 送るのは reason だけ (記録は書き換えず、再開の事実を足す)', async () => {
      const stuck = makeSession({ id: 'sess-stuck', status: 'medical_pending', started_at: '2026-03-31T15:12:26Z' })
      const k = useTenkoKiosk({ allowResume: true })

      await k.resumeSession(stuck)

      const body = vi.mocked(selfResumeTenkoSession).mock.calls[0]![1]
      expect(Object.keys(body)).toEqual(['reason'])
      // 管理者用の `/resume` (status を書き換える口) は使わない
      expect(startTenkoSession).not.toHaveBeenCalled()
    })

    it('★ 入口ガードで止めた分は「1 回まで」を食い潰さない (サーバを呼ばない)', async () => {
      deviceId.value = null
      signedBpBonded.value = null
      hasProbedBpBond.value = true
      const stuck = makeSession({ status: 'medical_pending', tenko_type: 'pre_operation' })

      const k = useTenkoKiosk({ allowResume: true })
      await k.resumeSession(stuck)

      expect(k.bpRequirementUnknown.value).toBe(true)
      expect(selfResumeTenkoSession).not.toHaveBeenCalled()

      // 「もう一度試す」で通ったときに初めて 1 回ぶんを使う
      refreshSignedBpBonded.mockImplementationOnce(async () => {
        signedBpBonded.value = false
        return false
      })
      await k.retryBpRequirement()

      expect(selfResumeTenkoSession).toHaveBeenCalledTimes(1)
      expect(k.step.value).toBe('medical')
    })

    it('★ already_resumed は無言で止めず、文言を出して最初の画面へ戻す', async () => {
      vi.mocked(selfResumeTenkoSession).mockRejectedValue(
        badRequest('already_resumed', 'この点呼は既に再開済みです。新しく点呼をやり直してください'),
      )
      const stuck = makeSession({ id: 'sess-stuck', status: 'medical_pending' })

      const k = useTenkoKiosk({ allowResume: true })
      await k.identifyEmployee('emp-1', '田中')
      await k.resumeSession(stuck)

      expect(k.error.value).toBe(ALREADY_RESUMED_MESSAGE)
      // 押し直しても永久に通らないので、乗務員 ID の画面まで戻す
      expect(k.step.value).toBe('nfc')
      expect(k.session.value).toBeNull()
      expect(k.employeeId.value).toBe('')
      expect(k.isLoading.value).toBe(false)
    })

    it('★ session_not_resumable も理由の分かる文言を出して最初の画面へ戻す', async () => {
      vi.mocked(selfResumeTenkoSession).mockRejectedValue(
        badRequest('session_not_resumable', 'この点呼は再開できません。新しく点呼をやり直してください'),
      )
      const stuck = makeSession({ status: 'medical_pending' })

      const k = useTenkoKiosk({ allowResume: true })
      await k.resumeSession(stuck)

      expect(k.error.value).toBe(SESSION_NOT_RESUMABLE_MESSAGE)
      expect(k.error.value).toContain('やり直して')
      expect(k.step.value).toBe('nfc')
      expect(k.session.value).toBeNull()
    })

    it('★ 通信が落ちたときは続きへ通さない — 予定選択に留めて押し直させる', async () => {
      vi.mocked(selfResumeTenkoSession).mockRejectedValue(new Error('Failed to fetch'))
      const stuck = makeSession({ status: 'medical_pending' })

      const k = useTenkoKiosk({ allowResume: true })
      await k.identifyEmployee('emp-1', '田中')
      await k.resumeSession(stuck)

      // 黙って通すと #351 の症状 (実施時刻の残らない点呼) をそのまま作ってしまう
      expect(k.step.value).toBe('schedule_select')
      expect(k.error.value).toBe('Failed to fetch')
      // やり直せるように乗務員は保ったまま
      expect(k.employeeId.value).toBe('emp-1')

      vi.mocked(selfResumeTenkoSession).mockResolvedValueOnce(
        makeSession({ status: 'medical_pending', resumed_at: RESUMED_AT }),
      )
      await k.resumeSession(stuck)

      expect(k.error.value).toBeNull()
      expect(k.step.value).toBe('medical')
    })

    it('Error でないもので落ちても文言を出す (無言で止めない)', async () => {
      vi.mocked(selfResumeTenkoSession).mockRejectedValue('boom')
      const k = useTenkoKiosk({ allowResume: true })
      await k.resumeSession(makeSession({ status: 'medical_pending' }))

      expect(k.error.value).toBe('点呼の再開に失敗しました')
      expect(k.step.value).not.toBe('medical')
    })

    it('★ 1 度再開した点呼は再開候補に出さない (押してから断らない)', async () => {
      serveByStatus([
        makeSession({ id: 'resumed', status: 'medical_pending', resumed_at: RESUMED_AT }),
        makeSession({ id: 'fresh', status: 'medical_pending' }),
      ])

      const k = useTenkoKiosk({ allowResume: true })
      await k.identifyEmployee('emp-1', '田中')

      expect(k.resumableSessions.value.map(s => s.id)).toEqual(['fresh'])
    })

    it('reset() で止めた再開が残らない', async () => {
      deviceId.value = null
      signedBpBonded.value = null
      hasProbedBpBond.value = true
      const k = useTenkoKiosk({ allowResume: true })
      await k.resumeSession(makeSession({ status: 'medical_pending', tenko_type: 'pre_operation' }))
      expect(k.bpRequirementUnknown.value).toBe(true)

      k.reset()

      expect(k.bpRequirementUnknown.value).toBe(false)
      expect(k.session.value).toBeNull()
    })
  })
})
