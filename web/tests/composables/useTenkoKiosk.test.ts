import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import type { TenkoSchedule, TenkoSession, SafetyJudgment } from '~/types'
import { FETCH_TIMEOUT_MESSAGE_WRITE } from '~/utils/fetch-timeout'
import { onGpsLine, resetGpsFix } from '~/composables/useGpsFix'

const deviceId = ref<string | null>('device-1')
mockNuxtImport('useAuth', () => () => ({ deviceId }))

// `apiErrorCode` は**実物を使う** (Refs ippoan/alc-app#351) — 400 の body から
// コードを取り出すのは api.ts が作った文言の読み方そのものなので、ここで差し替えると
// 「文言の作り方と読み方が揃っているか」という肝心の所を素通りする。
vi.mock('~/utils/api', async () => ({
  ...(await vi.importActual<typeof import('~/utils/api')>('~/utils/api')),
  getPendingSchedules: vi.fn(),
  startTenkoSession: vi.fn(),
  updateMeasurement: vi.fn(),
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
  updateTenkoSessionVehicle: vi.fn(),
  getMeasurements: vi.fn(),
}))
vi.mock('~/utils/equipment-failure-report', async () => ({
  ...(await vi.importActual<typeof import('~/utils/equipment-failure-report')>('~/utils/equipment-failure-report')),
  reportApiFailure: vi.fn(),
}))

import {
  useTenkoKiosk, RESUMABLE_TENKO_STATUSES,
  KIOSK_SELF_RESUME_REASON, MEDICAL_EXPIRED_MESSAGE, SESSION_NOT_RESUMABLE_MESSAGE,
} from '~/composables/useTenkoKiosk'
import {
  getPendingSchedules,
  startTenkoSession,
  updateMeasurement,
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
  updateTenkoSessionVehicle,
  getMeasurements,
} from '~/utils/api'
import { reportApiFailure } from '~/utils/equipment-failure-report'

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
    resumed_by_name: null,
    alternative_measure: null,
    // 既定は車検証で車両番号が決まった点呼 = 車両番号の段は通らない。車両番号の段を見る試験は上書きする
    vehicle_number: '車両A',
    vehicle_number_source: 'carins',
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

/** この端末で測った血圧 */
const BP = { systolic: 120, diastolic: 80 }

describe('useTenkoKiosk', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deviceId.value = 'device-1'
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

    it('★ 段の名前と段の並びは同じ長さで、業務前は携行品の段に「携行品」が光る', () => {
      const pre = useTenkoKiosk({ remoteMode: true })
      expect(pre.stepLabels.value).toHaveLength(pre.stepKeys.value.length)
      pre.step.value = 'carrying_items'
      expect(pre.stepLabels.value[pre.currentStepIndex.value]).toBe('携行品')
      pre.step.value = 'alcohol'
      expect(pre.stepLabels.value[pre.currentStepIndex.value]).toBe('アルコール')
      const local = useTenkoKiosk()
      expect(local.stepLabels.value).toHaveLength(local.stepKeys.value.length)
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

    it('GPS の位置を受けていれば start の body に location を載せる (予定あり・なし両方、Refs ippoan/alc-app#514)', async () => {
      resetGpsFix()
      onGpsLine('EVT GPS FIX lat=35.681237 lon=139.767125 sats=8 hdop=0.9 alt=40.1 utc=2026-10-24T06:30:00Z')
      vi.mocked(startTenkoSession).mockResolvedValue(makeSession({ status: 'identity_verified' }))

      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })
      expect(startTenkoSession).toHaveBeenLastCalledWith(expect.objectContaining({
        schedule_id: 'sched-1',
        location: 'FIX lat=35.681237 lon=139.767125 sats=8 hdop=0.9 alt=40.1 utc=2026-10-24T06:30:00Z',
      }))

      const k2 = useTenkoKiosk()
      k2.employeeId.value = 'emp-1'
      k2.proceedWithoutSchedule()
      await k2.onFaceAuthComplete({ verified: true, similarity: 0.9 })
      expect(startTenkoSession).toHaveBeenLastCalledWith(expect.objectContaining({ tenko_type: 'post_operation', location: expect.stringMatching(/^FIX /) }))
      resetGpsFix()
    })

    it('GPS を受けていなければ start の body に location の欄ごと載せない', async () => {
      resetGpsFix()
      vi.mocked(startTenkoSession).mockResolvedValue(makeSession({ status: 'identity_verified' }))

      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })

      const body = vi.mocked(startTenkoSession).mock.calls.at(-1)![0]
      expect('location' in body).toBe(false)
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
      expect(k.stepLabels.value).toEqual(['NFC', '本人確認', 'アルコール', '指示確認', '運行報告', '完了'])
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

  // ---------- onAlcoholMeasured ----------

  describe('onAlcoholMeasured', () => {
    /** 測定の保存の応答 (進めた後のセッションを載せる) */
    const saved = (tenko_session?: ReturnType<typeof makeSession>) =>
      ({ id: 'meas-1', tenko_session }) as Awaited<ReturnType<typeof updateMeasurement>>

    it('session なし → 何もしない', async () => {
      const k = useTenkoKiosk()
      expect(await k.onAlcoholMeasured('meas-1', { status: 'completed' })).toBe(false)
      expect(updateMeasurement).not.toHaveBeenCalled()
    })

    it('測定の保存に tenko_session_id を足し、返ったセッションで進める', async () => {
      vi.mocked(updateMeasurement).mockResolvedValue(saved(makeSession({ status: 'instruction_pending' })))

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      const retry = await k.onAlcoholMeasured('meas-1', { status: 'completed', result_type: 'normal', alcohol_value: 0.0 })
      expect(retry).toBe(false)
      expect(updateMeasurement).toHaveBeenCalledWith('meas-1', {
        status: 'completed',
        result_type: 'normal',
        alcohol_value: 0.0,
        tenko_session_id: 'sess-1',
      })
      expect(k.session.value?.status).toBe('instruction_pending')
      expect(k.step.value).toBe('instruction')
      expect(k.isLoading.value).toBe(false)
    })

    it('アルコール検知 → cancelled', async () => {
      vi.mocked(updateMeasurement).mockResolvedValue(saved(makeSession({ status: 'cancelled' })))
      const k = useTenkoKiosk()
      k.session.value = makeSession()
      expect(await k.onAlcoholMeasured('meas-1', {})).toBe(false)
      expect(k.step.value).toBe('cancelled')
    })

    it('結果が点呼にならない (本人確認済みのまま) → 測り直し', async () => {
      vi.mocked(updateMeasurement).mockResolvedValue(saved(makeSession({ status: 'identity_verified' })))
      const k = useTenkoKiosk()
      k.session.value = makeSession()
      expect(await k.onAlcoholMeasured('meas-1', {})).toBe(true)
      expect(k.error.value).toBe('測定結果を点呼に使えませんでした。もう一度測ってください')
    })

    it('応答にセッションが無い → 測り直し', async () => {
      vi.mocked(updateMeasurement).mockResolvedValue(saved())
      const k = useTenkoKiosk()
      k.session.value = makeSession()
      expect(await k.onAlcoholMeasured('meas-1', {})).toBe(true)
      expect(k.error.value).toBe('アルコール測定を点呼に載せられませんでした。もう一度測ってください')
    })

    it('API エラー', async () => {
      vi.mocked(updateMeasurement).mockRejectedValue(new Error('alc fail'))
      const k = useTenkoKiosk()
      k.session.value = makeSession()
      expect(await k.onAlcoholMeasured('meas-1', {})).toBe(true)
      expect(k.error.value).toBe('alc fail')
    })

    it('API エラー (非Error)', async () => {
      vi.mocked(updateMeasurement).mockRejectedValue(42)
      const k = useTenkoKiosk()
      k.session.value = makeSession()
      expect(await k.onAlcoholMeasured('meas-1', {})).toBe(true)
      expect(k.error.value).toBe('アルコール結果送信に失敗しました')
    })
  })

  // ---------- onMedicalSubmit ----------

  describe('onMedicalSubmit', () => {
    it('session なし → 何もしない', async () => {
      const k = useTenkoKiosk()
      await k.onMedicalSubmit({ temperature: 36.5, ...BP })
      expect(submitMedical).not.toHaveBeenCalled()
    })

    it('正常送信 → status 遷移', async () => {
      const sess = makeSession({ status: 'self_declaration_pending' })
      vi.mocked(submitMedical).mockResolvedValue(sess)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onMedicalSubmit({ temperature: 36.5, ...BP })
      expect(k.step.value).toBe('self_declaration')
      expect(k.isLoading.value).toBe(false)
    })

    it('device_id が取れる端末 → device_id を付けて送信 (Refs ippoan/alc-app#322)', async () => {
      const sess = makeSession({ status: 'self_declaration_pending' })
      vi.mocked(submitMedical).mockResolvedValue(sess)
      deviceId.value = 'device-1'

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onMedicalSubmit({ temperature: 36.5, ...BP })
      expect(submitMedical).toHaveBeenCalledWith('sess-1', { temperature: 36.5, ...BP, device_id: 'device-1' })
    })

    it('device_id が取れない端末 → device_id を付けずに送信 (サーバはフェイルクローズ)', async () => {
      const sess = makeSession({ status: 'self_declaration_pending' })
      vi.mocked(submitMedical).mockResolvedValue(sess)
      deviceId.value = null

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onMedicalSubmit({ temperature: 36.5, ...BP })
      expect(submitMedical).toHaveBeenCalledWith('sess-1', { temperature: 36.5, ...BP })
    })

    it('API エラー', async () => {
      vi.mocked(submitMedical).mockRejectedValue(new Error('med fail'))

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onMedicalSubmit({ temperature: 36.5, ...BP })
      expect(k.error.value).toBe('med fail')
    })

    it('API エラー (非Error)', async () => {
      vi.mocked(submitMedical).mockRejectedValue(null)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onMedicalSubmit({ temperature: 36.5, ...BP })
      expect(k.error.value).toBe('医療データ送信に失敗しました')
    })
  })

  // ---------- 血圧は測定台の別端末で測る: キオスクは血圧を扱わない ----------

  describe('体温だけの送信 (血圧なし)', () => {
    it('★ 体温の段に入っても測定を引きに行かない', async () => {
      vi.mocked(startTenkoSession).mockResolvedValue(makeSession({ status: 'medical_pending' }))
      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })

      expect(k.step.value).toBe('medical')
      expect(getMeasurements).not.toHaveBeenCalled()
    })

    it('★ 血圧なしでも止めずにそのまま送り、次の段へ進む。測定時刻は端末の読み取り時刻のまま', async () => {
      vi.mocked(submitMedical).mockResolvedValue(makeSession({ status: 'self_declaration_pending' }))
      const k = useTenkoKiosk()
      k.session.value = makeSession({ status: 'medical_pending' })

      await k.onMedicalSubmit({ temperature: 36.5, medical_measured_at: '2026-03-31T22:40:00Z' })

      expect(submitMedical).toHaveBeenCalledWith('sess-1', {
        temperature: 36.5, medical_measured_at: '2026-03-31T22:40:00Z', device_id: 'device-1',
      })
      expect(k.error.value).toBeNull()
      expect(k.step.value).toBe('self_declaration')
    })

    it('遠隔点呼でも同じ内容をそのまま送る', async () => {
      vi.mocked(submitMedical).mockResolvedValue(makeSession({ status: 'self_declaration_pending' }))
      const k = useTenkoKiosk({ remoteMode: true })
      k.session.value = makeSession()

      await k.onMedicalSubmit({ temperature: 36.5 })

      expect(submitMedical).toHaveBeenCalledWith('sess-1', { temperature: 36.5, device_id: 'device-1' })
    })

    it('★ 測定から有効時間切れ (400 measurement_expired) → サーバーの文言を出し、段に留まる', async () => {
      vi.mocked(submitMedical).mockRejectedValue(Object.assign(
        new Error(`API エラー (400): ${JSON.stringify({
          error: 'measurement_expired',
          message: '測定から有効時間 (30 分) を過ぎています。もう一度測定してください',
        })}`),
        { status: 400 },
      ))
      const k = useTenkoKiosk()
      k.session.value = makeSession({ status: 'medical_pending' })
      k.step.value = 'medical'

      await k.onMedicalSubmit({ temperature: 36.5, medical_measured_at: '2026-03-31T10:00:00Z' })

      expect(k.error.value).toBe('測定から有効時間 (30 分) を過ぎています。もう一度測定してください')
      expect(k.step.value).toBe('medical')
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
      await k.onMedicalSubmit({ temperature: 36.5, ...BP })
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
      vi.mocked(updateMeasurement).mockResolvedValue({ id: 'meas-1', tenko_session: makeSession({ status: 'report_pending' }) } as never)
      const k = useTenkoKiosk()
      k.session.value = makeSession()
      await k.onAlcoholMeasured('meas-1', {})
      expect(k.step.value).toBe('report')
    })

    it('judgment_pending → completed (完了の画面で判定待ちを出す)', async () => {
      vi.mocked(submitReport).mockResolvedValue(makeSession({ status: 'judgment_pending' }))
      const k = useTenkoKiosk()
      k.session.value = makeSession()
      await k.onReportSubmit({ vehicle_road_status: 'a', driver_alternation: 'b' } as never)
      expect(k.step.value).toBe('completed')
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

      await k.onMedicalSubmit({ temperature: 36.5, ...BP })
      // default case does nothing, so step stays
      expect(k.step.value).toBe('medical')
    })

    it('safety_judgment_pending + fail via onMedicalSubmit → interrupted', async () => {
      const sj: SafetyJudgment = { status: 'fail', failed_items: ['temperature'], judged_at: '2026-03-31T00:00:00Z', medical_diffs: null }
      const sess = makeSession({ status: 'safety_judgment_pending', safety_judgment: sj })
      vi.mocked(submitMedical).mockResolvedValue(sess)

      const k = useTenkoKiosk()
      k.session.value = makeSession()

      await k.onMedicalSubmit({ temperature: 39.0, ...BP })
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

    /** いま再開を選んでいる行 (サーバー(モック)が status を変えずに返す) */
    let held: TenkoSession | null = null
    /** サーバが返す「再開済みにした行」 (Refs ippoan/alc-app#351) */
    const RESUMED_AT = '2026-03-31T23:05:00Z'

    beforeEach(() => {
      vi.mocked(getPendingSchedules).mockResolvedValue([])
      vi.mocked(listTenkoSessions).mockResolvedValue(page([]))
      // 既定はサーバが受け付ける。`started_at` は**サーバも書き換えない**ので、
      // 返ってくるのは元の行に resumed_at / resume_reason が乗ったものになる
      held = null
      vi.mocked(selfResumeTenkoSession).mockImplementation(async (id, data) =>
        ({ ...(held?.id === id ? held : makeSession({ id })), resumed_at: RESUMED_AT, resume_reason: data.reason }),
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

    // ----- resumeSession: 指静脈の本人確認を待ち、通ってから self-resume して続きへ (業務前 十三) -----

    /** 再開を選ぶ。サーバー(モック)は、選んだ行の status のまま「再開済みにした行」を返す */
    async function resume(k: ReturnType<typeof useTenkoKiosk>, row: TenkoSession) {
      held = row
      await k.resumeSession(row)
    }

    /** 指静脈で本人と分かった (TenkoKiosk が onEmployee から渡す形) */
    const VEIN_OK = { verified: true, similarity: 0, skipped: true } as const

    it('★ 再開を選んでも、本人確認(指静脈)が通るまでサーバーへ何も言わない', async () => {
      const stuck = makeSession({ id: 'sess-stuck', status: 'medical_pending' })
      const k = useTenkoKiosk({ allowResume: true })
      await resume(k, stuck)

      expect(k.step.value).toBe('face_auth')
      expect(k.pendingResume.value?.id).toBe('sess-stuck')
      expect(selfResumeTenkoSession).not.toHaveBeenCalled()
      expect(startTenkoSession).not.toHaveBeenCalled()
      expect(k.isLoading.value).toBe(false)
    })

    it('★ 本人確認が通っていない結果(verified:false)では再開しない', async () => {
      const k = useTenkoKiosk({ allowResume: true })
      await resume(k, makeSession({ status: 'medical_pending' }))
      await k.onFaceAuthComplete({ verified: false, similarity: 0 })

      expect(selfResumeTenkoSession).not.toHaveBeenCalled()
      expect(k.step.value).toBe('face_auth')
      expect(k.pendingResume.value).not.toBeNull()
    })

    it.each([
      ['identity_verified', 'alcohol'],
      ['medical_pending', 'medical'],
      ['self_declaration_pending', 'self_declaration'],
      ['daily_inspection_pending', 'daily_inspection'],
      ['carrying_items_pending', 'carrying_items'],
    ] as const)('★ %s のセッションは本人確認の後 self-resume して %s から続く', async (status, expected) => {
      const stuck = makeSession({ id: 'sess-stuck', status })
      const k = useTenkoKiosk({ allowResume: true })
      await resume(k, stuck)
      await k.onFaceAuthComplete(VEIN_OK)

      // サーバが返した「再開済みにした行」を載せる (Refs ippoan/alc-app#351)
      expect(k.session.value?.id).toBe('sess-stuck')
      expect(k.session.value?.resumed_at).toBe(RESUMED_AT)
      expect(k.step.value).toBe(expected)
      expect(k.error.value).toBeNull()
      expect(k.pendingResume.value).toBeNull()
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
      await resume(k, stuck)

      expect(k.selectedSchedule.value).toStrictEqual(sched)
    })

    it('予定が消費済みで拾えなくても続きへ進む (指示は出ないだけ)。予定の無い業務前でも再開の本人確認は通る', async () => {
      const stuck = makeSession({ status: 'medical_pending', schedule_id: 'sched-gone' })
      const k = useTenkoKiosk({ allowResume: true })
      await resume(k, stuck)
      await k.onFaceAuthComplete(VEIN_OK)

      expect(k.selectedSchedule.value).toBeNull()
      expect(k.step.value).toBe('medical')
    })

    // ----- 再開した時刻をサーバに残す (Refs ippoan/alc-app#351) -----

    /** サーバの 400 (`{"error": …, "message": …}`) と同じ形の失敗 */
    function badRequest(code: string, message: string): Error {
      return Object.assign(
        new Error(`API エラー (400): ${JSON.stringify({ error: code, message })}`),
        { status: 400 },
      )
    }

    it('★ 理由は指静脈で本人確認済みと書く (実際の確認方法と食い違わない)', () => {
      expect(KIOSK_SELF_RESUME_REASON).toContain('指静脈')
      expect(KIOSK_SELF_RESUME_REASON).not.toContain('顔認証')
    })

    it('★ 本人確認の後に self-resume を 1 回だけ、固定の理由 1 つだけを添えて呼ぶ', async () => {
      const stuck = makeSession({ id: 'sess-stuck', status: 'medical_pending', started_at: '2026-03-31T15:12:26Z' })
      const k = useTenkoKiosk({ allowResume: true })

      await resume(k, stuck)
      await k.onFaceAuthComplete(VEIN_OK)

      expect(selfResumeTenkoSession).toHaveBeenCalledTimes(1)
      expect(selfResumeTenkoSession).toHaveBeenCalledWith('sess-stuck', { reason: KIOSK_SELF_RESUME_REASON })
      // `started_at` は送らない — 記録は書き換えず、再開の事実を足す
      expect(Object.keys(vi.mocked(selfResumeTenkoSession).mock.calls[0]![1])).toEqual(['reason'])
      expect(k.step.value).toBe('medical')
    })

    it('★ 管理者が再開済みのセッションも self-resume を呼んで続く (already_resumed で止めない)', async () => {
      const managerResumed = makeSession({
        id: 'sess-mgr', status: 'daily_inspection_pending',
        resumed_at: RESUMED_AT, resume_reason: '管理者の再開', resumed_by_name: '運行管理者',
      })
      vi.mocked(selfResumeTenkoSession).mockResolvedValue(managerResumed)
      const k = useTenkoKiosk({ allowResume: true })

      await resume(k, managerResumed)
      await k.onFaceAuthComplete(VEIN_OK)

      expect(selfResumeTenkoSession).toHaveBeenCalledTimes(1)
      expect(k.session.value?.resume_reason).toBe('管理者の再開')
      expect(k.step.value).toBe('daily_inspection')
      expect(k.error.value).toBeNull()
    })

    it('★ session_not_resumable は理由の分かる文言を出して最初の画面へ戻す', async () => {
      vi.mocked(selfResumeTenkoSession).mockRejectedValue(
        badRequest('session_not_resumable', 'この点呼は再開できません。新しく点呼をやり直してください'),
      )
      const stuck = makeSession({ status: 'medical_pending' })

      const k = useTenkoKiosk({ allowResume: true })
      await resume(k, stuck)
      await k.onFaceAuthComplete(VEIN_OK)

      expect(k.error.value).toBe(SESSION_NOT_RESUMABLE_MESSAGE)
      expect(k.error.value).toContain('やり直して')
      expect(k.step.value).toBe('nfc')
      expect(k.session.value).toBeNull()
      expect(k.pendingResume.value).toBeNull()
    })

    it('★ 通信が落ちたときは続きへ通さない — 本人確認の段に留めて、もう一度置かせる', async () => {
      vi.mocked(selfResumeTenkoSession).mockRejectedValueOnce(new Error('Failed to fetch'))
      const stuck = makeSession({ status: 'medical_pending' })

      const k = useTenkoKiosk({ allowResume: true })
      await k.identifyEmployee('emp-1', '田中')
      await resume(k, stuck)
      await k.onFaceAuthComplete(VEIN_OK)

      // 黙って通すと #351 の症状 (実施時刻の残らない点呼) をそのまま作ってしまう
      expect(k.step.value).toBe('face_auth')
      expect(k.error.value).toBe('Failed to fetch')
      expect(k.pendingResume.value?.id).toBe(stuck.id)
      expect(k.employeeId.value).toBe('emp-1')
      // 通信の失敗は故障として残す
      expect(reportApiFailure).toHaveBeenCalledWith(expect.any(Error), '点呼の再開', expect.objectContaining({ sessionId: stuck.id }))

      await k.onFaceAuthComplete(VEIN_OK)

      expect(k.error.value).toBeNull()
      expect(k.step.value).toBe('medical')
    })

    it('Error でないもので落ちても文言を出す (無言で止めない)', async () => {
      vi.mocked(selfResumeTenkoSession).mockRejectedValue('boom')
      const k = useTenkoKiosk({ allowResume: true })
      await resume(k, makeSession({ status: 'medical_pending' }))
      await k.onFaceAuthComplete(VEIN_OK)

      expect(k.error.value).toBe('点呼の再開に失敗しました')
      expect(k.step.value).toBe('face_auth')
    })

    // ----- 測定の有効時間 (業務前 八) -----

    it('★ 再開したら有効時間切れで medical_pending に戻された → 体温・血圧の測り直しの段へ、理由つき', async () => {
      const stuck = makeSession({ id: 'sess-stuck', status: 'daily_inspection_pending' })
      vi.mocked(selfResumeTenkoSession).mockResolvedValue(
        makeSession({ id: 'sess-stuck', status: 'medical_pending', resumed_at: RESUMED_AT }),
      )
      const k = useTenkoKiosk({ allowResume: true })
      await resume(k, stuck)
      await k.onFaceAuthComplete(VEIN_OK)

      expect(k.step.value).toBe('medical')
      expect(k.error.value).toBe(MEDICAL_EXPIRED_MESSAGE)
    })

    it('もともと medical_pending の再開では、有効時間切れの案内は出さない', async () => {
      const k = useTenkoKiosk({ allowResume: true })
      await resume(k, makeSession({ status: 'medical_pending' }))
      await k.onFaceAuthComplete(VEIN_OK)

      expect(k.step.value).toBe('medical')
      expect(k.error.value).toBeNull()
    })

    it('★ 管理者が再開済みでも候補に出す (resumed_at で落とさない)', async () => {
      serveByStatus([
        makeSession({ id: 'resumed', status: 'daily_inspection_pending', resumed_at: RESUMED_AT }),
        makeSession({ id: 'fresh', status: 'medical_pending' }),
      ])

      const k = useTenkoKiosk({ allowResume: true })
      await k.identifyEmployee('emp-1', '田中')

      expect(k.resumableSessions.value.map(s => s.id).sort()).toEqual(['fresh', 'resumed'])
    })

    it('アルコール測定済みの行は、再開済みかどうかに関わらず候補に出さない', async () => {
      serveByStatus([
        makeSession({ id: 'tested', status: 'medical_pending', alcohol_tested_at: '2026-03-31T00:00:00Z' }),
      ])

      const k = useTenkoKiosk({ allowResume: true })
      await k.identifyEmployee('emp-1', '田中')

      expect(k.resumableSessions.value).toEqual([])
    })

    it('reset() で待っている再開が残らない', async () => {
      const k = useTenkoKiosk({ allowResume: true })
      await resume(k, makeSession({ status: 'medical_pending' }))
      expect(k.pendingResume.value).not.toBeNull()
      k.reset()
      expect(k.pendingResume.value).toBeNull()
    })
  })

  // ---------- 車両番号の段 (自己点検表 業務前 二十 ハ) ----------

  describe('車両番号の段', () => {
    /** サーバの 400 と同じ形 */
    function badRequest(code: string, message: string): Error {
      return Object.assign(
        new Error(`API エラー (400): ${JSON.stringify({ error: code, message })}`),
        { status: 400 },
      )
    }
    const noVehicle = { vehicle_number: null, vehicle_number_source: null } as const

    async function startWith(started: TenkoSession, schedule = makeSchedule()) {
      vi.mocked(startTenkoSession).mockResolvedValue(started)
      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = schedule
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })
      return k
    }

    it('★ 段の名前と並びに「車両番号」が本人確認の直後に入り、他の段の順序は変わらない', () => {
      const pre = useTenkoKiosk()
      pre.selectedSchedule.value = makeSchedule({ tenko_type: 'pre_operation' })
      expect(pre.stepKeys.value).toEqual([
        'nfc', 'schedule_select', 'face_auth', 'vehicle', 'medical', 'self_declaration',
        'daily_inspection', 'carrying_items', 'alcohol', 'instruction', 'completed',
      ])
      expect(pre.stepLabels.value).toHaveLength(pre.stepKeys.value.length)
      expect(pre.stepLabels.value[pre.stepKeys.value.indexOf('vehicle')]).toBe('車両番号')

      const post = useTenkoKiosk()
      post.selectedSchedule.value = makeSchedule({ tenko_type: 'post_operation' })
      expect(post.stepKeys.value).toEqual([
        'nfc', 'schedule_select', 'face_auth', 'vehicle', 'alcohol', 'instruction', 'report', 'completed',
      ])
      expect(post.stepLabels.value).toHaveLength(post.stepKeys.value.length)
    })

    it('遠隔点呼 (最初から) には車両番号の段が無い', () => {
      const k = useTenkoKiosk({ remoteMode: true })
      expect(k.stepKeys.value).not.toContain('vehicle')
      expect(k.stepLabels.value).not.toContain('車両番号')
    })

    it('★ 点呼の開始の直後に車両番号の段へ入る (車検証由来でなければ。予定の車両番号が初期値)', async () => {
      const k = await startWith(
        makeSession({ status: 'medical_pending', vehicle_number: '予定の車', vehicle_number_source: 'schedule' }),
        makeSchedule({ vehicle_number: '予定の車' }),
      )
      expect(k.step.value).toBe('vehicle')
      expect(k.vehicleInput.value).toBe('予定の車')
      expect(k.vehicleManualRequired.value).toBe(false)
    })

    it('予定にも車両番号が無ければ入力欄は空', async () => {
      const k = await startWith(makeSession({ status: 'medical_pending', ...noVehicle }))
      expect(k.step.value).toBe('vehicle')
      expect(k.vehicleInput.value).toBe('')
    })

    it('★ 業務後の開始でも車両番号の段に入る', async () => {
      const k = await startWith(
        makeSession({ tenko_type: 'post_operation', status: 'identity_verified', ...noVehicle }),
        makeSchedule({ tenko_type: 'post_operation' }),
      )
      expect(k.step.value).toBe('vehicle')
    })

    it('★ 車検証から取れた車両番号 (carins) が既にあれば段を飛ばす', async () => {
      const k = await startWith(makeSession({ status: 'medical_pending', vehicle_number: '車検証の車', vehicle_number_source: 'carins' }))
      expect(k.step.value).toBe('medical')
    })

    it('★ 車検証で登録: carins_cert_no を渡し、返ってきた status の段へ進む', async () => {
      const k = await startWith(makeSession({ status: 'medical_pending', ...noVehicle }))
      vi.mocked(updateTenkoSessionVehicle).mockResolvedValue(
        makeSession({ status: 'medical_pending', vehicle_number: '登録番号', vehicle_number_source: 'carins' }),
      )

      await k.onVehicleSubmit({ carins_cert_no: 'CERT-1' })

      expect(updateTenkoSessionVehicle).toHaveBeenCalledWith('sess-1', { carins_cert_no: 'CERT-1' })
      expect(k.session.value?.vehicle_number_source).toBe('carins')
      expect(k.step.value).toBe('medical')
      expect(k.error.value).toBeNull()
      expect(k.isLoading.value).toBe(false)
    })

    it('★ 入力した車両番号で登録: 業務後は alcohol の段へ', async () => {
      const k = await startWith(
        makeSession({ tenko_type: 'post_operation', status: 'identity_verified', ...noVehicle }),
        makeSchedule({ tenko_type: 'post_operation' }),
      )
      vi.mocked(updateTenkoSessionVehicle).mockResolvedValue(
        makeSession({ tenko_type: 'post_operation', status: 'identity_verified', vehicle_number: '手入力', vehicle_number_source: 'manual' }),
      )

      await k.onVehicleSubmit({ vehicle_number: '手入力' })

      expect(updateTenkoSessionVehicle).toHaveBeenCalledWith('sess-1', { vehicle_number: '手入力' })
      expect(k.step.value).toBe('alcohol')
    })

    it('★ 車検証が見つからない (vehicle_required) → サーバーの文言を出し、入力欄を要求する。段は動かない', async () => {
      const k = await startWith(makeSession({ status: 'medical_pending', ...noVehicle }))
      vi.mocked(updateTenkoSessionVehicle).mockRejectedValue(
        badRequest('vehicle_required', '車検証が見つかりません。車両番号を入力してください'),
      )

      await k.onVehicleSubmit({ carins_cert_no: 'NONE' })

      expect(k.step.value).toBe('vehicle')
      expect(k.error.value).toBe('車検証が見つかりません。車両番号を入力してください')
      expect(k.vehicleManualRequired.value).toBe(true)
      // 利用者の入力の不備は故障ではない
      expect(reportApiFailure).not.toHaveBeenCalled()
    })

    it('vehicle_required で文言が読めなくても入力を促す', async () => {
      const k = await startWith(makeSession({ status: 'medical_pending', ...noVehicle }))
      vi.mocked(updateTenkoSessionVehicle).mockRejectedValue(
        new Error(`API エラー (400): ${JSON.stringify({ error: 'vehicle_required' })}`),
      )

      await k.onVehicleSubmit({ carins_cert_no: 'NONE' })

      expect(k.error.value).toBe('車両番号を入力してください')
    })

    it('通信の失敗は画面に出し、故障として記録する (段に留まって押し直せる)', async () => {
      const k = await startWith(makeSession({ status: 'medical_pending', ...noVehicle }))
      const down = new Error('Failed to fetch')
      vi.mocked(updateTenkoSessionVehicle).mockRejectedValue(down)

      await k.onVehicleSubmit({ vehicle_number: 'X' })

      expect(k.step.value).toBe('vehicle')
      expect(k.error.value).toBe('Failed to fetch')
      expect(reportApiFailure).toHaveBeenCalledWith(down, '車両番号の登録', { sessionId: 'sess-1', type: undefined })
    })

    it('Error でない失敗でも文言を出す', async () => {
      const k = await startWith(makeSession({ status: 'medical_pending', ...noVehicle }))
      vi.mocked(updateTenkoSessionVehicle).mockRejectedValue('boom')

      await k.onVehicleSubmit({ vehicle_number: 'X' })

      expect(k.error.value).toBe('車両番号の登録に失敗しました')
    })

    it('session なしでは何もしない', async () => {
      const k = useTenkoKiosk()
      await k.onVehicleSubmit({ vehicle_number: 'X' })
      expect(updateTenkoSessionVehicle).not.toHaveBeenCalled()
    })

    it('★ 再開した点呼に車両番号が無ければ、本人確認の後に車両番号の段を通る(予定の値が初期値)', async () => {
      const sched = makeSchedule({ id: 'sched-1', vehicle_number: '予定の車' })
      vi.mocked(getPendingSchedules).mockResolvedValue([sched])
      const stuck = makeSession({ status: 'daily_inspection_pending', ...noVehicle })
      vi.mocked(selfResumeTenkoSession).mockResolvedValue({ ...stuck, resumed_at: '2026-03-31T23:05:00Z' })
      const k = useTenkoKiosk({ allowResume: true })
      await k.identifyEmployee('emp-1', '田中')
      await k.resumeSession(stuck)
      await k.onFaceAuthComplete({ verified: true, similarity: 0, skipped: true })

      expect(k.step.value).toBe('vehicle')
      expect(k.vehicleInput.value).toBe('予定の車')

      vi.mocked(updateTenkoSessionVehicle).mockResolvedValue({ ...stuck, vehicle_number: '予定の車', vehicle_number_source: 'schedule' })
      await k.onVehicleSubmit({ vehicle_number: '予定の車' })
      expect(k.step.value).toBe('daily_inspection')
    })

    it('再開した点呼に車両番号がある (予定・手入力でも) なら段を飛ばす', async () => {
      const stuck = makeSession({ status: 'daily_inspection_pending', vehicle_number: '手入力の車', vehicle_number_source: 'manual' })
      vi.mocked(selfResumeTenkoSession).mockResolvedValue(stuck)
      const k = useTenkoKiosk({ allowResume: true })
      await k.resumeSession(stuck)
      await k.onFaceAuthComplete({ verified: true, similarity: 0, skipped: true })

      expect(k.step.value).toBe('daily_inspection')
    })

    it('★ 再開で有効時間切れ → 車両番号の段を挟んでも、測り直しの案内は体温・血圧の段で出る', async () => {
      const stuck = makeSession({ status: 'daily_inspection_pending', ...noVehicle })
      vi.mocked(selfResumeTenkoSession).mockResolvedValue({ ...stuck, status: 'medical_pending' })
      const k = useTenkoKiosk({ allowResume: true })
      await k.resumeSession(stuck)
      await k.onFaceAuthComplete({ verified: true, similarity: 0, skipped: true })
      expect(k.step.value).toBe('vehicle')
      expect(k.error.value).toBeNull()

      vi.mocked(updateTenkoSessionVehicle).mockResolvedValue({ ...stuck, status: 'medical_pending', vehicle_number: 'V', vehicle_number_source: 'manual' })
      await k.onVehicleSubmit({ vehicle_number: 'V' })
      expect(k.step.value).toBe('medical')
      expect(k.error.value).toBe(MEDICAL_EXPIRED_MESSAGE)
    })

    it('遠隔点呼(最初から)の開始では車両番号の段を通らない', async () => {
      vi.mocked(startTenkoSession).mockResolvedValue(makeSession({ status: 'medical_pending', ...noVehicle }))
      const k = useTenkoKiosk({ remoteMode: true })
      k.employeeId.value = 'emp-1'
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })
      expect(k.step.value).toBe('medical')
    })

    it('reset() で車両番号の状態が残らない', async () => {
      const k = await startWith(makeSession({ status: 'medical_pending', vehicle_number: '予定の車', vehicle_number_source: 'schedule' }))
      vi.mocked(updateTenkoSessionVehicle).mockRejectedValue(badRequest('vehicle_required', 'x'))
      await k.onVehicleSubmit({ carins_cert_no: 'N' })
      expect(k.vehicleManualRequired.value).toBe(true)

      k.reset()

      expect(k.vehicleInput.value).toBe('')
      expect(k.vehicleManualRequired.value).toBe(false)
    })
  })

  // ---------- 測定の有効時間 (業務前 八) ----------

  describe('測定の有効時間切れ', () => {
    function badRequest(code: string, message: string): Error {
      return Object.assign(
        new Error(`API エラー (400): ${JSON.stringify({ error: code, message })}`),
        { status: 400 },
      )
    }

    it('★ 体温・血圧の送信が measurement_expired → サーバーの文言を出し、体温・血圧の段に留まる(故障にしない)', async () => {
      vi.mocked(submitMedical).mockRejectedValue(
        badRequest('measurement_expired', '測定から有効時間 (30 分) を過ぎています。もう一度測定してください'),
      )
      const k = useTenkoKiosk()
      k.session.value = makeSession({ status: 'medical_pending' })
      k.step.value = 'medical'

      await k.onMedicalSubmit({ temperature: 36.5, ...BP })

      expect(k.step.value).toBe('medical')
      expect(k.error.value).toBe('測定から有効時間 (30 分) を過ぎています。もう一度測定してください')
      expect(k.isLoading.value).toBe(false)
      expect(reportApiFailure).not.toHaveBeenCalled()
    })

    it('measurement_expired で文言が読めなければ既定の案内', async () => {
      vi.mocked(submitMedical).mockRejectedValue(
        new Error(`API エラー (400): ${JSON.stringify({ error: 'measurement_expired' })}`),
      )
      const k = useTenkoKiosk()
      k.session.value = makeSession({ status: 'medical_pending' })

      await k.onMedicalSubmit({ temperature: 36.5, ...BP })

      expect(k.error.value).toBe(MEDICAL_EXPIRED_MESSAGE)
    })

    it('★ 携行品の後に medical_pending へ戻されたら、体温・血圧の段で理由を出す', async () => {
      vi.mocked(submitCarryingItemChecks).mockResolvedValue(makeSession({ status: 'medical_pending' }))
      const k = useTenkoKiosk()
      k.session.value = makeSession({ status: 'carrying_items_pending' })
      k.step.value = 'carrying_items'

      await k.onCarryingItemsSubmit([])

      expect(k.step.value).toBe('medical')
      expect(k.error.value).toBe(MEDICAL_EXPIRED_MESSAGE)
    })

    it('携行品の後に普通にアルコールの段へ進むときは案内を出さない', async () => {
      vi.mocked(submitCarryingItemChecks).mockResolvedValue(makeSession({ status: 'identity_verified' }))
      const k = useTenkoKiosk()
      k.session.value = makeSession({ status: 'carrying_items_pending' })

      await k.onCarryingItemsSubmit([])

      expect(k.step.value).toBe('alcohol')
      expect(k.error.value).toBeNull()
    })
  })

  // ---------- 故障の自動記録 (機器・保存・通信の失敗だけ) ----------

  describe('故障の自動記録の配線', () => {
    const boom = new Error('boom')

    it('予定の取得の失敗 → 通信の失敗として記録', async () => {
      vi.mocked(getPendingSchedules).mockRejectedValue(boom)
      const k = useTenkoKiosk()
      await k.identifyEmployee('emp-1', '田中')
      expect(reportApiFailure).toHaveBeenCalledWith(boom, '予定の取得', { sessionId: undefined, type: undefined })
    })

    it('点呼の開始の失敗 → 通信の失敗として記録(セッション ID はまだ無い)', async () => {
      vi.mocked(startTenkoSession).mockRejectedValue(boom)
      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9 })
      expect(reportApiFailure).toHaveBeenCalledWith(boom, '点呼の開始', { sessionId: undefined, type: undefined })
    })

    it('★ 顔写真の保存の失敗 → photo_storage_error で記録し、点呼は開始しない', async () => {
      vi.mocked(uploadFacePhoto).mockRejectedValue(boom)
      const k = useTenkoKiosk()
      k.employeeId.value = 'emp-1'
      k.selectedSchedule.value = makeSchedule()
      await k.onFaceAuthComplete({ verified: true, similarity: 0.9, snapshot: new Blob(['x']) })
      expect(reportApiFailure).toHaveBeenCalledWith(boom, '顔写真の保存', { sessionId: undefined, type: 'photo_storage_error' })
      expect(startTenkoSession).not.toHaveBeenCalled()
      expect(k.error.value).toBe('boom')
      expect(k.isLoading.value).toBe(false)
    })

    it('★ アルコール測定の記録の失敗 → measurement_recording_failed', async () => {
      vi.mocked(updateMeasurement).mockRejectedValue(boom)
      const k = useTenkoKiosk()
      k.session.value = makeSession()
      await k.onAlcoholMeasured('m-1', {})
      expect(reportApiFailure).toHaveBeenCalledWith(boom, 'アルコール測定の記録', { sessionId: 'sess-1', type: 'measurement_recording_failed' })
    })

    it('★ 体温・血圧の記録の失敗 → measurement_recording_failed', async () => {
      vi.mocked(submitMedical).mockRejectedValue(boom)
      const k = useTenkoKiosk()
      k.session.value = makeSession()
      await k.onMedicalSubmit({ temperature: 36.5, ...BP })
      expect(reportApiFailure).toHaveBeenCalledWith(boom, '体温・血圧の記録', { sessionId: 'sess-1', type: 'measurement_recording_failed' })
    })

    it.each([
      ['自己申告の送信', (k: ReturnType<typeof useTenkoKiosk>) => { vi.mocked(submitSelfDeclaration).mockRejectedValue(boom); return k.onSelfDeclarationSubmit({ illness: false, fatigue: false, sleep_deprivation: false }) }],
      ['日常点検の送信', (k: ReturnType<typeof useTenkoKiosk>) => { vi.mocked(submitDailyInspection).mockRejectedValue(boom); return k.onDailyInspectionSubmit({} as never) }],
      ['携行品チェックの送信', (k: ReturnType<typeof useTenkoKiosk>) => { vi.mocked(submitCarryingItemChecks).mockRejectedValue(boom); return k.onCarryingItemsSubmit([]) }],
      ['指示確認の送信', (k: ReturnType<typeof useTenkoKiosk>) => { vi.mocked(confirmInstruction).mockRejectedValue(boom); return k.onInstructionConfirm() }],
      ['運行報告の送信', (k: ReturnType<typeof useTenkoKiosk>) => { vi.mocked(submitReport).mockRejectedValue(boom); return k.onReportSubmit({} as never) }],
      ['点呼の中止の送信', (k: ReturnType<typeof useTenkoKiosk>) => { vi.mocked(cancelTenkoSession).mockRejectedValue(boom); return k.cancel('理由') }],
    ] as const)('%s の失敗 → 通信の失敗として記録', async (what, run) => {
      const k = useTenkoKiosk()
      k.session.value = makeSession()
      await run(k)
      expect(reportApiFailure).toHaveBeenCalledWith(boom, what, { sessionId: 'sess-1', type: undefined })
    })
  })
})
