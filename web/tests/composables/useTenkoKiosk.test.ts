import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TenkoSchedule, TenkoSession, SafetyJudgment } from '~/types'

vi.mock('~/utils/api', () => ({
  getPendingSchedules: vi.fn(),
  startTenkoSession: vi.fn(),
  submitAlcohol: vi.fn(),
  submitMedical: vi.fn(),
  submitSelfDeclaration: vi.fn(),
  submitDailyInspection: vi.fn(),
  confirmInstruction: vi.fn(),
  submitReport: vi.fn(),
  cancelTenkoSession: vi.fn(),
  uploadFacePhoto: vi.fn(),
  getCarryingItems: vi.fn(),
  submitCarryingItemChecks: vi.fn(),
}))

import { useTenkoKiosk } from '~/composables/useTenkoKiosk'
import { noPendingSchedule } from '~/utils/employee-lookup-messages'
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
  uploadFacePhoto,
  getCarryingItems,
  submitCarryingItemChecks,
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
  })

  // ---------- 初期状態 ----------

  it('初期値が正しい', () => {
    const k = useTenkoKiosk()
    expect(k.step.value).toBe('nfc')
    expect(k.employeeId.value).toBe('')
    expect(k.employeeName.value).toBe('')
    expect(k.pendingSchedules.value).toEqual([])
    expect(k.selectedSchedule.value).toBeNull()
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
    it('remoteMode → face_auth に直接遷移', async () => {
      const k = useTenkoKiosk({ remoteMode: true })
      await k.identifyEmployee('emp-1', '田中')
      expect(k.step.value).toBe('face_auth')
      expect(k.employeeId.value).toBe('emp-1')
      expect(k.employeeName.value).toBe('田中')
      expect(getPendingSchedules).not.toHaveBeenCalled()
    })

    it('スケジュールあり → schedule_select に遷移', async () => {
      vi.mocked(getPendingSchedules).mockResolvedValue([makeSchedule()])
      const k = useTenkoKiosk()
      await k.identifyEmployee('emp-1', '田中')
      expect(k.step.value).toBe('schedule_select')
      expect(k.pendingSchedules.value).toHaveLength(1)
      expect(k.isLoading.value).toBe(false)
    })

    it('スケジュール空 → エラー', async () => {
      vi.mocked(getPendingSchedules).mockResolvedValue([])
      const k = useTenkoKiosk()
      await k.identifyEmployee('emp-1', '田中')
      expect(k.error.value).toBe(noPendingSchedule())
      expect(k.step.value).toBe('nfc')
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

  // ---------- onFaceAuthComplete ----------

  describe('onFaceAuthComplete', () => {
    it('verified=false → 何もしない', async () => {
      const k = useTenkoKiosk()
      await k.onFaceAuthComplete({ verified: false, similarity: 0.3 })
      expect(startTenkoSession).not.toHaveBeenCalled()
    })

    it('通常モード: selectedSchedule なし → 何もしない', async () => {
      const k = useTenkoKiosk()
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })
      expect(startTenkoSession).not.toHaveBeenCalled()
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

    it('remoteMode → pre_operation', () => {
      const k = useTenkoKiosk({ remoteMode: true })
      expect(k.tenkoType.value).toBe('pre_operation')
    })

    it('何もなし → null', () => {
      const k = useTenkoKiosk()
      expect(k.tenkoType.value).toBeNull()
    })
  })
})
