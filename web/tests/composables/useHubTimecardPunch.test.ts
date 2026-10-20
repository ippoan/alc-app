import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { withSetup } from '../helpers/with-setup'
import type { LatestPunch } from '~/types'
import type { UsbHubKind } from '~/composables/useUsbHub'

// --- useUsbHub のモック (NFC を読める機体の EVT を、どの機体から来たか付きで流す口だけ) ---
const { onEventMock, emitFrom, unsubscribeMock, clearHandlers, veinInfo } = vi.hoisted(() => {
  const handlers: Array<(name: string, args: string[], source: UsbHubKind) => void> = []
  const unsubscribeMock = vi.fn()
  return {
    onEventMock: vi.fn((cb: (name: string, args: string[], source: UsbHubKind) => void) => {
      handlers.push(cb)
      return unsubscribeMock
    }),
    emitFrom: (source: UsbHubKind, name: string, args: string[]) => handlers.forEach(h => h(name, args, source)),
    unsubscribeMock,
    // unmount の解除は mock なので、前の test の購読が残る。test ごとに捨てる
    clearHandlers: () => { handlers.length = 0 },
    // Vein Station の名乗り (`useVeinSerial().deviceInfo`)
    veinInfo: { value: null as { flavor: string | null } | null },
  }
})
mockNuxtImport('useUsbHub', () => () => ({ nfc: { onEvent: onEventMock } }))
mockNuxtImport('useVeinSerial', () => () => ({ deviceInfo: veinInfo }))

/** 既定は Vein Station 版 (LAN なし = 画面が打刻を書く構成) から来た行 */
const emitEvent = (name: string, args: string[]) => emitFrom('vein-station', name, args)

// --- useTimecardCardIndex のモック (台帳の引き当てだけ) ---
const resolveMock = vi.fn<(cardId: string) => string | null>()
const isFreshMock = vi.fn<() => boolean>()
const restoreMock = vi.fn(async () => {})
const startPeriodicRefreshMock = vi.fn()
const stopPeriodicRefreshMock = vi.fn()
mockNuxtImport('useTimecardCardIndex', () => () => ({
  resolve: resolveMock,
  isFresh: isFreshMock,
  restore: restoreMock,
  refresh: vi.fn(async () => {}),
  startPeriodicRefresh: startPeriodicRefreshMock,
  stopPeriodicRefresh: stopPeriodicRefreshMock,
}))

// --- サーバーへの持ち主の照会 (`lookupEmployeeByCard`) と、送るトークンの有無 ---
const { lookupMock, punchMock, getDeviceJwtMock, adminToken } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  punchMock: vi.fn(),
  getDeviceJwtMock: vi.fn<() => Promise<string | null>>(),
  // 管理者のトークン (`useAuth().accessToken` の形)
  adminToken: { value: null as string | null },
}))
vi.mock('~/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/utils/api')>()
  return { ...actual, lookupEmployeeByCard: lookupMock, punchTimecard: punchMock }
})
mockNuxtImport('useAuth', () => () => ({ accessToken: adminToken }))
mockNuxtImport('useDeviceToken', () => () => ({ getDeviceJwt: getDeviceJwtMock }))

import { useHubTimecardPunch } from '~/composables/useHubTimecardPunch'
import { readReloadContext, resetReloadContext } from '~/composables/useKioskScreen'

// USB の機体で読んだ IC カードを直接受けて、そのまま測定へ進める (Refs ippoan/rust-alc-api#644,
// ippoan/alc-app#436)。機体が自分で打刻を送らない構成では、画面が打刻を書く。

const NAMES: Record<string, string> = { 'emp-1': '山田太郎', 'emp-2': '佐藤花子' }
const resolveName = (id: string) => NAMES[id] ?? null

/** 測定を始める口 (`NormalMeasurement.startForEmployee` への配線)。既定は始められる */
const startIcMock = vi.fn<(employeeId: string, name: string, punchCardId: string | null) => Promise<boolean>>()

/** 測定を始める口を渡して composable を立てる */
function setup(names: (id: string) => string | null = resolveName) {
  return withSetup(() => useHubTimecardPunch(names, startIcMock))
}

function serverPunch(over: Partial<LatestPunch> = {}): LatestPunch {
  return {
    id: 'row-1',
    employeeId: 'emp-1',
    name: '山田太郎',
    cardKind: 'other',
    punchedAt: new Date().toISOString(),
    ...over,
  }
}

/** `navigator.onLine` を差し替える (test ごとに戻す) */
function setOnline(online: boolean) {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online)
}

/** HTTP の status を持つ失敗 (`request()` が投げる形) */
function httpError(status: number): Error {
  return Object.assign(new Error(`API エラー: ${status}`), { status })
}

/** 外から決着させる promise */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 照会の決着 (microtask) を流す */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))

function resetMocks() {
  clearHandlers()
  onEventMock.mockClear()
  unsubscribeMock.mockClear()
  restoreMock.mockClear()
  startPeriodicRefreshMock.mockClear()
  stopPeriodicRefreshMock.mockClear()
  resolveMock.mockReset()
  resolveMock.mockReturnValue('emp-1')
  isFreshMock.mockReset()
  isFreshMock.mockReturnValue(true)
  lookupMock.mockReset()
  punchMock.mockReset()
  punchMock.mockResolvedValue({})
  startIcMock.mockReset()
  startIcMock.mockResolvedValue(true)
  veinInfo.value = { flavor: 'timecard-vein' }
  getDeviceJwtMock.mockReset()
  getDeviceJwtMock.mockResolvedValue('device-jwt')
  adminToken.value = null
  resetReloadContext()
}

/** warn に出た行をまとめた文字列 (漏れの検査用) */
function captureWarn() {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  return {
    warn,
    text: () => warn.mock.calls.map(c => c.map(String).join(' ')).join('\n'),
  }
}

// オフライン = サーバーに照会せず、手元の写し (カード台帳 + 社員の一覧) で引く
describe('useHubTimecardPunch (オフライン: 手元の写しで引く)', () => {
  beforeEach(() => {
    resetMocks()
    setOnline(false)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('★ オフラインでは照会を呼ばない (端末の鍵も取りに行かない)', () => {
    const [, app] = setup()

    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])

    expect(lookupMock).not.toHaveBeenCalled()
    expect(getDeviceJwtMock).not.toHaveBeenCalled()
    expect(startIcMock).toHaveBeenCalledWith('emp-1', '山田太郎', 'AAAA')
    // 照会しない回は、自動リロードを止める申告も出さない
    expect(readReloadContext().blocked).toBe(0)
    app.unmount()
  })

  it('★★ 機体で読んだカードはボタンに出さず、すぐ測定へ進める (クラウドを待たない)', () => {
    const [hub, app] = setup()

    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=nfca_uid'])

    expect(startIcMock).toHaveBeenCalledTimes(1)
    expect(hub.latest.value).toBeNull()
    app.unmount()
  })

  it('★ 測定を始められず、オフラインなら打刻も見送る (キューは無い)', async () => {
    startIcMock.mockResolvedValue(false)
    const [, app] = setup()

    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])
    await settle()

    expect(punchMock).not.toHaveBeenCalled()
    app.unmount()
  })

  it('★ 台帳に無いカードでは測定を始めない (打刻もオフラインなので見送る)', async () => {
    captureWarn()
    resolveMock.mockReturnValue(null)
    const [hub, app] = setup()

    emitEvent('TIMECARD', ['card_id=UNKNOWN', 'card_kind=felica_idm'])
    await settle()

    expect(startIcMock).not.toHaveBeenCalled()
    expect(punchMock).not.toHaveBeenCalled()
    expect(hub.latest.value).toBeNull()
    app.unmount()
  })

  it('★ 氏名が引けなければ測定を始めない', () => {
    captureWarn()
    resolveMock.mockReturnValue('emp-unknown')
    const [, app] = setup()

    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])

    expect(startIcMock).not.toHaveBeenCalled()
    app.unmount()
  })

  // -------------------------------------------------------------------------
  // 引けなかったことを 1 行残す (Refs ippoan/alc-app#387)
  // **カードの番号・社員の ID・氏名は出さない。**
  // -------------------------------------------------------------------------

  it('★ 台帳に無いカードは warn を 1 行出す (番号を含まない)', () => {
    const w = captureWarn()
    resolveMock.mockReturnValue(null)
    const [, app] = setup()

    emitEvent('TIMECARD', ['card_id=0A1B2C3D4E5F6071', 'card_kind=felica_idm'])

    expect(w.warn).toHaveBeenCalledTimes(1)
    expect(w.text()).toContain('手元の台帳で引けないカード')
    expect(w.text()).toContain('台帳に無い')
    expect(w.text().toLowerCase()).not.toContain('0a1b2c3d4e5f6071')
    app.unmount()
  })

  it('★ 台帳が古くて引かなかったときは、その理由を warn に出す (番号を含まない)', () => {
    const w = captureWarn()
    resolveMock.mockReturnValue(null)
    isFreshMock.mockReturnValue(false)
    const [, app] = setup()

    emitEvent('TIMECARD', ['card_id=0A1B2C3D4E5F6071', 'card_kind=felica_idm'])

    expect(w.warn).toHaveBeenCalledTimes(1)
    expect(w.text()).toContain('台帳が古い')
    expect(w.text().toLowerCase()).not.toContain('0a1b2c3d4e5f6071')
    app.unmount()
  })

  it('★ 氏名が引けないときも warn を 1 行出す (番号・社員の ID を含まない)', () => {
    const w = captureWarn()
    resolveMock.mockReturnValue('emp-unknown')
    const [, app] = setup()

    emitEvent('TIMECARD', ['card_id=0A1B2C3D4E5F6071', 'card_kind=felica_idm'])

    expect(w.warn).toHaveBeenCalledTimes(1)
    expect(w.text()).toContain('名前が無い')
    expect(w.text().toLowerCase()).not.toContain('0a1b2c3d4e5f6071')
    expect(w.text()).not.toContain('emp-unknown')
    app.unmount()
  })

  it('引けたときは warn を出さない', () => {
    const w = captureWarn()
    const [, app] = setup()

    emitEvent('TIMECARD', ['card_id=0A1B2C3D4E5F6071', 'card_kind=felica_idm'])

    expect(startIcMock).toHaveBeenCalledTimes(1)
    expect(w.warn).not.toHaveBeenCalled()
    app.unmount()
  })

  it('card_id が無い行は捨てる', () => {
    const [, app] = setup()
    emitEvent('TIMECARD', ['card_kind=felica_idm'])
    expect(startIcMock).not.toHaveBeenCalled()
    expect(resolveMock).not.toHaveBeenCalled()
    app.unmount()
  })

  it('★★ card_kind=license の TIMECARD は捨てる (免許証は NFC_LICENSE の流れが処理する)', () => {
    const [, app] = setup()
    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=license'])
    expect(startIcMock).not.toHaveBeenCalled()
    expect(resolveMock).not.toHaveBeenCalled()
    app.unmount()
  })

  it('TIMECARD 以外の EVT は無視する', () => {
    const [, app] = setup()
    emitEvent('WS_CONNECTED', [])
    emitEvent('FC1200', ['WARMING'])
    expect(startIcMock).not.toHaveBeenCalled()
    app.unmount()
  })

  it('起動時に台帳を復元する', () => {
    const [, app] = setup()
    expect(restoreMock).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('unmount で購読を解除する', () => {
    const [, app] = setup()
    expect(onEventMock).toHaveBeenCalledTimes(1)
    app.unmount()
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
  })

  it('★ 定期同期を start / stop する (取り消されたカードを消す経路)', () => {
    const [, app] = setup()
    expect(startPeriodicRefreshMock).toHaveBeenCalledTimes(1)
    expect(stopPeriodicRefreshMock).not.toHaveBeenCalled()
    app.unmount()
    expect(stopPeriodicRefreshMock).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // ボタンは別の端末の打刻だけ。機体で読んだ同じタップのサーバ由来の行は捨てる
  // -------------------------------------------------------------------------

  it('★★ 同じ社員・近い時刻のサーバ由来は捨てる (機体が送った同じタップをボタンに出さない)', () => {
    const [hub, app] = setup()
    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])

    // 数秒後にサーバ由来の行が届く = 同じタップ
    hub.setFromServer(serverPunch({ id: 'row-1', employeeId: 'emp-1' }))

    expect(hub.latest.value).toBeNull()
    app.unmount()
  })

  it('★ 別の社員のサーバ由来 (別の端末の打刻) は素通しする', () => {
    const [hub, app] = setup()
    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])

    hub.setFromServer(serverPunch({ id: 'row-2', employeeId: 'emp-2', name: '佐藤花子' }))

    expect(hub.latest.value?.id).toBe('row-2')
    app.unmount()
  })

  it('★ 同じ社員でも時刻が離れていれば素通しする (別のタップ)', () => {
    const [hub, app] = setup()
    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])

    hub.setFromServer(serverPunch({
      id: 'row-9',
      employeeId: 'emp-1',
      punchedAt: new Date(Date.now() + 120_000).toISOString(),
    }))

    expect(hub.latest.value?.id).toBe('row-9')
    app.unmount()
  })

  it('★ 持ち主が引けなかったタップは印を立てない (サーバ由来の行はボタンに出る)', () => {
    captureWarn()
    resolveMock.mockReturnValue(null)
    const [hub, app] = setup()
    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])

    hub.setFromServer(serverPunch({ id: 'row-1', employeeId: 'emp-1' }))

    expect(hub.latest.value?.id).toBe('row-1')
    app.unmount()
  })

  it('機体で読んだタップがまだ無ければサーバ由来をそのまま使う (従来の挙動)', () => {
    const [hub, app] = setup()
    hub.setFromServer(serverPunch({ id: 'row-1' }))
    expect(hub.latest.value?.id).toBe('row-1')
    app.unmount()
  })

  it('サーバ由来が null でもそのまま反映する (打刻がまだ 1 件も無い)', () => {
    const [hub, app] = setup()
    hub.setFromServer(null)
    expect(hub.latest.value).toBeNull()
    app.unmount()
  })
})

// 打刻を書くのは「機体が自分で送らないとき」だけ (Refs ippoan/alc-app#436)。
// 判定は deviceSendsPunch (表そのものは device-line.test.ts)
describe('useHubTimecardPunch (打刻を画面が書くか)', () => {
  const CARD = '0A1B2C3D4E5F6071'
  const EVT = [`card_id=${CARD}`, 'card_kind=felica_idm']
  const EMP_1 = { id: 'emp-1', name: '山田太郎' }

  beforeEach(() => {
    resetMocks()
    setOnline(true)
    lookupMock.mockResolvedValue(EMP_1)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('★★ Vein Station 版 (timecard-vein): card_id を渡して測定を始める (打刻は測定と 1 対 1)', async () => {
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    await settle()

    expect(startIcMock).toHaveBeenCalledWith('emp-1', '山田太郎', CARD)
    // 打刻は NormalMeasurement が測定の id 付きで書く。ここでは書かない
    expect(punchMock).not.toHaveBeenCalled()
    app.unmount()
  })

  it.each([
    ['CoreS3', 'cores3', { flavor: 'timecard-vein' }],
    ['LAN 版の打刻端末 (FLAVOR=timecard)', 'vein-station', { flavor: 'timecard' }],
  ] as const)('★★ %s: 測定だけ始め、画面は打刻を書かない (機体が送る)', async (_label, source, info) => {
    veinInfo.value = info
    const [, app] = setup()

    emitFrom(source, 'TIMECARD', EVT)
    await settle()

    expect(startIcMock).toHaveBeenCalledWith('emp-1', '山田太郎', null)
    expect(punchMock).not.toHaveBeenCalled()
    app.unmount()
  })

  it.each([
    ['FLAVOR が分からない Vein Station', 'vein-station', null],
    ['血圧測定台', 'bp-station', { flavor: 'timecard' }],
  ] as const)('★ %s: 画面が書く (消えた打刻は後から作れない)', async (_label, source, info) => {
    veinInfo.value = info
    const [, app] = setup()

    emitFrom(source, 'TIMECARD', EVT)
    await settle()

    expect(startIcMock).toHaveBeenCalledWith('emp-1', '山田太郎', CARD)
    app.unmount()
  })

  it('★★ 測定を始められない (測定中・IT点呼・別のタブ) → 打刻だけ書く (測定の id 無し)', async () => {
    startIcMock.mockResolvedValue(false)
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    await settle()

    expect(punchMock).toHaveBeenCalledTimes(1)
    expect(punchMock).toHaveBeenCalledWith(CARD)
    app.unmount()
  })

  it('★ 機体が送る構成で測定を始められなくても、画面は打刻を書かない', async () => {
    startIcMock.mockResolvedValue(false)
    const [, app] = setup()

    emitFrom('cores3', 'TIMECARD', EVT)
    await settle()

    expect(punchMock).not.toHaveBeenCalled()
    app.unmount()
  })

  it.each([
    ['status 付き', () => httpError(403), 'http 403'],
    ['通信の失敗', () => new TypeError('Failed to fetch'), '通信の失敗'],
  ])('★ 打刻だけの書き込みが失敗 (%s) → 投げずに理由だけ warn (番号を含まない)', async (_label, makeError, reason) => {
    const w = captureWarn()
    startIcMock.mockResolvedValue(false)
    punchMock.mockRejectedValue(makeError())
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    await settle()

    expect(w.text()).toContain(`打刻に失敗 (${reason})`)
    expect(w.text().toLowerCase()).not.toContain(CARD.toLowerCase())
    app.unmount()
  })

  it.each([404, 400])('★★ 持ち主が見つからない (%i) → 測定は始めず、打刻だけ書く', async (status) => {
    captureWarn()
    lookupMock.mockRejectedValue(httpError(status))
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    await settle()

    expect(startIcMock).not.toHaveBeenCalled()
    expect(punchMock).toHaveBeenCalledWith(CARD)
    app.unmount()
  })

  it('★ 持ち主が見つからないカードでも、機体が送る構成なら画面は書かない', async () => {
    captureWarn()
    lookupMock.mockRejectedValue(httpError(404))
    const [, app] = setup()

    emitFrom('cores3', 'TIMECARD', EVT)
    await settle()

    expect(punchMock).not.toHaveBeenCalled()
    app.unmount()
  })

  it('★ 照会に失敗し手元の写しでも引けない → 打刻だけ書く', async () => {
    captureWarn()
    lookupMock.mockRejectedValue(httpError(500))
    resolveMock.mockReturnValue(null)
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    await settle()

    expect(startIcMock).not.toHaveBeenCalled()
    expect(punchMock).toHaveBeenCalledWith(CARD)
    app.unmount()
  })

  it('★ 手元の写しで社員は引けたが氏名が無い → 打刻だけ書く', async () => {
    captureWarn()
    lookupMock.mockRejectedValue(httpError(500))
    resolveMock.mockReturnValue('emp-unknown')
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    await settle()

    expect(startIcMock).not.toHaveBeenCalled()
    expect(punchMock).toHaveBeenCalledWith(CARD)
    app.unmount()
  })
})

// オンライン = まずサーバーに持ち主を照会する (Refs ippoan/alc-app#387)。
// リロードの直後は手元の写しが揃っておらず、直後のタッチが引けなかった。
describe('useHubTimecardPunch (オンライン: まずサーバーに照会する)', () => {
  const CARD = '0A1B2C3D4E5F6071'
  const EVT = [`card_id=${CARD}`, 'card_kind=felica_idm']
  const EMP_1 = { id: 'emp-1', name: '山田太郎' }
  const EMP_2 = { id: 'emp-2', name: '佐藤花子' }

  beforeEach(() => {
    resetMocks()
    setOnline(true)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** console の全部の口をまとめて捕まえる (漏れの検査用) */
  function captureConsole() {
    const spies = (['warn', 'log', 'info', 'error', 'debug'] as const)
      .map(m => vi.spyOn(console, m).mockImplementation(() => {}))
    return {
      warn: spies[0]!,
      text: () => spies.flatMap(sp => sp.mock.calls.map(c => c.map(String).join(' '))).join('\n'),
    }
  }

  function expectNoLeak(text: string) {
    expect(text.toLowerCase()).not.toContain(CARD.toLowerCase())
    expect(text).not.toContain('emp-1')
    expect(text).not.toContain('山田太郎')
  }

  // --- 200 ---

  it('★★ 200 → 応答の社員で測定を始める (手元の台帳も社員の一覧も空でよい)', async () => {
    const c = captureConsole()
    resolveMock.mockReturnValue(null)
    lookupMock.mockResolvedValue(EMP_1)
    const [, app] = setup(() => null)

    emitEvent('TIMECARD', EVT)
    // 応答が返るまでは始めない
    expect(startIcMock).not.toHaveBeenCalled()
    await settle()

    expect(startIcMock).toHaveBeenCalledWith('emp-1', '山田太郎', CARD)
    // 番号は照会の引数にだけ渡る。口はキオスクの既定 (`'default'`)
    expect(lookupMock).toHaveBeenCalledTimes(1)
    expect(lookupMock).toHaveBeenCalledWith(CARD, 'default')
    // 手元の台帳は引かない
    expect(resolveMock).not.toHaveBeenCalled()
    expect(c.warn).not.toHaveBeenCalled()
    expectNoLeak(c.text())
    app.unmount()
  })

  it('★ 同じタップを見分ける時刻は読み取りを受けた時刻 (照会の決着時刻にしない)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-02T00:00:00.000Z'))
    const d = deferred<typeof EMP_1>()
    lookupMock.mockReturnValue(d.promise)
    const [hub, app] = setup()

    emitEvent('TIMECARD', EVT)
    await vi.advanceTimersByTimeAsync(59_000)
    d.resolve(EMP_1)
    await vi.advanceTimersByTimeAsync(0)

    // 読み取りから 61 秒後 (決着からは 2 秒後) の同じ社員の行は別のタップ
    hub.setFromServer(serverPunch({ id: 'row-x', employeeId: 'emp-1', punchedAt: '2026-10-02T00:01:01.000Z' }))
    expect(hub.latest.value?.id).toBe('row-x')
    app.unmount()
  })

  // --- 404・400 ---

  it.each([404, 400])('★★ %i → 測定を始めない (手元の写しに在っても) + 警告 1 行', async (status) => {
    const c = captureConsole()
    // 手元の写しでは引ける状態
    resolveMock.mockReturnValue('emp-1')
    lookupMock.mockRejectedValue(httpError(status))
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    await settle()

    expect(startIcMock).not.toHaveBeenCalled()
    expect(resolveMock).not.toHaveBeenCalled()
    expect(c.warn).toHaveBeenCalledTimes(1)
    expect(c.text()).toContain('持ち主が見つからないカード')
    expectNoLeak(c.text())
    app.unmount()
  })

  // --- それ以外の失敗 → 手元の写し ---

  it.each([
    ['403', () => httpError(403), 'http 403'],
    ['500', () => httpError(500), 'http 500'],
    ['通信の失敗', () => new TypeError('Failed to fetch'), '通信の失敗'],
  ])('★ %s → 手元の写しで引いて測定を始める + 警告 1 行', async (_label, makeError, reason) => {
    const c = captureConsole()
    lookupMock.mockRejectedValue(makeError())
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    await settle()

    expect(resolveMock).toHaveBeenCalledWith(CARD)
    expect(startIcMock).toHaveBeenCalledWith('emp-1', '山田太郎', CARD)
    expect(c.warn).toHaveBeenCalledTimes(1)
    expect(c.text()).toContain(`サーバーに照会できない (${reason}`)
    expectNoLeak(c.text())
    app.unmount()
  })

  // --- 管理者のトークンで送る経路の失敗 ---
  // `createAuthFetch` (`@ippoan/auth-client`) が投げる Error は `.status` を持たず、
  // message が `API エラー (<status>): <本文>` の形になるだけ (`errorLabel` は `initApi` が渡す)

  it.each([404, 400])('★★ 管理者の経路の %i (status なし・message だけ) → 測定を始めない (手元の写しに在っても)', async (status) => {
    const c = captureConsole()
    adminToken.value = 'admin-token'
    resolveMock.mockReturnValue('emp-1')
    lookupMock.mockRejectedValue(new Error(`API エラー (${status}): Not Found`))
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    await settle()

    expect(startIcMock).not.toHaveBeenCalled()
    expect(resolveMock).not.toHaveBeenCalled()
    expect(c.warn).toHaveBeenCalledTimes(1)
    expect(c.text()).toContain('持ち主が見つからないカード')
    app.unmount()
  })

  it.each([
    ['500', () => new Error('API エラー (500): Internal Server Error'), 'http 500'],
    // 本文の中の `(404)` は拾わない (先頭の 1 個だけを status と読む)
    ['本文に (404) を含む 500', () => new Error('API エラー (500): not found (404): x'), 'http 500'],
    ['message から読めない Error', () => new Error('リクエストがタイムアウトしました'), '通信の失敗'],
    ['Error でない値', () => 'boom', '通信の失敗'],
    ['null', () => null, '通信の失敗'],
  ])('★ 管理者の経路の %s → 手元の写しで引く', async (_label, makeError, reason) => {
    const c = captureConsole()
    adminToken.value = 'admin-token'
    lookupMock.mockRejectedValue(makeError())
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    await settle()

    expect(startIcMock).toHaveBeenCalledWith('emp-1', '山田太郎', CARD)
    expect(c.warn).toHaveBeenCalledTimes(1)
    expect(c.text()).toContain(`サーバーに照会できない (${reason}`)
    app.unmount()
  })

  it('照会が失敗し、手元の写しでも引けなければ測定を始めない (警告は理由ごとに 1 行)', async () => {
    const c = captureConsole()
    resolveMock.mockReturnValue(null)
    lookupMock.mockRejectedValue(httpError(403))
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    await settle()

    expect(startIcMock).not.toHaveBeenCalled()
    expect(c.warn).toHaveBeenCalledTimes(2)
    expect(c.text()).toContain('サーバーに照会できない')
    expect(c.text()).toContain('手元の台帳で引けないカード')
    expectNoLeak(c.text())
    app.unmount()
  })

  // --- 端末の鍵 ---

  it('★★ 端末の鍵が無ければ照会しない (無認証の要求を増やさない) → 手元の写し', async () => {
    const c = captureConsole()
    getDeviceJwtMock.mockResolvedValue(null)
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    await settle()

    expect(lookupMock).not.toHaveBeenCalled()
    expect(startIcMock).toHaveBeenCalledWith('emp-1', '山田太郎', CARD)
    expect(c.text()).toContain('端末の鍵が無い')
    app.unmount()
  })

  it('端末の鍵の値は警告・ログに出ない', async () => {
    const c = captureConsole()
    lookupMock.mockRejectedValue(httpError(403))
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    await settle()

    expect(getDeviceJwtMock).toHaveBeenCalledTimes(1)
    expect(c.text()).not.toContain('device-jwt')
    app.unmount()
  })

  it('端末の鍵の取得が投げても手元の写しへ倒れる', async () => {
    captureConsole()
    getDeviceJwtMock.mockRejectedValue(new Error('serial closed'))
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    await settle()

    expect(lookupMock).not.toHaveBeenCalled()
    expect(startIcMock).toHaveBeenCalledWith('emp-1', '山田太郎', CARD)
    app.unmount()
  })

  it('管理者がログインしている端末は、端末の鍵を待たずに照会する', async () => {
    adminToken.value = 'admin-token'
    lookupMock.mockResolvedValue(EMP_1)
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    await settle()

    expect(getDeviceJwtMock).not.toHaveBeenCalled()
    expect(lookupMock).toHaveBeenCalledTimes(1)
    expect(startIcMock).toHaveBeenCalledWith('emp-1', '山田太郎', CARD)
    app.unmount()
  })

  // --- 6 秒の上限 ---

  it.each([
    ['200', (d: ReturnType<typeof deferred<typeof EMP_2>>) => d.resolve(EMP_2)],
    ['404', (d: ReturnType<typeof deferred<typeof EMP_2>>) => d.reject(httpError(404))],
  ])('★★ 6 秒で決着しなければ手元の写し。その後に遅れて届いた %s は何も変えない', async (_label, finish) => {
    vi.useFakeTimers()
    const c = captureConsole()
    const d = deferred<typeof EMP_2>()
    lookupMock.mockReturnValue(d.promise)
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    await vi.advanceTimersByTimeAsync(5_999)
    expect(startIcMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(startIcMock).toHaveBeenCalledWith('emp-1', '山田太郎', CARD)
    expect(c.text()).toContain('上限切れ')

    finish(d)
    await vi.advanceTimersByTimeAsync(0)

    expect(startIcMock).toHaveBeenCalledTimes(1)
    expect(punchMock).not.toHaveBeenCalled()
    expect(c.warn).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('★★ 端末の鍵の取得待ちも 6 秒の上限に含む。上限の後に遅れて取れた鍵では照会しない', async () => {
    vi.useFakeTimers()
    captureConsole()
    const key = deferred<string | null>()
    getDeviceJwtMock.mockReturnValue(key.promise)
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    await vi.advanceTimersByTimeAsync(6_000)

    expect(lookupMock).not.toHaveBeenCalled()
    expect(startIcMock).toHaveBeenCalledTimes(1)

    key.resolve('device-jwt')
    await vi.advanceTimersByTimeAsync(0)

    expect(lookupMock).not.toHaveBeenCalled()
    expect(startIcMock).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('★ 鍵待ちのあいだに新しい読み取りが来たら、前の読み取りのぶんは照会しない', async () => {
    const key = deferred<string | null>()
    getDeviceJwtMock.mockReturnValue(key.promise)
    lookupMock.mockResolvedValue(EMP_1)
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    emitEvent('TIMECARD', EVT)
    key.resolve('device-jwt')
    await settle()

    // 2 回の読み取りのうち、照会して測定を始めるのは新しいほうの 1 回だけ
    expect(lookupMock).toHaveBeenCalledTimes(1)
    expect(startIcMock).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  // --- 古い結果を捨てる ---

  it('★★ 連続タッチ: 2 回目の読み取りの後に届いた 1 回目の応答は捨てる', async () => {
    const first = deferred<typeof EMP_1>()
    const second = deferred<typeof EMP_2>()
    lookupMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    // 1 回目の照会が飛んでから、2 回目の読み取りが来る
    await settle()
    emitEvent('TIMECARD', ['card_id=FFFF000011112222', 'card_kind=nfca_uid'])
    second.resolve(EMP_2)
    await settle()
    expect(startIcMock).toHaveBeenCalledWith('emp-2', '佐藤花子', 'FFFF000011112222')

    first.resolve(EMP_1)
    await settle()

    expect(startIcMock).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('★ オフラインの読み取りが挟まっても、前の照会の応答は捨てる', async () => {
    const first = deferred<typeof EMP_2>()
    lookupMock.mockReturnValue(first.promise)
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    await settle()
    expect(lookupMock).toHaveBeenCalledTimes(1)
    expect(readReloadContext().blocked).toBe(1)
    setOnline(false)
    emitEvent('TIMECARD', EVT)
    expect(startIcMock).toHaveBeenCalledWith('emp-1', '山田太郎', CARD)
    // 世代が替わり、新しい読み取りは照会しない → 申告を下ろす
    expect(readReloadContext().blocked).toBe(0)

    first.resolve(EMP_2)
    await settle()

    expect(startIcMock).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('★ unmount の後に届いた応答は何も変えない', async () => {
    const c = captureConsole()
    const d = deferred<typeof EMP_1>()
    lookupMock.mockReturnValue(d.promise)
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    app.unmount()
    d.resolve(EMP_1)
    await settle()

    expect(startIcMock).not.toHaveBeenCalled()
    expect(punchMock).not.toHaveBeenCalled()
    expect(c.warn).not.toHaveBeenCalled()
  })

  it('unmount の後に上限が来ても、手元の写しで引かない', async () => {
    vi.useFakeTimers()
    const c = captureConsole()
    lookupMock.mockReturnValue(new Promise(() => {}))
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    app.unmount()
    await vi.advanceTimersByTimeAsync(6_000)

    expect(startIcMock).not.toHaveBeenCalled()
    expect(resolveMock).not.toHaveBeenCalled()
    expect(c.warn).not.toHaveBeenCalled()
  })

  // --- 照会の応答待ちのあいだは、待機中の自動リロードを止める ---
  // 待つあいだに画面がリロードされると、この機体で読んだ回を失う

  it.each([
    ['200', () => lookupMock.mockResolvedValue(EMP_1)],
    ['404', () => lookupMock.mockRejectedValue(httpError(404))],
    ['失敗 (500)', () => lookupMock.mockRejectedValue(httpError(500))],
    ['端末の鍵が無い', () => getDeviceJwtMock.mockResolvedValue(null)],
  ])('★★ 照会中はリロードを止める申告が 1、%s で決着したら 0', async (_label, arrange) => {
    captureConsole()
    arrange()
    const [, app] = setup()
    expect(readReloadContext().blocked).toBe(0)

    emitEvent('TIMECARD', EVT)
    expect(readReloadContext().blocked).toBe(1)
    await settle()

    expect(readReloadContext().blocked).toBe(0)
    app.unmount()
  })

  it('★ 6 秒の上限で決着したら申告を下ろす', async () => {
    vi.useFakeTimers()
    captureConsole()
    lookupMock.mockReturnValue(new Promise(() => {}))
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    await vi.advanceTimersByTimeAsync(5_999)
    expect(readReloadContext().blocked).toBe(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(readReloadContext().blocked).toBe(0)
    app.unmount()
  })

  it('★ 世代が替わっても (連続タッチ)、新しい照会が決着するまで申告は 1 のまま', async () => {
    const first = deferred<typeof EMP_1>()
    const second = deferred<typeof EMP_2>()
    lookupMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    await settle()
    emitEvent('TIMECARD', EVT)
    // 1 回目の応答が届いても、2 回目がまだ待っている
    first.resolve(EMP_1)
    await settle()
    expect(readReloadContext().blocked).toBe(1)

    second.resolve(EMP_2)
    await settle()
    expect(readReloadContext().blocked).toBe(0)
    app.unmount()
  })

  it('★ 照会中に unmount したら申告は残らない', async () => {
    lookupMock.mockReturnValue(new Promise(() => {}))
    const [, app] = setup()

    emitEvent('TIMECARD', EVT)
    expect(readReloadContext().blocked).toBe(1)
    app.unmount()

    expect(readReloadContext().blocked).toBe(0)
  })
})
