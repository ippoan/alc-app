import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import TenkoKiosk from '~/components/TenkoKiosk.vue'
import type { TenkoSchedule, TenkoSession } from '~/types'

// 血圧を必須にすると血圧計が壊れた日に全車が出庫できなくなるため、測れないときは
// 運行管理者が遠隔で対応する経路へ移す (Refs ippoan/alc-app-s3#135)。
//
// ここは **useTenkoKiosk を本物のまま**使う。見たいのが「段の数が変わらない」
// 「セッションが二重にならない」という composable と画面の**配線**そのものだから。
// (他の TenkoKiosk テストは composable を mock して画面側だけを見ている)

// --- 実機・ネットワーク依存だけを差し替える ---
const getPendingSchedules = vi.fn()
const startTenkoSession = vi.fn()
const escalateTenkoSessionToRemote = vi.fn()
const getEmployeeByNfcId = vi.fn()

vi.mock('~/utils/api', () => ({
  getEmployeeByNfcId: (...args: unknown[]) => getEmployeeByNfcId(...args),
  getEmployeeByCode: vi.fn(),
  getPendingSchedules: (...args: unknown[]) => getPendingSchedules(...args),
  startTenkoSession: (...args: unknown[]) => startTenkoSession(...args),
  escalateTenkoSessionToRemote: (...args: unknown[]) => escalateTenkoSessionToRemote(...args),
  submitAlcohol: vi.fn(),
  submitMedical: vi.fn(),
  submitSelfDeclaration: vi.fn(),
  submitDailyInspection: vi.fn(),
  confirmInstruction: vi.fn(),
  submitReport: vi.fn(),
  cancelTenkoSession: vi.fn(),
  uploadFacePhoto: vi.fn(),
  getCarryingItems: vi.fn(async () => []),
  submitCarryingItemChecks: vi.fn(),
}))

const webRtcConnect = vi.fn(async () => {})
const webRtcDisconnect = vi.fn()
mockNuxtImport('useWebRtc', () => () => ({
  isConnected: ref(false),
  isPeerConnected: ref(false),
  remoteStream: ref(null),
  error: ref(null),
  connect: webRtcConnect,
  startStreaming: vi.fn(async () => {}),
  disconnect: webRtcDisconnect,
}))

const cameraStart = vi.fn(async () => {})
mockNuxtImport('useCamera', () => () => ({
  stream: ref(null), videoRef: ref(null), isActive: ref(false),
  start: cameraStart, stop: vi.fn(),
}))

mockNuxtImport('useFaceSync', () => () => ({ isSyncing: ref(false), sync: vi.fn(async () => {}) }))
mockNuxtImport('useDemoMode', () => () => ({ isDemoMode: ref(false) }))
mockNuxtImport('useBleGateway', () => () => ({ latestTemperature: ref(null), latestBloodPressure: ref(null) }))
mockNuxtImport('useFingerprint', () => () => ({
  isFingerprintAvailable: ref(false),
  isEmployeeAuthorized: vi.fn(() => false),
  authorizeEmployee: vi.fn(),
  requestFingerprint: vi.fn(),
}))
// 血圧計を使う端末 = 切り替えボタンが出る条件
mockNuxtImport('useBloodPressureSetting', () => () => ({ bpEnabled: ref(true), setBpEnabled: vi.fn() }))
mockNuxtImport('useCoreS3Stage', () => () => ({ syncStep: vi.fn(), sendResult: vi.fn() }))

// --- 合成データ (実在の乗務員・カード番号は書かない) ---
const EMPLOYEE = { id: 'emp-test-1', name: 'テスト太郎', face_approval_status: 'approved' }
const SESSION_ID = 'sess-test-1'

function makeSchedule(): TenkoSchedule {
  return {
    id: 'sched-test-1', tenant_id: 't-1', employee_id: EMPLOYEE.id,
    tenko_type: 'pre_operation', responsible_manager_name: '管理者',
    scheduled_at: '2026-09-16T08:00:00Z', instruction: null,
    consumed: false, consumed_by_session_id: null, overdue_notified_at: null,
    created_at: '2026-09-16T00:00:00Z', updated_at: '2026-09-16T00:00:00Z',
  }
}

function makeSession(): TenkoSession {
  return {
    id: SESSION_ID, tenant_id: 't-1', employee_id: EMPLOYEE.id, schedule_id: 'sched-test-1',
    tenko_type: 'pre_operation', status: 'medical_pending',
    identity_verified_at: null, identity_face_photo_url: null,
    measurement_id: null, alcohol_result: null, alcohol_value: null,
    alcohol_tested_at: null, alcohol_face_photo_url: null,
    temperature: null, systolic: null, diastolic: null, pulse: null,
    medical_measured_at: null, medical_manual_input: null,
    instruction_confirmed_at: null,
    report_vehicle_road_status: null, report_driver_alternation: null,
    report_no_report: null, report_submitted_at: null,
    location: null, responsible_manager_name: null, cancel_reason: null,
    interrupted_at: null, resumed_at: null, resume_reason: null, resumed_by_user_id: null,
    self_declaration: null, safety_judgment: null, daily_inspection: null,
    carrying_items_checked: null,
    started_at: null, completed_at: null,
    created_at: '2026-09-16T00:00:00Z', updated_at: '2026-09-16T00:00:00Z',
    carins_cert_no: null, carins_vehicle_id: null,
    carins_expires_on: null, carins_matched_by: null,
  }
}

/** 非同期の watch コールバックが落ち着くまで待つ */
async function settle(wrapper: { vm: { $nextTick: () => Promise<void> } }) {
  for (let i = 0; i < 5; i++) {
    await wrapper.vm.$nextTick()
    await Promise.resolve()
  }
}

/** ステップバーの段 (ラベル入りのチップ) */
function stepChips(wrapper: ReturnType<typeof mountSuspended> extends Promise<infer W> ? W : never) {
  return wrapper.findAll('div.whitespace-nowrap')
}
function stepLabelsOf(wrapper: Parameters<typeof stepChips>[0]) {
  return stepChips(wrapper).map(c => c.text())
}
/** いま光っている段 (= 現在地) */
function currentStepOf(wrapper: Parameters<typeof stepChips>[0]) {
  return stepChips(wrapper).findIndex(c => c.classes().includes('bg-blue-600'))
}

function escalateButton(wrapper: Parameters<typeof stepChips>[0]) {
  return wrapper.findAll('button').find(b => b.text() === '遠隔点呼に切り替える')
}

/** 自動点呼を血圧の段まで進める */
async function mountAtMedicalStep(props: { remoteMode?: boolean } = {}) {
  const wrapper = await mountSuspended(TenkoKiosk, {
    shallow: true,
    props,
    // 遠隔点呼バナーは <ClientOnly> の中。shallow だと中身ごと消えるので、
    // スロットをそのまま出すスタブに差し替えて文言を見えるようにする
    global: { stubs: { ClientOnly: { template: '<div><slot /></div>' } } },
  })

  wrapper.findComponent({ name: 'NfcStatus' }).vm.$emit('read', 'nfc-test-1')
  await settle(wrapper)

  // 自動点呼は予定選択を挟む。遠隔点呼は挟まない
  if (!props.remoteMode) {
    wrapper.findComponent({ name: 'TenkoScheduleSelect' }).vm.$emit('select', makeSchedule())
    await settle(wrapper)
  }

  wrapper.findComponent({ name: 'FaceAuth' }).vm.$emit('result', { verified: true, similarity: 1 })
  await settle(wrapper)

  return wrapper
}

describe('TenkoKiosk — 血圧が測れないとき遠隔点呼に切り替える (Refs ippoan/alc-app-s3#135)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getEmployeeByNfcId.mockResolvedValue(EMPLOYEE)
    getPendingSchedules.mockResolvedValue([makeSchedule()])
    startTenkoSession.mockResolvedValue(makeSession())
    escalateTenkoSessionToRemote.mockResolvedValue({ ...makeSession(), escalated_to_remote_at: '2026-09-16T08:05:00Z' })
  })

  it('遠隔に切り替えると映像が繋がる', async () => {
    const wrapper = await mountAtMedicalStep()
    // 血圧の段では、自動点呼のあいだは繋がない
    expect(webRtcConnect).not.toHaveBeenCalled()

    await escalateButton(wrapper)!.trigger('click')
    await settle(wrapper)

    // 部屋の登録は接続時なので、繋がないと運行管理者の一覧に出てこない
    expect(cameraStart).toHaveBeenCalled()
    expect(webRtcConnect).toHaveBeenCalledTimes(1)
    expect(webRtcConnect.mock.calls[0]![1]).toBe(SESSION_ID)
    wrapper.unmount()
  })

  it('遠隔に切り替えても段の数が変わらない', async () => {
    const wrapper = await mountAtMedicalStep()
    const labelsBefore = stepLabelsOf(wrapper)
    const currentBefore = currentStepOf(wrapper)
    expect(labelsBefore).toContain('予定選択')
    expect(currentBefore).toBeGreaterThanOrEqual(0)

    await escalateButton(wrapper)!.trigger('click')
    await settle(wrapper)

    // 段の一覧は setup 時の remoteMode で固定 → 数もラベルも現在地も動かない
    expect(stepLabelsOf(wrapper)).toEqual(labelsBefore)
    expect(currentStepOf(wrapper)).toBe(currentBefore)
    wrapper.unmount()
  })

  it('遠隔に切り替えてもセッションは 1 つのまま', async () => {
    const wrapper = await mountAtMedicalStep()
    expect(startTenkoSession).toHaveBeenCalledTimes(1)

    await escalateButton(wrapper)!.trigger('click')
    await settle(wrapper)

    // 新しい点呼を起こさず、同じ id のまま切り替える
    expect(startTenkoSession).toHaveBeenCalledTimes(1)
    expect(escalateTenkoSessionToRemote).toHaveBeenCalledTimes(1)
    expect(escalateTenkoSessionToRemote.mock.calls[0]![0]).toBe(SESSION_ID)
    wrapper.unmount()
  })

  it('サーバへの通知が失敗しても遠隔の画面に入れる', async () => {
    // サーバ側の口は別 PR。まだ無い (404) 想定
    escalateTenkoSessionToRemote.mockRejectedValue(new Error('API エラー (404)'))
    const wrapper = await mountAtMedicalStep()

    await escalateButton(wrapper)!.trigger('click')
    await settle(wrapper)

    expect(wrapper.text()).toContain('血圧が測れないため遠隔点呼に切り替えました')
    expect(webRtcConnect).toHaveBeenCalledTimes(1)
    // 切り替え済みなのでボタンは消える (二度押しで二重に切り替わらない)
    expect(escalateButton(wrapper)).toBeUndefined()
    wrapper.unmount()
  })

  it('最初から遠隔のときは従来どおり動く', async () => {
    const wrapper = await mountAtMedicalStep({ remoteMode: true })

    // 予定選択を挟まない段の一覧 (従来どおり)
    expect(stepLabelsOf(wrapper)).not.toContain('予定選択')
    expect(getPendingSchedules).not.toHaveBeenCalled()
    // 従来の遠隔点呼バナー (切替の文言ではない)
    expect(wrapper.text()).toContain('遠隔点呼モード — 運行管理者がビデオ通話で確認しています')
    // 切り替えボタンは出ない
    expect(escalateButton(wrapper)).toBeUndefined()
    // 映像は従来どおり自動で繋がる
    expect(webRtcConnect).toHaveBeenCalledTimes(1)
    expect(escalateTenkoSessionToRemote).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
