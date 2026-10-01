import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import TenkoItAdminView from '~/components/TenkoItAdminView.vue'
import TenkoManagerJudgmentPanel from '~/components/TenkoManagerJudgmentPanel.vue'
import { IT_TENKO_POLL_INTERVAL_MS } from '~/composables/useItTenkoCall'

// 運行管理者側の IT点呼 の受け画面 (Refs ippoan/alc-app#387)。
// 遠隔点呼とは別物: 社員番号で運行管理者を特定 (顔認証なし) → 通話 → 判定。
// 着信は `it-` で始まる部屋だけ、通話が成立しなかった分は「未完了の IT点呼」の一覧から確定する。

// --- API のモック ---

const getEmployeeByCodeMock = vi.fn()
const getEmployeesMock = vi.fn()
const getTenkoSessionMock = vi.fn()
const listTenkoSessionsMock = vi.fn()
const getMeasurementMock = vi.fn()

vi.mock('~/utils/api', () => ({
  getEmployeeByCode: (...args: unknown[]) => getEmployeeByCodeMock(...args),
  getEmployees: (...args: unknown[]) => getEmployeesMock(...args),
  getTenkoSession: (...args: unknown[]) => getTenkoSessionMock(...args),
  listTenkoSessions: (...args: unknown[]) => listTenkoSessionsMock(...args),
  getMeasurement: (...args: unknown[]) => getMeasurementMock(...args),
  submitManagerJudgment: vi.fn(),
  getDriverInfo: vi.fn(async () => null),
}))

// --- composable のモック ---

const activeRoomsRef = ref<string[]>([])
const startWatchingMock = vi.fn()
const stopWatchingMock = vi.fn()
const setJoinedMock = vi.fn()
const reloadRoomsMock = vi.fn(async () => true)
mockNuxtImport('useActiveRooms', () => () => ({
  activeRooms: activeRoomsRef,
  start: startWatchingMock,
  stop: stopWatchingMock,
  setJoined: setJoinedMock,
  reload: reloadRoomsMock,
}))

const connectMock = vi.fn(async (..._args: unknown[]) => {})
const startStreamingMock = vi.fn(async () => {})
const disconnectMock = vi.fn()
mockNuxtImport('useWebRtc', () => (role: string) => {
  webRtcRoles.push(role)
  return {
    isConnected: ref(false),
    isPeerConnected: ref(false),
    remoteStream: ref(null),
    error: ref(null),
    connect: connectMock,
    startStreaming: startStreamingMock,
    disconnect: disconnectMock,
  }
})
const webRtcRoles: string[] = []

const cameraStartMock = vi.fn(async () => {})
const cameraStopMock = vi.fn()
mockNuxtImport('useCamera', () => () => ({
  stream: ref(null),
  videoRef: ref(null),
  isActive: ref(false),
  start: cameraStartMock,
  stop: cameraStopMock,
}))

const managerIdRef = ref<string | null>(null)
const setManagerIdMock = vi.fn((id: string | null) => { managerIdRef.value = id })
const loadFromDeviceMock = vi.fn()
mockNuxtImport('useManagerAuth', () => () => ({
  authenticatedManagerId: managerIdRef,
  setManagerId: setManagerIdMock,
  loadFromDevice: loadFromDeviceMock,
}))

// --- データ ---

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function makeSession(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, tenant_id: 't-1', employee_id: 'emp-1', tenko_type: 'normal', status: 'completed',
    tenko_method: 'IT点呼',
    alcohol_result: 'normal', alcohol_value: 0, temperature: 36.5, systolic: 120, diastolic: 80,
    started_at: '2026-09-30T23:00:00Z', created_at: '2026-09-30T22:59:00Z',
    manager_judgment: null, manager_judgment_reason: null, manager_judgment_by: null,
    manager_judgment_method: null,
    ...overrides,
  }
}

const EMPLOYEES = [
  { id: 'emp-1', name: '山田 太郎', role: ['driver'] },
  { id: 'emp-2', name: '佐藤 花子', role: ['driver'] },
]

type Wrapper = Awaited<ReturnType<typeof mountView>>

async function mountView() {
  const wrapper = await mountSuspended(TenkoItAdminView, {
    global: {
      stubs: {
        TenkoVideoCall: { template: '<div data-testid="video-call" />' },
        TenkoDriverInfoPanel: { template: '<div data-testid="driver-info" />' },
      },
    },
  })
  await flush()
  await wrapper.vm.$nextTick()
  return wrapper
}

const incoming = (w: Wrapper) => w.find('[data-testid="it-incoming"]')
const pendingRows = (w: Wrapper) => w.findAll('[data-testid="it-pending-row"]')
const idModal = (w: Wrapper) => w.find('[data-testid="it-manager-id"]')
const panel = (w: Wrapper) => w.findComponent(TenkoManagerJudgmentPanel)

async function click(el: { trigger: (e: string) => Promise<unknown> }, w: Wrapper) {
  await el.trigger('click')
  await flush()
  await w.vm.$nextTick()
}

async function submitManagerCode(w: Wrapper, code: string) {
  await idModal(w).find('input').setValue(code)
  await click(idModal(w).findAll('button').find(b => b.text() === '次へ')!, w)
}

beforeEach(() => {
  vi.clearAllMocks()
  webRtcRoles.length = 0
  activeRoomsRef.value = []
  managerIdRef.value = 'mgr-1'
  connectMock.mockImplementation(async () => {})
  reloadRoomsMock.mockImplementation(async () => true)
  getEmployeesMock.mockResolvedValue(EMPLOYEES)
  listTenkoSessionsMock.mockResolvedValue({ sessions: [], total: 0, page: 1, per_page: 50 })
  getTenkoSessionMock.mockImplementation(async (id: string) => makeSession(id))
  // マイクは断られたことにする (映像だけで続ける経路。MediaStream を組まずに済む)
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn(async () => { throw new Error('denied') }) },
    configurable: true,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TenkoItAdminView — 一覧', () => {
  it('部屋の監視は mount で 1 回始め、unmount で 1 回だけ止める (参照カウントを余分に減らさない)', async () => {
    const w = await mountView()
    expect(startWatchingMock).toHaveBeenCalledTimes(1)
    expect(stopWatchingMock).not.toHaveBeenCalled()
    w.unmount()
    expect(startWatchingMock).toHaveBeenCalledTimes(1)
    expect(stopWatchingMock).toHaveBeenCalledTimes(1)
  })

  it('着信の一覧には it- で始まる部屋だけが出る', async () => {
    activeRoomsRef.value = ['session-9', 'it-session-1', 'screen-abc', 'it-']
    const w = await mountView()
    const buttons = incoming(w).findAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.text()).toBe('通話する')
    expect(incoming(w).text()).toContain('it-session-1')
    expect(incoming(w).text()).not.toContain('session-9')
    expect(incoming(w).text()).not.toContain('screen-abc')
    expect(incoming(w).text()).toContain('(1件)')
    w.unmount()
  })

  it('着信が無ければその旨を出す', async () => {
    activeRoomsRef.value = ['session-9']
    const w = await mountView()
    expect(incoming(w).findAll('button')).toHaveLength(0)
    expect(incoming(w).text()).toContain('通話を待っている IT点呼 はありません')
    w.unmount()
  })

  it('未完了の一覧は IT点呼 + 判定未確定の filter と tenko-monitor の口で引く', async () => {
    const w = await mountView()
    expect(listTenkoSessionsMock).toHaveBeenCalledWith(
      { tenko_method: 'IT点呼', judgment_pending: true, per_page: 50 },
      'tenko-monitor',
    )
    expect(getEmployeesMock).toHaveBeenCalledWith('tenko-monitor')
    expect(w.text()).toContain('未完了の IT点呼 はありません')
    w.unmount()
  })

  it('未完了の行: 乗務員名を出し、部屋が在る行にだけ「通話中」と「通話する」', async () => {
    activeRoomsRef.value = ['it-session-1', 'session-2']
    listTenkoSessionsMock.mockResolvedValue({
      sessions: [makeSession('session-1'), makeSession('session-2', { employee_id: 'emp-2' })],
      total: 2, page: 1, per_page: 50,
    })
    const w = await mountView()
    const rows = pendingRows(w)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('山田 太郎')
    expect(rows[0]!.text()).toContain('通話中')
    expect(rows[0]!.find('button').text()).toBe('通話する')
    // 遠隔点呼の部屋 (記録の id そのまま) は IT点呼 の通話ではない
    expect(rows[1]!.text()).toContain('佐藤 花子')
    expect(rows[1]!.text()).not.toContain('通話中')
    expect(rows[1]!.find('button').text()).toBe('通話なしで確定する')
    // 着信の行にも、未完了の一覧に在る記録なら乗務員名が出る
    expect(incoming(w).text()).toContain('山田 太郎')
    w.unmount()
  })

  it('乗務員の名前が引けなくても一覧は出す', async () => {
    getEmployeesMock.mockRejectedValue(new Error('API エラー (403)'))
    listTenkoSessionsMock.mockResolvedValue({ sessions: [makeSession('session-1')], total: 1, page: 1, per_page: 50 })
    const w = await mountView()
    expect(pendingRows(w)).toHaveLength(1)
    expect(pendingRows(w)[0]!.text()).toContain('emp-1')
    w.unmount()
  })

  it('一覧の取得に失敗したらエラー文を出す (backend が出る前の 403 等)', async () => {
    listTenkoSessionsMock.mockRejectedValue(new Error('API エラー (403)'))
    const w = await mountView()
    expect(w.text()).toContain('未完了の IT点呼 の取得に失敗しました')
    expect(pendingRows(w)).toHaveLength(0)
    w.unmount()
  })

  it('「更新」と部屋の増減で未完了の一覧を取り直す (周期の取得はしない)', async () => {
    const w = await mountView()
    expect(listTenkoSessionsMock).toHaveBeenCalledTimes(1)
    expect(reloadRoomsMock).toHaveBeenCalledTimes(1)

    await click(w.findAll('button').find(b => b.text() === '更新')!, w)
    expect(listTenkoSessionsMock).toHaveBeenCalledTimes(2)
    expect(reloadRoomsMock).toHaveBeenCalledTimes(2)

    activeRoomsRef.value = ['it-session-1']
    await flush()
    expect(listTenkoSessionsMock).toHaveBeenCalledTimes(3)
    w.unmount()
  })

  it('取り直しが重なったら、後から始めた方の結果を採る', async () => {
    let resolveFirst!: (v: unknown) => void
    listTenkoSessionsMock.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
    const w = await mountView()
    // 1 回目が返る前に部屋が増えて、2 回目が始まる (取得中は「更新」は押せない)
    expect(w.findAll('button').find(b => b.text() === '更新')!.attributes('disabled')).toBeDefined()
    listTenkoSessionsMock.mockResolvedValue({ sessions: [makeSession('session-2')], total: 1, page: 1, per_page: 50 })
    activeRoomsRef.value = ['it-session-2']
    await flush()
    await w.vm.$nextTick()
    expect(pendingRows(w)).toHaveLength(1)

    resolveFirst({ sessions: [], total: 0, page: 1, per_page: 50 })
    await flush()
    await w.vm.$nextTick()
    expect(pendingRows(w)).toHaveLength(1)
    w.unmount()
  })
})

describe('TenkoItAdminView — 運行管理者の特定 (社員番号だけ)', () => {
  beforeEach(() => {
    managerIdRef.value = null
    activeRoomsRef.value = ['it-session-1']
  })

  it('運行管理者が特定済みなら社員番号を聞かずに進む (デバイスから読み直す)', async () => {
    managerIdRef.value = 'mgr-1'
    const w = await mountView()
    await click(incoming(w).find('button'), w)
    expect(loadFromDeviceMock).toHaveBeenCalled()
    expect(idModal(w).exists()).toBe(false)
    expect(getEmployeeByCodeMock).not.toHaveBeenCalled()
    expect(connectMock).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('未特定なら社員番号を聞く。manager は通り、そのまま通話へ進む', async () => {
    getEmployeeByCodeMock.mockResolvedValue({ id: 'mgr-2', name: '運行 管理', role: ['manager'] })
    const w = await mountView()
    await click(incoming(w).find('button'), w)
    expect(idModal(w).exists()).toBe(true)
    expect(connectMock).not.toHaveBeenCalled()

    await submitManagerCode(w, ' 001 ')
    expect(getEmployeeByCodeMock).toHaveBeenCalledWith('001', 'tenko-monitor')
    expect(setManagerIdMock).toHaveBeenCalledWith('mgr-2')
    expect(idModal(w).exists()).toBe(false)
    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(connectMock.mock.calls[0]![1]).toBe('it-session-1')
    w.unmount()
  })

  it('admin も通る', async () => {
    getEmployeeByCodeMock.mockResolvedValue({ id: 'adm-1', name: '管理 者', role: ['admin'] })
    const w = await mountView()
    await click(incoming(w).find('button'), w)
    await submitManagerCode(w, '002')
    expect(setManagerIdMock).toHaveBeenCalledWith('adm-1')
    expect(connectMock).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('manager / admin でなければエラーで止まる (通話しない)', async () => {
    getEmployeeByCodeMock.mockResolvedValue({ id: 'emp-1', name: '山田 太郎', role: ['driver'] })
    const w = await mountView()
    await click(incoming(w).find('button'), w)
    await submitManagerCode(w, '003')
    expect(idModal(w).text()).toContain('山田 太郎さんには運行管理者の権限がありません')
    expect(setManagerIdMock).not.toHaveBeenCalled()
    expect(connectMock).not.toHaveBeenCalled()
    w.unmount()
  })

  it('社員番号が見つからなければその旨を出す', async () => {
    getEmployeeByCodeMock.mockRejectedValue(new Error('API エラー (404)'))
    const w = await mountView()
    await click(incoming(w).find('button'), w)
    await submitManagerCode(w, '999')
    expect(idModal(w).text()).toContain('社員番号「999」の乗務員が見つかりません')
    expect(connectMock).not.toHaveBeenCalled()
    w.unmount()
  })

  it('空の入力では照会しない。キャンセルで閉じる', async () => {
    const w = await mountView()
    await click(incoming(w).find('button'), w)
    await idModal(w).find('input').trigger('keyup.enter')
    await flush()
    expect(getEmployeeByCodeMock).not.toHaveBeenCalled()

    await click(idModal(w).findAll('button').find(b => b.text() === 'キャンセル')!, w)
    expect(idModal(w).exists()).toBe(false)
    expect(connectMock).not.toHaveBeenCalled()
    w.unmount()
  })
})

describe('TenkoItAdminView — 通話', () => {
  beforeEach(() => {
    activeRoomsRef.value = ['it-session-1']
  })

  it('「通話する」で部屋の id のまま繋ぎ、参加中の部屋を立てる。顔認証は出ない', async () => {
    const w = await mountView()
    expect(webRtcRoles).toEqual(['admin'])
    await click(incoming(w).find('button'), w)

    expect(cameraStartMock).toHaveBeenCalledWith('user')
    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(String(connectMock.mock.calls[0]![0])).toMatch(/^wss?:/)
    expect(connectMock.mock.calls[0]![1]).toBe('it-session-1')
    // token なしの迂回も path の指定もしない (開発用の印の扱いは useWebRtc の中)
    expect(connectMock.mock.calls[0]).toHaveLength(2)
    expect(setJoinedMock).toHaveBeenLastCalledWith('it-session-1')

    // 点呼の記録は接頭辞を剥がした id で、tenko-monitor の口から引く
    expect(getTenkoSessionMock).toHaveBeenCalledWith('session-1', 'tenko-monitor')
    expect(w.find('[data-testid="it-opened"]').text()).toContain('通話中の IT点呼')
    expect(w.find('[data-testid="it-opened"]').text()).toContain('山田 太郎')
    expect(w.find('[data-testid="it-opened"]').text()).toContain('正常')
    expect(w.find('[data-testid="it-opened"]').text()).toContain('36.5°C')
    expect(w.find('[data-testid="it-opened"]').text()).toContain('120/80 mmHg')

    // 顔認証なし・測定の詳細 (鍵では 403) も引かない
    expect(w.find('[data-testid="video-call"]').exists()).toBe(true)
    expect(w.findComponent({ name: 'FaceAuth' }).exists()).toBe(false)
    expect(w.text()).not.toContain('顔認証')
    expect(getMeasurementMock).not.toHaveBeenCalled()
    w.unmount()
  })

  it('未完了の行でも、部屋が在れば着信と同じ動き (通話する)', async () => {
    listTenkoSessionsMock.mockResolvedValue({ sessions: [makeSession('session-1')], total: 1, page: 1, per_page: 50 })
    const w = await mountView()
    await click(pendingRows(w)[0]!.find('button'), w)
    expect(connectMock.mock.calls[0]![1]).toBe('it-session-1')
    expect(setJoinedMock).toHaveBeenLastCalledWith('it-session-1')
    expect(panel(w).props('defaultMethod')).toBe('it')
    w.unmount()
  })

  it('connect が throw したらエラー文で止まる (繋ぎ直さない・監視は止めない)', async () => {
    connectMock.mockRejectedValue(new Error('開発用の鍵のトークンが取れません'))
    const w = await mountView()
    await click(incoming(w).find('button'), w)

    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(w.find('[data-testid="it-call-error"]').text()).toContain('通話を始められませんでした')
    expect(w.find('[data-testid="it-call-error"]').text()).toContain('開発用の鍵のトークンが取れません')
    expect(w.find('[data-testid="it-opened"]').exists()).toBe(false)
    expect(setJoinedMock).not.toHaveBeenCalledWith('it-session-1')
    expect(getTenkoSessionMock).not.toHaveBeenCalled()
    expect(cameraStopMock).toHaveBeenCalled()
    expect(disconnectMock).toHaveBeenCalled()
    expect(stopWatchingMock).not.toHaveBeenCalled()
    // もう一度押せる
    expect(incoming(w).find('button').attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('通話中は 3 秒ごとに記録を引き直し、通話終了で止める', async () => {
    const w = await mountView()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await click(incoming(w).find('button'), w)
    expect(getTenkoSessionMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(IT_TENKO_POLL_INTERVAL_MS)
    await flush()
    expect(getTenkoSessionMock).toHaveBeenCalledTimes(2)

    await click(w.findAll('button').find(b => b.text() === '通話終了')!, w)
    expect(disconnectMock).toHaveBeenCalled()
    expect(setJoinedMock).toHaveBeenLastCalledWith(null)
    expect(w.find('[data-testid="it-opened"]').exists()).toBe(false)

    vi.advanceTimersByTime(IT_TENKO_POLL_INTERVAL_MS * 3)
    await flush()
    expect(getTenkoSessionMock).toHaveBeenCalledTimes(2)
    w.unmount()
  })

  it('通話中の引き直しが一時的に失敗しても閉じない', async () => {
    const w = await mountView()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await click(incoming(w).find('button'), w)
    getTenkoSessionMock.mockRejectedValueOnce(new Error('network'))
    vi.advanceTimersByTime(IT_TENKO_POLL_INTERVAL_MS)
    await flush()
    await w.vm.$nextTick()
    expect(w.find('[data-testid="it-opened"]').exists()).toBe(true)
    expect(w.find('[data-testid="it-call-error"]').exists()).toBe(false)
    expect(panel(w).exists()).toBe(true)
    w.unmount()
  })

  it('unmount で通話を切り、参加中の部屋を下ろす', async () => {
    const w = await mountView()
    await click(incoming(w).find('button'), w)
    disconnectMock.mockClear()
    setJoinedMock.mockClear()
    w.unmount()
    expect(disconnectMock).toHaveBeenCalled()
    expect(cameraStopMock).toHaveBeenCalled()
    expect(setJoinedMock).toHaveBeenLastCalledWith(null)
    expect(stopWatchingMock).toHaveBeenCalledTimes(1)
  })

  it('繋いでいる途中で画面が消えたら、開いたぶんを閉じて何も残さない', async () => {
    let resolveConnect!: () => void
    connectMock.mockImplementation(() => new Promise<void>((resolve) => { resolveConnect = resolve }))
    const w = await mountView()
    await click(incoming(w).find('button'), w)
    // 繋いでいる途中は別の行を開かせない
    expect(incoming(w).find('button').attributes('disabled')).toBeDefined()
    w.unmount()
    disconnectMock.mockClear()
    setJoinedMock.mockClear()

    resolveConnect()
    await flush()
    expect(disconnectMock).toHaveBeenCalled()
    expect(setJoinedMock).not.toHaveBeenCalled()
    expect(getTenkoSessionMock).not.toHaveBeenCalled()
  })
})

describe('TenkoItAdminView — 判定', () => {
  it('通話して開いた判定パネルの既定は IT', async () => {
    activeRoomsRef.value = ['it-session-1']
    const w = await mountView()
    await click(incoming(w).find('button'), w)
    expect(panel(w).exists()).toBe(true)
    expect(panel(w).props('defaultMethod')).toBe('it')
    expect(panel(w).props('managerId')).toBe('mgr-1')
    expect(panel(w).props('session').id).toBe('session-1')
    w.unmount()
  })

  it('通話なしで開いた判定パネルの既定は対面 (通話はしない・記録は 1 回だけ引く)', async () => {
    listTenkoSessionsMock.mockResolvedValue({ sessions: [makeSession('session-2')], total: 1, page: 1, per_page: 50 })
    const w = await mountView()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await click(pendingRows(w)[0]!.find('button'), w)

    expect(connectMock).not.toHaveBeenCalled()
    expect(cameraStartMock).not.toHaveBeenCalled()
    expect(setJoinedMock).not.toHaveBeenCalledWith('it-session-2')
    expect(getTenkoSessionMock).toHaveBeenCalledWith('session-2', 'tenko-monitor')
    expect(w.find('[data-testid="it-opened"]').text()).toContain('通話なしで確定する IT点呼')
    expect(panel(w).props('defaultMethod')).toBe('in_person')

    vi.advanceTimersByTime(IT_TENKO_POLL_INTERVAL_MS * 3)
    await flush()
    expect(getTenkoSessionMock).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('通話なしで開いた記録が引けなければエラー文を出す', async () => {
    listTenkoSessionsMock.mockResolvedValue({ sessions: [makeSession('session-2')], total: 1, page: 1, per_page: 50 })
    getTenkoSessionMock.mockRejectedValue(new Error('API エラー (403)'))
    const w = await mountView()
    await click(pendingRows(w)[0]!.find('button'), w)
    expect(w.find('[data-testid="it-call-error"]').text()).toContain('点呼の記録を取得できませんでした')
    expect(panel(w).exists()).toBe(false)
    w.unmount()
  })

  it('judged で通話を終え、参加中の部屋を下ろし、選択を解除して未完了の一覧を取り直す', async () => {
    activeRoomsRef.value = ['it-session-1']
    const w = await mountView()
    await click(incoming(w).find('button'), w)
    expect(listTenkoSessionsMock).toHaveBeenCalledTimes(1)
    disconnectMock.mockClear()

    panel(w).vm.$emit('judged', makeSession('session-1', { manager_judgment: 'ok', manager_judgment_method: 'it' }))
    await flush()
    await w.vm.$nextTick()

    expect(disconnectMock).toHaveBeenCalled()
    expect(setJoinedMock).toHaveBeenLastCalledWith(null)
    expect(w.find('[data-testid="it-opened"]').exists()).toBe(false)
    expect(listTenkoSessionsMock).toHaveBeenCalledTimes(2)
    // 判定の後も監視は止めない (止めるのは unmount の 1 回だけ)
    expect(stopWatchingMock).not.toHaveBeenCalled()
    w.unmount()
  })
})
