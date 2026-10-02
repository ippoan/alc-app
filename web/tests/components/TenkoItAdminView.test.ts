import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import TenkoItAdminView from '~/components/TenkoItAdminView.vue'
import TenkoManagerJudgmentPanel from '~/components/TenkoManagerJudgmentPanel.vue'
import { IT_TENKO_POLL_INTERVAL_MS } from '~/composables/useItTenkoCall'
import { MANAGER_DEVICE_AUTH_FAILED_MESSAGE } from '~/utils/api'

// 運行管理者側の IT点呼 の受け画面 (Refs ippoan/alc-app#387)。
// 遠隔点呼とは別物: 運行管理者を席に登録 (社員番号だけ・顔認証なし) → 通話 → 判定。
// 判定者は「この席に登録された運行管理者」(useItTenkoManager。localStorage に id だけ) で、
// 運行管理者タブ・遠隔点呼が共有する ID (useManagerAuth) は引き継がない・書き込まない。
// 着信は `it-` で始まる部屋だけ、通話が成立しなかった分は「未完了の IT点呼」の一覧から確定する。

// --- API のモック ---

const getEmployeeByCodeMock = vi.fn()
const getEmployeeByIdMock = vi.fn()
const getEmployeesMock = vi.fn()
const getTenkoSessionMock = vi.fn()
const listTenkoSessionsMock = vi.fn()
const getMeasurementMock = vi.fn()
const lookupEmployeeByCardMock = vi.fn()

vi.mock('~/utils/api', async importOriginal => ({
  // 席の鍵が取れないときに `request()` が投げる文言。実物の定数をそのまま使う
  MANAGER_DEVICE_AUTH_FAILED_MESSAGE: (await importOriginal<typeof import('~/utils/api')>()).MANAGER_DEVICE_AUTH_FAILED_MESSAGE,
  getEmployeeByCode: (...args: unknown[]) => getEmployeeByCodeMock(...args),
  getEmployeeById: (...args: unknown[]) => getEmployeeByIdMock(...args),
  getEmployees: (...args: unknown[]) => getEmployeesMock(...args),
  getTenkoSession: (...args: unknown[]) => getTenkoSessionMock(...args),
  listTenkoSessions: (...args: unknown[]) => listTenkoSessionsMock(...args),
  getMeasurement: (...args: unknown[]) => getMeasurementMock(...args),
  lookupEmployeeByCard: (...args: unknown[]) => lookupEmployeeByCardMock(...args),
  submitManagerJudgment: vi.fn(),
  getDriverInfo: vi.fn(async () => null),
}))

// --- composable のモック ---

const activeRoomsRef = ref<string[]>([])
// 着信として数える部屋 (実物は activeRooms から判定済みの部屋を除いた一覧)。本体のボタンの応答だけが読む
const callingRoomsRef = ref<string[]>([])
const startWatchingMock = vi.fn()
const stopWatchingMock = vi.fn()
const setJoinedMock = vi.fn()
const reloadRoomsMock = vi.fn(async () => true)
mockNuxtImport('useActiveRooms', () => () => ({
  activeRooms: activeRoomsRef,
  callingRooms: callingRoomsRef,
  start: startWatchingMock,
  stop: stopWatchingMock,
  setJoined: setJoinedMock,
  reload: reloadRoomsMock,
}))

// 警告デバイス本体のボタンの押下の回数 (実物はシリアルの行から数える module の ref)
const buttonPressCountRef = ref(0)
// 警告デバイスが NFC で読んだカード (実物はシリアルの行から作る module の ref)
const cardReadRef = ref<{ seq: number, lookupId: string } | null>(null)
mockNuxtImport('useAlarmDevice', () => () => ({ buttonPressCount: buttonPressCountRef, cardRead: cardReadRef }))

// 警告デバイスが切れて 2 分たったままか (実物は useAlarmWatch が数える module の ref)
const seatExpiredRef = ref(false)
mockNuxtImport('useSeatDisconnectGrace', () => () => ({ remainingSeconds: ref(null), expired: seatExpiredRef }))

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

// 席の運行管理者 (useItTenkoManager) と共有の ID (useManagerAuth) は実物を使う

const MANAGER_KEY = 'alc_it_tenko_manager_id'
const MANAGER = { id: 'mgr-1', name: '運行 管理', role: ['manager'] }

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
        TenkoDriverInfoPanel: { props: ['scope'], template: '<div data-testid="driver-info" :data-scope="scope" />' },
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
const card = (w: Wrapper) => w.find('[data-testid="it-manager-card"]')
const changeButton = (w: Wrapper) => card(w).findAll('button').find(b => b.text() === '変更')!
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

async function registerOnCard(w: Wrapper, code: string) {
  await card(w).find('input').setValue(code)
  await click(card(w).findAll('button').find(b => b.text() === '登録')!, w)
}

beforeEach(() => {
  vi.clearAllMocks()
  webRtcRoles.length = 0
  activeRoomsRef.value = []
  callingRoomsRef.value = []
  cardReadRef.value = null
  seatExpiredRef.value = false
  // 既定: この席には運行管理者 mgr-1 が登録済み
  localStorage.clear()
  localStorage.setItem(MANAGER_KEY, 'mgr-1')
  getEmployeeByIdMock.mockResolvedValue(MANAGER)
  useManagerAuth().authenticatedManagerId.value = null
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

  it('未完了の一覧は IT点呼 + 判定未確定の filter と、席の鍵の口 (manager-device) で引く', async () => {
    const w = await mountView()
    expect(listTenkoSessionsMock).toHaveBeenCalledWith(
      { tenko_method: 'IT点呼', judgment_pending: true, per_page: 50 },
      'manager-device',
    )
    expect(getEmployeesMock).toHaveBeenCalledWith('manager-device')
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

  it('一覧の取得に失敗したらエラー文を出す (403 等。理由が利用者向けでない失敗は固定の文言)', async () => {
    listTenkoSessionsMock.mockRejectedValue(new Error('API エラー (403)'))
    const w = await mountView()
    expect(w.text()).toContain('未完了の IT点呼 の取得に失敗しました')
    expect(w.text()).not.toContain('API エラー')
    expect(pendingRows(w)).toHaveLength(0)
    w.unmount()
  })

  it('★ 席の鍵が取れないとき、一覧のエラーに request() の文言をそのまま出す', async () => {
    listTenkoSessionsMock.mockRejectedValue(new Error(MANAGER_DEVICE_AUTH_FAILED_MESSAGE))
    const w = await mountView()
    expect(w.find('[data-testid="it-pending"]').text()).toContain(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)
    expect(w.text()).not.toContain('未完了の IT点呼 の取得に失敗しました')
    expect(pendingRows(w)).toHaveLength(0)
    w.unmount()
  })

  it('★ 席の鍵が取れないとき、枠からの登録のエラーにも同じ文言を出す (「見つかりません」にしない)', async () => {
    localStorage.clear()
    const w = await mountView()
    getEmployeeByCodeMock.mockRejectedValueOnce(new Error(MANAGER_DEVICE_AUTH_FAILED_MESSAGE))
    await registerOnCard(w, '001')
    expect(card(w).find('[data-testid="it-manager-card-error"]').text()).toBe(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)
    expect(localStorage.getItem(MANAGER_KEY)).toBeNull()
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

describe('TenkoItAdminView — この席の運行管理者 (上部の枠)', () => {
  it('保存済みの id が在れば名前を出し、着信を押しても ID を聞かずに開く', async () => {
    activeRoomsRef.value = ['it-session-1']
    const w = await mountView()
    expect(getEmployeeByIdMock).toHaveBeenCalledWith('mgr-1', 'manager-device')
    expect(card(w).text()).toContain('いまの運行管理者:')
    expect(card(w).find('[data-testid="it-manager-name"]').text()).toBe('運行 管理')
    expect(card(w).find('input').exists()).toBe(false)

    await click(incoming(w).find('button'), w)
    expect(idModal(w).exists()).toBe(false)
    expect(getEmployeeByCodeMock).not.toHaveBeenCalled()
    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(panel(w).props('managerId')).toBe('mgr-1')
    w.unmount()
  })

  it('名前を取り直しているあいだは「確認中」、取れなければその旨を出す (id は残る)', async () => {
    let reject!: (e: unknown) => void
    getEmployeeByIdMock.mockImplementation(() => new Promise((_r, rj) => { reject = rj }))
    const w = await mountView()
    expect(card(w).find('[data-testid="it-manager-name"]').text()).toBe('確認中...')

    reject(new Error('network'))
    await flush()
    await w.vm.$nextTick()
    expect(card(w).find('[data-testid="it-manager-name"]').text()).toBe('(名前を取得できません)')
    expect(localStorage.getItem(MANAGER_KEY)).toBe('mgr-1')
    w.unmount()
  })

  it('未登録なら枠に入力が出て、着信が無くても登録できる → 名前が出て席に残る', async () => {
    localStorage.clear()
    getEmployeeByCodeMock.mockResolvedValue({ id: 'mgr-2', name: '点呼 次郎', role: ['manager'] })
    const w = await mountView()
    expect(getEmployeeByIdMock).not.toHaveBeenCalled()
    expect(card(w).find('input').exists()).toBe(true)
    expect(card(w).text()).not.toContain('いまの運行管理者')
    // 空の入力では照会しない
    expect(card(w).findAll('button').find(b => b.text() === '登録')!.attributes('disabled')).toBeDefined()
    await card(w).find('input').trigger('keyup.enter')
    await flush()
    expect(getEmployeeByCodeMock).not.toHaveBeenCalled()

    await registerOnCard(w, ' 001 ')
    expect(getEmployeeByCodeMock).toHaveBeenCalledWith('001', 'manager-device')
    expect(card(w).find('[data-testid="it-manager-name"]').text()).toBe('点呼 次郎')
    expect(card(w).find('input').exists()).toBe(false)
    expect(localStorage.getItem(MANAGER_KEY)).toBe('mgr-2')
    // 登録しただけでは何も開かない
    expect(connectMock).not.toHaveBeenCalled()
    expect(w.find('[data-testid="it-opened"]').exists()).toBe(false)
    w.unmount()
  })

  it('枠からの登録: 権限なし・見つからないはエラーの 1 行を出して未登録のまま', async () => {
    localStorage.clear()
    const w = await mountView()
    getEmployeeByCodeMock.mockResolvedValueOnce({ id: 'emp-1', name: '山田 太郎', role: ['driver'] })
    await registerOnCard(w, '003')
    expect(card(w).find('[data-testid="it-manager-card-error"]').text()).toBe('山田 太郎さんには運行管理者の権限がありません')

    getEmployeeByCodeMock.mockRejectedValueOnce(new Error('API エラー (404)'))
    await registerOnCard(w, '999')
    expect(card(w).find('[data-testid="it-manager-card-error"]').text()).toContain('社員番号「999」の乗務員が見つかりません')
    expect(card(w).find('input').exists()).toBe(true)
    expect(localStorage.getItem(MANAGER_KEY)).toBeNull()
    w.unmount()
  })

  it('「変更」で入力に戻り、保存が消える', async () => {
    const w = await mountView()
    expect(changeButton(w).attributes('disabled')).toBeUndefined()
    await click(changeButton(w), w)
    expect(card(w).find('input').exists()).toBe(true)
    expect(card(w).text()).not.toContain('いまの運行管理者')
    expect(localStorage.getItem(MANAGER_KEY)).toBeNull()
    w.unmount()
  })

  it('点呼を開いている間 (繋いでいる途中を含む) は「変更」が押せない', async () => {
    activeRoomsRef.value = ['it-session-1']
    let resolveConnect!: () => void
    connectMock.mockImplementation(() => new Promise<void>((resolve) => { resolveConnect = resolve }))
    const w = await mountView()
    await click(incoming(w).find('button'), w)
    // 繋いでいる途中
    expect(changeButton(w).attributes('disabled')).toBeDefined()

    resolveConnect()
    await flush()
    await w.vm.$nextTick()
    expect(w.find('[data-testid="it-opened"]').exists()).toBe(true)
    expect(changeButton(w).attributes('disabled')).toBeDefined()

    await click(w.findAll('button').find(b => b.text() === '通話終了')!, w)
    expect(changeButton(w).attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('運行管理者タブ・遠隔点呼の共有の ID が在っても、席に登録が無ければ ID を聞く。登録しても共有の ID は変わらない', async () => {
    localStorage.clear()
    const shared = useManagerAuth()
    shared.authenticatedManagerId.value = 'shared-mgr'
    activeRoomsRef.value = ['it-session-1']
    getEmployeeByCodeMock.mockResolvedValue({ id: 'mgr-2', name: '点呼 次郎', role: ['manager'] })
    const w = await mountView()
    expect(card(w).find('input').exists()).toBe(true)

    await click(incoming(w).find('button'), w)
    expect(idModal(w).exists()).toBe(true)
    expect(connectMock).not.toHaveBeenCalled()

    await submitManagerCode(w, '001')
    expect(panel(w).props('managerId')).toBe('mgr-2')
    expect(shared.authenticatedManagerId.value).toBe('shared-mgr')
    w.unmount()
  })
})

describe('TenkoItAdminView — 未登録のまま開こうとしたとき (モーダル)', () => {
  beforeEach(() => {
    localStorage.clear()
    activeRoomsRef.value = ['it-session-1']
  })

  it('未登録で着信を押すと社員番号を聞く。manager は席に登録され、そのまま通話へ進む', async () => {
    getEmployeeByCodeMock.mockResolvedValue({ id: 'mgr-2', name: '点呼 次郎', role: ['manager'] })
    const w = await mountView()
    await click(incoming(w).find('button'), w)
    expect(idModal(w).exists()).toBe(true)
    expect(connectMock).not.toHaveBeenCalled()

    await submitManagerCode(w, ' 001 ')
    expect(getEmployeeByCodeMock).toHaveBeenCalledWith('001', 'manager-device')
    expect(idModal(w).exists()).toBe(false)
    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(connectMock.mock.calls[0]![1]).toBe('it-session-1')
    // 席に登録され、判定パネルへはその id が渡る
    expect(localStorage.getItem(MANAGER_KEY)).toBe('mgr-2')
    expect(card(w).find('[data-testid="it-manager-name"]').text()).toBe('点呼 次郎')
    expect(panel(w).props('managerId')).toBe('mgr-2')
    w.unmount()
  })

  it('未登録で未完了の行 (通話なし) を押しても同じ: 登録 → そのまま開く', async () => {
    activeRoomsRef.value = []
    listTenkoSessionsMock.mockResolvedValue({ sessions: [makeSession('session-2')], total: 1, page: 1, per_page: 50 })
    getEmployeeByCodeMock.mockResolvedValue({ id: 'adm-1', name: '管理 者', role: ['admin'] })
    const w = await mountView()
    await click(pendingRows(w)[0]!.find('button'), w)
    expect(idModal(w).exists()).toBe(true)

    await submitManagerCode(w, '002')
    expect(idModal(w).exists()).toBe(false)
    expect(connectMock).not.toHaveBeenCalled()
    expect(w.find('[data-testid="it-opened"]').text()).toContain('通話なしで確定する IT点呼')
    expect(panel(w).props('managerId')).toBe('adm-1')
    w.unmount()
  })

  it('manager / admin でなければエラーで止まる (登録も通話もしない)', async () => {
    getEmployeeByCodeMock.mockResolvedValue({ id: 'emp-1', name: '山田 太郎', role: ['driver'] })
    const w = await mountView()
    await click(incoming(w).find('button'), w)
    await submitManagerCode(w, '003')
    expect(idModal(w).text()).toContain('山田 太郎さんには運行管理者の権限がありません')
    expect(localStorage.getItem(MANAGER_KEY)).toBeNull()
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

  it('照会を待つあいだにキャンセルされたら、登録はするが開かない', async () => {
    let resolveLookup!: (v: unknown) => void
    getEmployeeByCodeMock.mockImplementation(() => new Promise((resolve) => { resolveLookup = resolve }))
    const w = await mountView()
    await click(incoming(w).find('button'), w)
    await submitManagerCode(w, '001')
    await click(idModal(w).findAll('button').find(b => b.text() === 'キャンセル')!, w)

    resolveLookup({ id: 'mgr-2', name: '点呼 次郎', role: ['manager'] })
    await flush()
    await w.vm.$nextTick()
    expect(connectMock).not.toHaveBeenCalled()
    expect(card(w).find('[data-testid="it-manager-name"]').text()).toBe('点呼 次郎')
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

    // 点呼の記録は接頭辞を剥がした id で、席の鍵の口から引く
    expect(getTenkoSessionMock).toHaveBeenCalledWith('session-1', 'manager-device')
    // 判定の送信も、運転者情報の取得も席の鍵の口
    expect(panel(w).props('scope')).toBe('manager-device')
    await click(w.findAll('button').find(b => b.text() === '運転者情報')!, w)
    expect(w.find('[data-testid="driver-info"]').attributes('data-scope')).toBe('manager-device')
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
    expect(getTenkoSessionMock).toHaveBeenCalledWith('session-2', 'manager-device')
    expect(panel(w).props('scope')).toBe('manager-device')
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

// 警告デバイス本体のボタン (着信で鳴っている間に押された) で、着信の先頭の IT点呼 に応答する。
// 受け画面が開いているときだけ効き、遠隔点呼の着信では何もしない
describe('TenkoItAdminView — 警告デバイス本体のボタン', () => {
  async function press(w: Wrapper) {
    buttonPressCountRef.value += 1
    await flush()
    await w.vm.$nextTick()
  }

  it('押下で、着信として数えている部屋のうち先頭の it- の部屋に応答する', async () => {
    activeRoomsRef.value = ['session-9', 'it-session-1', 'it-session-2']
    callingRoomsRef.value = ['session-9', 'it-session-1', 'it-session-2']
    const w = await mountView()
    await press(w)

    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(connectMock.mock.calls[0]![1]).toBe('it-session-1')
    expect(setJoinedMock).toHaveBeenLastCalledWith('it-session-1')
    expect(getTenkoSessionMock).toHaveBeenCalledWith('session-1', 'manager-device')
    expect(w.find('[data-testid="it-opened"]').text()).toContain('通話中の IT点呼')
    w.unmount()
  })

  it('★ 判定済みで残っている it- の部屋 + 遠隔点呼の着信だけ → 何もしない', async () => {
    // 一覧 (activeRooms) には判定済みの it- の部屋がまだ在るが、着信 (callingRooms) には無い
    activeRoomsRef.value = ['it-session-1', 'session-9']
    callingRoomsRef.value = ['session-9']
    const w = await mountView()
    expect(incoming(w).findAll('button')).toHaveLength(1)
    await press(w)

    expect(cameraStartMock).not.toHaveBeenCalled()
    expect(connectMock).not.toHaveBeenCalled()
    expect(idModal(w).exists()).toBe(false)
    expect(w.find('[data-testid="it-opened"]').exists()).toBe(false)
    w.unmount()
  })

  it('着信が無ければ何もしない', async () => {
    const w = await mountView()
    await press(w)
    expect(connectMock).not.toHaveBeenCalled()
    expect(idModal(w).exists()).toBe(false)
    w.unmount()
  })

  it('点呼を開いている間は無視する (通話中・通話なしで開いている)', async () => {
    activeRoomsRef.value = ['it-session-1', 'it-session-2']
    callingRoomsRef.value = ['it-session-1', 'it-session-2']
    const w = await mountView()
    await press(w)
    expect(connectMock).toHaveBeenCalledTimes(1)

    // 通話中にもう一度押しても、別の部屋へ繋ぎ替えない
    callingRoomsRef.value = ['it-session-2']
    await press(w)
    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(w.find('[data-testid="it-opened"]').text()).toContain('通話中の IT点呼')
    w.unmount()

    // 通話なしで開いている間 (参加中の部屋は立たないので、着信は数えられたまま)
    vi.clearAllMocks()
    activeRoomsRef.value = ['it-session-2']
    listTenkoSessionsMock.mockResolvedValue({ sessions: [makeSession('session-1')], total: 1, page: 1, per_page: 50 })
    const w2 = await mountView()
    await click(pendingRows(w2)[0]!.find('button'), w2)
    expect(w2.find('[data-testid="it-opened"]').text()).toContain('通話なしで確定する IT点呼')
    await press(w2)
    expect(connectMock).not.toHaveBeenCalled()
    w2.unmount()
  })

  it('繋いでいる途中は無視する', async () => {
    activeRoomsRef.value = ['it-session-1', 'it-session-2']
    callingRoomsRef.value = ['it-session-1', 'it-session-2']
    let resolveConnect!: () => void
    connectMock.mockImplementation(() => new Promise<void>((resolve) => { resolveConnect = resolve }))
    const w = await mountView()
    await press(w)
    expect(connectMock).toHaveBeenCalledTimes(1)

    await press(w)
    expect(cameraStartMock).toHaveBeenCalledTimes(1)
    expect(connectMock).toHaveBeenCalledTimes(1)

    resolveConnect()
    await flush()
    w.unmount()
  })

  it('席の運行管理者が未登録なら社員番号のモーダルが出る。出ている間の押下は無視し、登録すればそのまま通話へ進む', async () => {
    localStorage.removeItem(MANAGER_KEY)
    getEmployeeByCodeMock.mockResolvedValue(MANAGER)
    activeRoomsRef.value = ['it-session-1', 'it-session-2']
    callingRoomsRef.value = ['it-session-1', 'it-session-2']
    const w = await mountView()
    await press(w)
    expect(idModal(w).exists()).toBe(true)
    expect(connectMock).not.toHaveBeenCalled()

    // モーダルが出ている間にもう一度押されても、対象を差し替えない
    callingRoomsRef.value = ['it-session-2']
    await press(w)
    expect(connectMock).not.toHaveBeenCalled()

    await submitManagerCode(w, '001')
    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(connectMock.mock.calls[0]![1]).toBe('it-session-1')
    w.unmount()
  })

  it('mount より前の押下は拾わない (画面を開いた時点では応答しない)', async () => {
    buttonPressCountRef.value += 3
    activeRoomsRef.value = ['it-session-1']
    callingRoomsRef.value = ['it-session-1']
    const w = await mountView()
    expect(connectMock).not.toHaveBeenCalled()
    expect(w.find('[data-testid="it-opened"]').exists()).toBe(false)
    w.unmount()
  })

  it('画面を閉じた後の押下では何も起きない', async () => {
    activeRoomsRef.value = ['it-session-1']
    callingRoomsRef.value = ['it-session-1']
    const w = await mountView()
    w.unmount()
    buttonPressCountRef.value += 1
    await flush()
    expect(connectMock).not.toHaveBeenCalled()
  })
})

describe('TenkoItAdminView — 警告デバイスへのカードのタッチ', () => {
  const CARD = '0123456789abcdef'
  const OTHER_CARD = '04a1b2c3'
  const OTHER = { id: 'mgr-2', name: '交代 管理', role: ['admin'] }
  const NOT_REGISTERED = 'このカードは登録されていません。社員番号で登録してください'
  const LOOKUP_FAILED = 'カードを確認できませんでした。もう一度タッチしてください'
  const cardErrorLine = (w: Wrapper) => w.find('[data-testid="it-manager-card-error"]')

  /** 機体がカードを読んだ (連番を進めて合図を出す) */
  async function touch(w: Wrapper, lookupId = CARD) {
    cardReadRef.value = { seq: (cardReadRef.value?.seq ?? 0) + 1, lookupId }
    await flush()
    await w.vm.$nextTick()
  }

  /** 応答を自分で返す照会。返した関数で resolve する */
  function deferLookup() {
    const resolvers: Array<(v: unknown) => void> = []
    lookupEmployeeByCardMock.mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve) }))
    return resolvers
  }

  async function settle(w: Wrapper) {
    await flush()
    await w.vm.$nextTick()
  }

  it('未登録でタッチ → 席の鍵の口で引いて登録され、名前が出て席に残る (入力は要らない)', async () => {
    localStorage.removeItem(MANAGER_KEY)
    lookupEmployeeByCardMock.mockResolvedValue(MANAGER)
    const w = await mountView()
    expect(card(w).find('input').exists()).toBe(true)

    await touch(w)
    expect(lookupEmployeeByCardMock).toHaveBeenCalledTimes(1)
    expect(lookupEmployeeByCardMock).toHaveBeenCalledWith(CARD, 'manager-device')
    expect(card(w).find('[data-testid="it-manager-name"]').text()).toBe('運行 管理')
    expect(card(w).find('input').exists()).toBe(false)
    expect(localStorage.getItem(MANAGER_KEY)).toBe('mgr-1')
    // 社員番号の照会も、点呼を開くこともしない
    expect(getEmployeeByCodeMock).not.toHaveBeenCalled()
    expect(connectMock).not.toHaveBeenCalled()
    expect(w.find('[data-testid="it-opened"]').exists()).toBe(false)
    w.unmount()
  })

  it('★ 登録済みで別の人がタッチ → 確認なしで切り替わる (入力欄が出ていなくても受ける)', async () => {
    lookupEmployeeByCardMock.mockResolvedValue(OTHER)
    const confirmMock = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmMock)
    const w = await mountView()
    expect(card(w).find('[data-testid="it-manager-name"]').text()).toBe('運行 管理')
    expect(card(w).find('input').exists()).toBe(false)

    await touch(w, OTHER_CARD)
    expect(card(w).find('[data-testid="it-manager-name"]').text()).toBe('交代 管理')
    expect(localStorage.getItem(MANAGER_KEY)).toBe('mgr-2')
    expect(confirmMock).not.toHaveBeenCalled()
    expect(idModal(w).exists()).toBe(false)
    vi.unstubAllGlobals()
    w.unmount()
  })

  it('切り替えた後の判定者は、タッチした人になる', async () => {
    lookupEmployeeByCardMock.mockResolvedValue(OTHER)
    activeRoomsRef.value = ['it-session-1']
    const w = await mountView()
    await touch(w, OTHER_CARD)
    await click(incoming(w).find('button'), w)
    expect(panel(w).props('managerId')).toBe('mgr-2')
    w.unmount()
  })

  it('点呼を開いている間 (通話中・通話なし) のタッチは無視する (照会もしない)', async () => {
    lookupEmployeeByCardMock.mockResolvedValue(OTHER)
    activeRoomsRef.value = ['it-session-1']
    const w = await mountView()
    await click(incoming(w).find('button'), w)
    expect(w.find('[data-testid="it-opened"]').text()).toContain('通話中の IT点呼')
    await touch(w, OTHER_CARD)
    expect(lookupEmployeeByCardMock).not.toHaveBeenCalled()
    expect(card(w).find('[data-testid="it-manager-name"]').text()).toBe('運行 管理')
    expect(panel(w).props('managerId')).toBe('mgr-1')
    w.unmount()

    activeRoomsRef.value = []
    listTenkoSessionsMock.mockResolvedValue({ sessions: [makeSession('session-1')], total: 1, page: 1, per_page: 50 })
    const w2 = await mountView()
    await click(pendingRows(w2)[0]!.find('button'), w2)
    expect(w2.find('[data-testid="it-opened"]').text()).toContain('通話なしで確定する IT点呼')
    await touch(w2, OTHER_CARD)
    expect(lookupEmployeeByCardMock).not.toHaveBeenCalled()
    expect(localStorage.getItem(MANAGER_KEY)).toBe('mgr-1')
    w2.unmount()
  })

  it('繋いでいる途中のタッチは無視する', async () => {
    lookupEmployeeByCardMock.mockResolvedValue(OTHER)
    activeRoomsRef.value = ['it-session-1']
    let resolveConnect!: () => void
    connectMock.mockImplementation(() => new Promise<void>((resolve) => { resolveConnect = resolve }))
    const w = await mountView()
    await click(incoming(w).find('button'), w)
    expect(w.find('[data-testid="it-opened"]').exists()).toBe(false)

    await touch(w, OTHER_CARD)
    expect(lookupEmployeeByCardMock).not.toHaveBeenCalled()

    resolveConnect()
    await settle(w)
    expect(panel(w).props('managerId')).toBe('mgr-1')
    w.unmount()
  })

  it('★ 照会を待つ間に点呼を開いたら登録しない (判定者は替わらない・エラーも出さない)', async () => {
    const resolvers = deferLookup()
    activeRoomsRef.value = ['it-session-1']
    const w = await mountView()
    await touch(w, OTHER_CARD)
    expect(lookupEmployeeByCardMock).toHaveBeenCalledTimes(1)

    await click(incoming(w).find('button'), w)
    expect(w.find('[data-testid="it-opened"]').exists()).toBe(true)

    resolvers[0]!(OTHER)
    await settle(w)
    expect(card(w).find('[data-testid="it-manager-name"]').text()).toBe('運行 管理')
    expect(localStorage.getItem(MANAGER_KEY)).toBe('mgr-1')
    expect(panel(w).props('managerId')).toBe('mgr-1')
    expect(cardErrorLine(w).exists()).toBe(false)
    w.unmount()
  })

  it('照会を待つ間に点呼を開いたら、照会の失敗も出さない', async () => {
    let reject!: (e: unknown) => void
    lookupEmployeeByCardMock.mockImplementation(() => new Promise((_resolve, rj) => { reject = rj }))
    activeRoomsRef.value = ['it-session-1']
    const w = await mountView()
    await touch(w, OTHER_CARD)
    await click(incoming(w).find('button'), w)

    reject(Object.assign(new Error('API エラー (404)'), { status: 404 }))
    await settle(w)
    expect(cardErrorLine(w).exists()).toBe(false)
    w.unmount()
  })

  it('★ 続けて 2 回タッチしたら後のタッチだけが効く (先の応答が後から返っても、先に返っても)', async () => {
    localStorage.removeItem(MANAGER_KEY)
    const resolvers = deferLookup()
    const w = await mountView()
    await touch(w, CARD)
    await touch(w, OTHER_CARD)
    expect(lookupEmployeeByCardMock.mock.calls.map(c => c[0])).toEqual([CARD, OTHER_CARD])

    // 先のタッチの応答が先に返る → 捨てる (まだ未登録のまま)
    resolvers[0]!(MANAGER)
    await settle(w)
    expect(card(w).find('input').exists()).toBe(true)
    expect(localStorage.getItem(MANAGER_KEY)).toBeNull()

    resolvers[1]!(OTHER)
    await settle(w)
    expect(card(w).find('[data-testid="it-manager-name"]').text()).toBe('交代 管理')
    expect(localStorage.getItem(MANAGER_KEY)).toBe('mgr-2')
    w.unmount()

    // 後のタッチの応答が先に返り、先のタッチの応答が後から返る → 後のタッチのまま
    localStorage.removeItem(MANAGER_KEY)
    cardReadRef.value = null
    const again = deferLookup()
    const w2 = await mountView()
    await touch(w2, CARD)
    await touch(w2, OTHER_CARD)
    again[1]!(OTHER)
    await settle(w2)
    again[0]!(MANAGER)
    await settle(w2)
    expect(card(w2).find('[data-testid="it-manager-name"]').text()).toBe('交代 管理')
    expect(localStorage.getItem(MANAGER_KEY)).toBe('mgr-2')
    w2.unmount()
  })

  it('モーダル表示中のタッチ → 登録して、待っていた対象をそのまま開く', async () => {
    localStorage.removeItem(MANAGER_KEY)
    lookupEmployeeByCardMock.mockResolvedValue(MANAGER)
    activeRoomsRef.value = ['it-session-1']
    const w = await mountView()
    await click(incoming(w).find('button'), w)
    expect(idModal(w).exists()).toBe(true)
    expect(connectMock).not.toHaveBeenCalled()

    await touch(w)
    expect(idModal(w).exists()).toBe(false)
    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(connectMock.mock.calls[0]![1]).toBe('it-session-1')
    expect(panel(w).props('managerId')).toBe('mgr-1')
    expect(getEmployeeByCodeMock).not.toHaveBeenCalled()
    w.unmount()
  })

  it('モーダル表示中のタッチの失敗は、モーダルのエラーに出す (開かない)', async () => {
    localStorage.removeItem(MANAGER_KEY)
    lookupEmployeeByCardMock.mockRejectedValue(Object.assign(new Error('API エラー (404)'), { status: 404 }))
    activeRoomsRef.value = ['it-session-1']
    const w = await mountView()
    await click(incoming(w).find('button'), w)

    await touch(w)
    expect(idModal(w).text()).toContain(NOT_REGISTERED)
    expect(cardErrorLine(w).exists()).toBe(false)
    expect(connectMock).not.toHaveBeenCalled()

    // タッチし直して登録できたらエラーは消え、そのまま開く
    lookupEmployeeByCardMock.mockResolvedValue(MANAGER)
    await touch(w)
    expect(idModal(w).exists()).toBe(false)
    expect(connectMock).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it.each([
    ['未登録のカード (404)', Object.assign(new Error('API エラー (404)'), { status: 404 }), NOT_REGISTERED],
    ['席の鍵が取れない', new Error(MANAGER_DEVICE_AUTH_FAILED_MESSAGE), MANAGER_DEVICE_AUTH_FAILED_MESSAGE],
    ['そのほかの失敗', Object.assign(new Error('API エラー (500)'), { status: 500 }), LOOKUP_FAILED],
  ])('失敗の文言 (%s) を上部の枠に出す。カードの id は出さない', async (_label, error, message) => {
    localStorage.removeItem(MANAGER_KEY)
    lookupEmployeeByCardMock.mockRejectedValue(error)
    const w = await mountView()
    await touch(w)
    expect(cardErrorLine(w).text()).toBe(message)
    expect(w.text()).not.toContain(CARD)
    expect(card(w).find('input').exists()).toBe(true)
    expect(localStorage.getItem(MANAGER_KEY)).toBeNull()
    w.unmount()
  })

  it('権限の無い人のタッチは、その旨を出して前の登録を変えない (登録済みの表示でも文言が出る)', async () => {
    lookupEmployeeByCardMock.mockResolvedValue({ id: 'emp-1', name: '山田 太郎', role: ['driver'] })
    const w = await mountView()
    await touch(w)
    expect(cardErrorLine(w).text()).toBe('山田 太郎さんには運行管理者の権限がありません')
    expect(card(w).find('[data-testid="it-manager-name"]').text()).toBe('運行 管理')
    expect(localStorage.getItem(MANAGER_KEY)).toBe('mgr-1')

    // 次のタッチで登録できたら文言は消える
    lookupEmployeeByCardMock.mockResolvedValue(OTHER)
    await touch(w, OTHER_CARD)
    expect(cardErrorLine(w).exists()).toBe(false)
    expect(card(w).find('[data-testid="it-manager-name"]').text()).toBe('交代 管理')
    w.unmount()
  })

  it('カードの id を localStorage にも console にも残さない', async () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const)
      .map(level => vi.spyOn(console, level).mockImplementation(() => {}))
    lookupEmployeeByCardMock.mockResolvedValueOnce(MANAGER).mockRejectedValueOnce(new Error('boom'))
    localStorage.removeItem(MANAGER_KEY)
    const w = await mountView()
    await touch(w)
    await touch(w, OTHER_CARD)

    const stored = Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i)!))
    expect(stored).toEqual(['mgr-1'])
    const printed = spies.flatMap(spy => spy.mock.calls).map(args => JSON.stringify(args))
    expect(printed.filter(text => text.includes(CARD) || text.includes(OTHER_CARD))).toEqual([])
    spies.forEach(spy => spy.mockRestore())
    w.unmount()
  })

  it('mount より前の合図は拾わない (画面を開いた時点では登録しない)', async () => {
    cardReadRef.value = { seq: 7, lookupId: OTHER_CARD }
    lookupEmployeeByCardMock.mockResolvedValue(OTHER)
    const w = await mountView()
    expect(lookupEmployeeByCardMock).not.toHaveBeenCalled()
    expect(card(w).find('[data-testid="it-manager-name"]').text()).toBe('運行 管理')
    w.unmount()
  })

  it('画面を閉じた後のタッチでは何も起きない', async () => {
    lookupEmployeeByCardMock.mockResolvedValue(OTHER)
    const w = await mountView()
    w.unmount()
    cardReadRef.value = { seq: 1, lookupId: OTHER_CARD }
    await flush()
    expect(lookupEmployeeByCardMock).not.toHaveBeenCalled()
    expect(localStorage.getItem(MANAGER_KEY)).toBe('mgr-1')
  })

  it('照会を待つ間に画面を閉じたら登録しない (席の保存も変えない)', async () => {
    const resolvers = deferLookup()
    const w = await mountView()
    await touch(w, OTHER_CARD)
    expect(lookupEmployeeByCardMock).toHaveBeenCalledTimes(1)
    w.unmount()

    resolvers[0]!(OTHER)
    await flush()
    expect(localStorage.getItem(MANAGER_KEY)).toBe('mgr-1')
  })

  it('合図が null に戻っても何もしない', async () => {
    lookupEmployeeByCardMock.mockResolvedValue(OTHER)
    const w = await mountView()
    await touch(w, OTHER_CARD)
    expect(lookupEmployeeByCardMock).toHaveBeenCalledTimes(1)
    cardReadRef.value = null
    await settle(w)
    expect(lookupEmployeeByCardMock).toHaveBeenCalledTimes(1)
    w.unmount()
  })
})

// 繋がっていた警告デバイスが切れて 2 分たった席 (席の鍵の口が通らない)。保存の失敗を待たずに、
// 開いている点呼を閉じて一覧へ戻し、理由を出す。繋がり直すまで点呼は開かない
describe('TenkoItAdminView — 警告デバイスが切れて 2 分たった席', () => {
  const SEAT_EXPIRED_TEXT = '警告デバイスの接続が切れたため、この席では点呼の確認と判定ができません。USB をつなぎ直してください'
  const seatExpired = (w: Wrapper) => w.find('[data-testid="it-seat-expired"]')
  const opened = (w: Wrapper) => w.find('[data-testid="it-opened"]')

  async function setExpired(w: Wrapper, v: boolean) {
    seatExpiredRef.value = v
    await flush()
    await w.vm.$nextTick()
  }

  beforeEach(() => {
    activeRoomsRef.value = ['it-session-1']
    callingRoomsRef.value = ['it-session-1']
  })

  it('★ 通話中に切れたら、通話を終えて一覧へ戻り、理由を出す (判定は保存しない)', async () => {
    const api = await import('~/utils/api')
    const w = await mountView()
    await click(incoming(w).find('button'), w)
    expect(opened(w).exists()).toBe(true)
    expect(panel(w).exists()).toBe(true)
    expect(seatExpired(w).exists()).toBe(false)
    disconnectMock.mockClear()
    cameraStopMock.mockClear()
    const listed = listTenkoSessionsMock.mock.calls.length

    await setExpired(w, true)

    // 手で「通話終了」を押したときと同じ後始末
    expect(disconnectMock).toHaveBeenCalled()
    expect(cameraStopMock).toHaveBeenCalled()
    expect(setJoinedMock).toHaveBeenLastCalledWith(null)
    expect(opened(w).exists()).toBe(false)
    expect(panel(w).exists()).toBe(false)
    expect(w.find('[data-testid="video-call"]').exists()).toBe(false)
    expect(seatExpired(w).text()).toBe(SEAT_EXPIRED_TEXT)
    expect(api.submitManagerJudgment).not.toHaveBeenCalled()
    // 判定が付いたときの取り直しもしない・監視も止めない
    expect(listTenkoSessionsMock.mock.calls.length).toBe(listed)
    expect(stopWatchingMock).not.toHaveBeenCalled()
    // 一覧は残る (着信の行は出たまま)
    expect(incoming(w).findAll('button')).toHaveLength(1)
    w.unmount()
  })

  it('閉じた後は、通話中の記録の引き直しも止まる', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const w = await mountView()
    await click(incoming(w).find('button'), w)
    vi.advanceTimersByTime(IT_TENKO_POLL_INTERVAL_MS)
    const fetched = getTenkoSessionMock.mock.calls.length

    await setExpired(w, true)
    vi.advanceTimersByTime(IT_TENKO_POLL_INTERVAL_MS * 3)
    expect(getTenkoSessionMock.mock.calls.length).toBe(fetched)
    w.unmount()
  })

  it('通話なしで開いている最中に切れても、閉じて一覧へ戻り、理由を出す', async () => {
    activeRoomsRef.value = []
    listTenkoSessionsMock.mockResolvedValue({ sessions: [makeSession('session-7')], total: 1, page: 1, per_page: 50 })
    const w = await mountView()
    await click(pendingRows(w)[0]!.find('button'), w)
    expect(opened(w).text()).toContain('通話なしで確定する IT点呼')

    await setExpired(w, true)
    expect(opened(w).exists()).toBe(false)
    expect(seatExpired(w).text()).toBe(SEAT_EXPIRED_TEXT)
    w.unmount()
  })

  it('★ 繋いでいる途中に切れたら、開いたぶんを閉じて何も残さない (後から繋がっても開かない)', async () => {
    let resolveConnect!: () => void
    connectMock.mockImplementation(() => new Promise<void>((resolve) => { resolveConnect = resolve }))
    const w = await mountView()
    await click(incoming(w).find('button'), w)
    expect(connectMock).toHaveBeenCalledTimes(1)
    disconnectMock.mockClear()

    await setExpired(w, true)
    expect(disconnectMock).toHaveBeenCalled()
    expect(seatExpired(w).text()).toBe(SEAT_EXPIRED_TEXT)
    // 繋いでいる途中の「押せない」は解ける (開けないのは切れているから)
    expect(incoming(w).find('button').attributes('disabled')).toBeUndefined()

    resolveConnect()
    await flush()
    await w.vm.$nextTick()
    expect(opened(w).exists()).toBe(false)
    expect(setJoinedMock).not.toHaveBeenCalledWith('it-session-1')
    expect(getTenkoSessionMock).not.toHaveBeenCalled()
    w.unmount()
  })

  it('開いていないときに切れたら、理由だけ出す (閉じる後始末は走らない)', async () => {
    const w = await mountView()
    setJoinedMock.mockClear()
    disconnectMock.mockClear()

    await setExpired(w, true)
    expect(seatExpired(w).text()).toBe(SEAT_EXPIRED_TEXT)
    expect(disconnectMock).not.toHaveBeenCalled()
    expect(setJoinedMock).not.toHaveBeenCalled()
    w.unmount()
  })

  it('切れている席で画面を開いても、理由が出る', async () => {
    seatExpiredRef.value = true
    const w = await mountView()
    expect(seatExpired(w).text()).toBe(SEAT_EXPIRED_TEXT)
    w.unmount()
  })

  it('★ 切れている間は、着信・未完了の行・本体のボタンのどれでも開かない (通話に入らない)', async () => {
    listTenkoSessionsMock.mockResolvedValue({
      sessions: [makeSession('session-1'), makeSession('session-7')], total: 2, page: 1, per_page: 50,
    })
    const w = await mountView()
    await setExpired(w, true)

    // 着信の「通話する」
    await click(incoming(w).find('button'), w)
    // 未完了の行 (部屋が在る = 通話する / 部屋が無い = 通話なしで確定する)
    await click(pendingRows(w)[0]!.find('button'), w)
    await click(pendingRows(w)[1]!.find('button'), w)
    // 警告デバイス本体のボタン
    buttonPressCountRef.value += 1
    await flush()
    await w.vm.$nextTick()

    expect(cameraStartMock).not.toHaveBeenCalled()
    expect(connectMock).not.toHaveBeenCalled()
    expect(getTenkoSessionMock).not.toHaveBeenCalled()
    expect(setJoinedMock).not.toHaveBeenCalledWith('it-session-1')
    expect(opened(w).exists()).toBe(false)
    expect(idModal(w).exists()).toBe(false)
    w.unmount()
  })

  it('切れている間は、席が未登録でも社員番号のモーダルを出さない', async () => {
    localStorage.removeItem(MANAGER_KEY)
    const w = await mountView()
    await setExpired(w, true)

    await click(incoming(w).find('button'), w)
    expect(idModal(w).exists()).toBe(false)
    expect(connectMock).not.toHaveBeenCalled()
    w.unmount()
  })

  it('★ 社員番号を聞いている途中に切れたらモーダルを閉じ、照会が後から通っても開かない', async () => {
    localStorage.removeItem(MANAGER_KEY)
    let resolveLookup!: (v: unknown) => void
    getEmployeeByCodeMock.mockImplementation(() => new Promise((resolve) => { resolveLookup = resolve }))
    const w = await mountView()
    await click(incoming(w).find('button'), w)
    expect(idModal(w).exists()).toBe(true)
    await submitManagerCode(w, '001')

    await setExpired(w, true)
    expect(idModal(w).exists()).toBe(false)
    expect(seatExpired(w).text()).toBe(SEAT_EXPIRED_TEXT)

    resolveLookup(MANAGER)
    await flush()
    await w.vm.$nextTick()
    expect(connectMock).not.toHaveBeenCalled()
    expect(opened(w).exists()).toBe(false)
    w.unmount()
  })

  it('★ 繋ぎ直したら理由が消え、今までどおり開ける (閉じた点呼は自動では開き直さない)', async () => {
    const w = await mountView()
    await click(incoming(w).find('button'), w)
    await setExpired(w, true)
    expect(opened(w).exists()).toBe(false)
    connectMock.mockClear()

    await setExpired(w, false)
    expect(seatExpired(w).exists()).toBe(false)
    expect(connectMock).not.toHaveBeenCalled()
    expect(opened(w).exists()).toBe(false)

    await click(incoming(w).find('button'), w)
    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(opened(w).text()).toContain('通話中の IT点呼')
    w.unmount()
  })

  it('理由の文言に「トークン」「鍵」「認証」「VoiceS3R」を入れない', async () => {
    const w = await mountView()
    await setExpired(w, true)
    for (const word of ['トークン', '鍵', '認証', 'VoiceS3R']) expect(seatExpired(w).text()).not.toContain(word)
    w.unmount()
  })
})
