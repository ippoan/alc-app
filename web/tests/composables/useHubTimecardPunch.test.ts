import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { withSetup } from '../helpers/with-setup'
import type { LatestPunch } from '~/types'

// --- useCoreS3Serial のモック (EVT を流す口だけ) ---
const { onEventMock, emitEvent, unsubscribeMock, clearHandlers } = vi.hoisted(() => {
  const handlers: Array<(name: string, args: string[]) => void> = []
  const unsubscribeMock = vi.fn()
  return {
    onEventMock: vi.fn((cb: (name: string, args: string[]) => void) => {
      handlers.push(cb)
      return unsubscribeMock
    }),
    emitEvent: (name: string, args: string[]) => handlers.forEach(h => h(name, args)),
    unsubscribeMock,
    // unmount の解除は mock なので、前の test の購読が残る。test ごとに捨てる
    clearHandlers: () => { handlers.length = 0 },
  }
})
mockNuxtImport('useCoreS3Serial', () => () => ({ onEvent: onEventMock }))

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
const { lookupMock, getDeviceJwtMock, adminToken } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  getDeviceJwtMock: vi.fn<() => Promise<string | null>>(),
  // 管理者のトークン (`useAuth().accessToken` の形)
  adminToken: { value: null as string | null },
}))
vi.mock('~/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/utils/api')>()
  return { ...actual, lookupEmployeeByCard: lookupMock }
})
mockNuxtImport('useAuth', () => () => ({ accessToken: adminToken }))
mockNuxtImport('useDeviceToken', () => () => ({ getDeviceJwt: getDeviceJwtMock }))

import { useHubTimecardPunch } from '~/composables/useHubTimecardPunch'

// ハブの IC 打刻を USB シリアルから直接受けて画面を動かす (Refs ippoan/rust-alc-api#644)。
// これまではクラウドを一周してからボタンが出ていた (WS が切れている間は出なかった)。

const NAMES: Record<string, string> = { 'emp-1': '山田太郎', 'emp-2': '佐藤花子' }
const resolveName = (id: string) => NAMES[id] ?? null

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
  getDeviceJwtMock.mockReset()
  getDeviceJwtMock.mockResolvedValue('device-jwt')
  adminToken.value = null
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
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])

    expect(lookupMock).not.toHaveBeenCalled()
    expect(getDeviceJwtMock).not.toHaveBeenCalled()
    expect(hub.latest.value).toMatchObject({ id: 'serial:1', employeeId: 'emp-1', readOnThisDevice: true })
    app.unmount()
  })

  it('★ EVT TIMECARD を受けて、その人ぶんの最新打刻を立てる (クラウドを待たない)', () => {
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))
    expect(hub.latest.value).toBeNull()

    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])

    expect(hub.latest.value).toMatchObject({
      employeeId: 'emp-1',
      name: '山田太郎',
      // felica_idm / nfca_uid は 'other' に畳まれる (IcPunchAlcoholPrompt が出す条件)
      cardKind: 'other',
      // この端末に繋いだ機体が読んだ打刻の印 (Refs ippoan/alc-app#387)
      readOnThisDevice: true,
    })
    app.unmount()
  })

  it('nfca_uid も other に畳む', () => {
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))
    emitEvent('TIMECARD', ['card_id=BBBB', 'card_kind=nfca_uid'])
    expect(hub.latest.value?.cardKind).toBe('other')
    app.unmount()
  })

  it('★ 台帳に無いカードでは何もしない (従来どおりサーバ由来のボタンへ倒れる)', () => {
    resolveMock.mockReturnValue(null)
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', ['card_id=UNKNOWN', 'card_kind=felica_idm'])

    expect(hub.latest.value).toBeNull()
    app.unmount()
  })

  it('★ 氏名が引けなければ何もしない', () => {
    resolveMock.mockReturnValue('emp-unknown')
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])

    expect(hub.latest.value).toBeNull()
    app.unmount()
  })

  // -------------------------------------------------------------------------
  // 引けなかったことを 1 行残す (Refs ippoan/alc-app#387)
  // 黙って倒れていたので、USB 由来が本番で一度も引けていないことに気づけなかった。
  // **カードの番号・社員の ID・氏名は出さない。**
  // -------------------------------------------------------------------------

  /** warn に出た行をまとめた文字列 (漏れの検査用) */
  function captureWarn() {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    return {
      warn,
      text: () => warn.mock.calls.map(c => c.map(String).join(' ')).join('\n'),
    }
  }

  it('★ 台帳に無いカードは warn を 1 行出す (番号を含まない)', () => {
    const w = captureWarn()
    resolveMock.mockReturnValue(null)
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', ['card_id=0A1B2C3D4E5F6071', 'card_kind=felica_idm'])

    expect(hub.latest.value).toBeNull()
    expect(w.warn).toHaveBeenCalledTimes(1)
    expect(w.text()).toContain('手元の台帳で引けないカード')
    expect(w.text()).toContain('台帳に無い')
    expect(w.text().toLowerCase()).not.toContain('0a1b2c3d4e5f6071')
    app.unmount()
    w.warn.mockRestore()
  })

  it('★ 台帳が古くて引かなかったときは、その理由を warn に出す (番号を含まない)', () => {
    const w = captureWarn()
    resolveMock.mockReturnValue(null)
    isFreshMock.mockReturnValue(false)
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', ['card_id=0A1B2C3D4E5F6071', 'card_kind=felica_idm'])

    expect(hub.latest.value).toBeNull()
    expect(w.warn).toHaveBeenCalledTimes(1)
    expect(w.text()).toContain('台帳が古い')
    expect(w.text().toLowerCase()).not.toContain('0a1b2c3d4e5f6071')
    app.unmount()
    w.warn.mockRestore()
  })

  it('★ 氏名が引けないときも warn を 1 行出す (番号・社員の ID を含まない)', () => {
    const w = captureWarn()
    resolveMock.mockReturnValue('emp-unknown')
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', ['card_id=0A1B2C3D4E5F6071', 'card_kind=felica_idm'])

    expect(hub.latest.value).toBeNull()
    expect(w.warn).toHaveBeenCalledTimes(1)
    expect(w.text()).toContain('名前が無い')
    expect(w.text().toLowerCase()).not.toContain('0a1b2c3d4e5f6071')
    expect(w.text()).not.toContain('emp-unknown')
    app.unmount()
    w.warn.mockRestore()
  })

  it('引けたときは warn を出さない (氏名も warn に出ない)', () => {
    const w = captureWarn()
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', ['card_id=0A1B2C3D4E5F6071', 'card_kind=felica_idm'])

    expect(hub.latest.value?.employeeId).toBe('emp-1')
    expect(w.warn).not.toHaveBeenCalled()
    app.unmount()
    w.warn.mockRestore()
  })

  it('card_id が無い行は捨てる', () => {
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))
    emitEvent('TIMECARD', ['card_kind=felica_idm'])
    expect(hub.latest.value).toBeNull()
    app.unmount()
  })

  it('TIMECARD 以外の EVT は無視する', () => {
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))
    emitEvent('WS_CONNECTED', [])
    emitEvent('FC1200', ['WARMING'])
    expect(hub.latest.value).toBeNull()
    app.unmount()
  })

  it('起動時に台帳を復元する', () => {
    const [, app] = withSetup(() => useHubTimecardPunch(resolveName))
    expect(restoreMock).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('unmount で購読を解除する', () => {
    const [, app] = withSetup(() => useHubTimecardPunch(resolveName))
    expect(onEventMock).toHaveBeenCalledTimes(1)
    app.unmount()
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
  })

  it('★ 定期同期を start / stop する (取り消されたカードを消す経路)', () => {
    const [, app] = withSetup(() => useHubTimecardPunch(resolveName))
    expect(startPeriodicRefreshMock).toHaveBeenCalledTimes(1)
    expect(stopPeriodicRefreshMock).not.toHaveBeenCalled()
    app.unmount()
    expect(stopPeriodicRefreshMock).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // 同じタップで 2 回ボタンを出さない
  // -------------------------------------------------------------------------

  it('★★ 同じ社員・近い時刻のサーバ由来は捨てる (押した後にボタンが出し直されない)', () => {
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))
    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])
    const serialId = hub.latest.value?.id

    // 数秒後にサーバ由来の行が届く = 同じタップ
    hub.setFromServer(serverPunch({ id: 'row-1', employeeId: 'emp-1' }))

    expect(hub.latest.value?.id).toBe(serialId)
    app.unmount()
  })

  it('★ 別の社員のサーバ由来は素通しする', () => {
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))
    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])

    hub.setFromServer(serverPunch({ id: 'row-2', employeeId: 'emp-2', name: '佐藤花子' }))

    expect(hub.latest.value?.id).toBe('row-2')
    // 一覧から来た行 (別の端末の打刻を含む) に「この端末で読んだ」の印は付かない
    expect(hub.latest.value?.readOnThisDevice).toBeUndefined()
    app.unmount()
  })

  it('★ 同じ社員でも時刻が離れていれば素通しする (別のタップ)', () => {
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))
    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])

    hub.setFromServer(serverPunch({
      id: 'row-9',
      employeeId: 'emp-1',
      punchedAt: new Date(Date.now() + 120_000).toISOString(),
    }))

    expect(hub.latest.value?.id).toBe('row-9')
    app.unmount()
  })

  it('シリアル由来がまだ無ければサーバ由来をそのまま使う (従来の挙動)', () => {
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))
    hub.setFromServer(serverPunch({ id: 'row-1' }))
    expect(hub.latest.value?.id).toBe('row-1')
    app.unmount()
  })

  it('サーバ由来が null でもそのまま反映する (打刻がまだ 1 件も無い)', () => {
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))
    hub.setFromServer(null)
    expect(hub.latest.value).toBeNull()
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

  it('★★ 200 → 応答の社員で印付きの行を出す (手元の台帳も社員の一覧も空でよい)', async () => {
    const c = captureConsole()
    resolveMock.mockReturnValue(null)
    lookupMock.mockResolvedValue(EMP_1)
    const [hub, app] = withSetup(() => useHubTimecardPunch(() => null))

    emitEvent('TIMECARD', EVT)
    // 応答が返るまでは何も出さない
    expect(hub.latest.value).toBeNull()
    await settle()

    expect(hub.latest.value).toMatchObject({
      id: 'serial:1',
      employeeId: 'emp-1',
      name: '山田太郎',
      cardKind: 'other',
      readOnThisDevice: true,
    })
    // 番号は照会の引数にだけ渡る。口はキオスクの既定 (`'default'`)
    expect(lookupMock).toHaveBeenCalledTimes(1)
    expect(lookupMock).toHaveBeenCalledWith(CARD, 'default')
    // 手元の台帳は引かない
    expect(resolveMock).not.toHaveBeenCalled()
    expect(c.warn).not.toHaveBeenCalled()
    expectNoLeak(c.text())
    app.unmount()
  })

  it('★ 行の時刻は読み取りを受けた時刻 (照会の決着時刻にしない)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-02T00:00:00.000Z'))
    const d = deferred<typeof EMP_1>()
    lookupMock.mockReturnValue(d.promise)
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', EVT)
    await vi.advanceTimersByTimeAsync(2_000)
    d.resolve(EMP_1)
    await vi.advanceTimersByTimeAsync(0)

    expect(hub.latest.value?.punchedAt).toBe('2026-10-02T00:00:00.000Z')
    app.unmount()
  })

  // --- 404・400 ---

  it.each([404, 400])('★★ %i → 何も出さない (手元の写しに在っても出さない) + 警告 1 行', async (status) => {
    const c = captureConsole()
    // 手元の写しでは引ける状態
    resolveMock.mockReturnValue('emp-1')
    lookupMock.mockRejectedValue(httpError(status))
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', EVT)
    await settle()

    expect(hub.latest.value).toBeNull()
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
  ])('★ %s → 手元の写しで引く (印付き) + 警告 1 行', async (_label, makeError, reason) => {
    const c = captureConsole()
    lookupMock.mockRejectedValue(makeError())
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', EVT)
    await settle()

    expect(resolveMock).toHaveBeenCalledWith(CARD)
    expect(hub.latest.value).toMatchObject({
      id: 'serial:1',
      employeeId: 'emp-1',
      name: '山田太郎',
      readOnThisDevice: true,
    })
    expect(c.warn).toHaveBeenCalledTimes(1)
    expect(c.text()).toContain(`サーバーに照会できない (${reason}`)
    expectNoLeak(c.text())
    app.unmount()
  })

  it('照会が失敗し、手元の写しでも引けなければ何も出さない (警告は理由ごとに 1 行)', async () => {
    const c = captureConsole()
    resolveMock.mockReturnValue(null)
    lookupMock.mockRejectedValue(httpError(403))
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', EVT)
    await settle()

    expect(hub.latest.value).toBeNull()
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
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', EVT)
    await settle()

    expect(lookupMock).not.toHaveBeenCalled()
    expect(hub.latest.value).toMatchObject({ employeeId: 'emp-1', readOnThisDevice: true })
    expect(c.text()).toContain('端末の鍵が無い')
    app.unmount()
  })

  it('端末の鍵の取得が投げても手元の写しへ倒れる', async () => {
    captureConsole()
    getDeviceJwtMock.mockRejectedValue(new Error('serial closed'))
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', EVT)
    await settle()

    expect(lookupMock).not.toHaveBeenCalled()
    expect(hub.latest.value).toMatchObject({ employeeId: 'emp-1', readOnThisDevice: true })
    app.unmount()
  })

  it('管理者がログインしている端末は、端末の鍵を待たずに照会する', async () => {
    adminToken.value = 'admin-token'
    lookupMock.mockResolvedValue(EMP_1)
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', EVT)
    await settle()

    expect(getDeviceJwtMock).not.toHaveBeenCalled()
    expect(lookupMock).toHaveBeenCalledTimes(1)
    expect(hub.latest.value).toMatchObject({ employeeId: 'emp-1', readOnThisDevice: true })
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
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', EVT)
    await vi.advanceTimersByTimeAsync(5_999)
    expect(hub.latest.value).toBeNull()
    await vi.advanceTimersByTimeAsync(1)

    expect(hub.latest.value).toMatchObject({ id: 'serial:1', employeeId: 'emp-1', readOnThisDevice: true })
    expect(c.text()).toContain('上限切れ')

    finish(d)
    await vi.advanceTimersByTimeAsync(0)

    expect(hub.latest.value).toMatchObject({ id: 'serial:1', employeeId: 'emp-1' })
    expect(c.warn).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('端末の鍵の取得待ちも 6 秒の上限に含む', async () => {
    vi.useFakeTimers()
    captureConsole()
    getDeviceJwtMock.mockReturnValue(new Promise(() => {}))
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', EVT)
    await vi.advanceTimersByTimeAsync(6_000)

    expect(lookupMock).not.toHaveBeenCalled()
    expect(hub.latest.value).toMatchObject({ id: 'serial:1', readOnThisDevice: true })
    app.unmount()
  })

  // --- 応答待ちのあいだに届くサーバ由来の行 ---

  it('★★ 応答待ちに同じ社員のサーバ由来の行が先に届く → 200 でその行に印が付き、id が変わらない', async () => {
    const d = deferred<typeof EMP_1>()
    lookupMock.mockReturnValue(d.promise)
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', EVT)
    // 保留しない: 応答の前でもそのまま出る (印なし)
    hub.setFromServer(serverPunch({ id: 'row-1', employeeId: 'emp-1' }))
    expect(hub.latest.value?.id).toBe('row-1')
    expect(hub.latest.value?.readOnThisDevice).toBeUndefined()

    d.resolve(EMP_1)
    await settle()

    // ボタンを出し直さない (id が同じ) まま、印だけ付く
    expect(hub.latest.value?.id).toBe('row-1')
    expect(hub.latest.value?.readOnThisDevice).toBe(true)

    // 以後の同じ行 (一覧の引き直し) は捨てる = 印が消えない
    hub.setFromServer(serverPunch({ id: 'row-1', employeeId: 'emp-1' }))
    expect(hub.latest.value?.readOnThisDevice).toBe(true)
    app.unmount()
  })

  it('★ 応答待ちに別の社員の行が届いていた → serial: の行を置く', async () => {
    const d = deferred<typeof EMP_1>()
    lookupMock.mockReturnValue(d.promise)
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', EVT)
    hub.setFromServer(serverPunch({ id: 'row-2', employeeId: 'emp-2', name: '佐藤花子' }))
    d.resolve(EMP_1)
    await settle()

    expect(hub.latest.value).toMatchObject({ id: 'serial:1', employeeId: 'emp-1', readOnThisDevice: true })
    app.unmount()
  })

  it('★ 応答待ちに届いた行が同じ社員でも、時刻が 60 秒以上離れていれば serial: の行を置く', async () => {
    const d = deferred<typeof EMP_1>()
    lookupMock.mockReturnValue(d.promise)
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', EVT)
    hub.setFromServer(serverPunch({
      id: 'row-old',
      employeeId: 'emp-1',
      punchedAt: new Date(Date.now() - 120_000).toISOString(),
    }))
    d.resolve(EMP_1)
    await settle()

    expect(hub.latest.value?.id).toBe('serial:1')
    app.unmount()
  })

  it('★ 読み取りの前から在った同じ社員の行には印を足さない (前のタップの行) → serial: の行を置く', async () => {
    lookupMock.mockResolvedValue(EMP_1)
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))
    // 前のタップ (引けなかった回) のサーバ由来の行が出ている
    hub.setFromServer(serverPunch({ id: 'row-prev', employeeId: 'emp-1' }))

    emitEvent('TIMECARD', EVT)
    // 待つあいだに一覧が引き直され、同じ行がもう一度届く
    hub.setFromServer(serverPunch({ id: 'row-prev', employeeId: 'emp-1' }))
    await settle()

    // もう一度タッチした回のボタンが出る
    expect(hub.latest.value).toMatchObject({ id: 'serial:1', employeeId: 'emp-1', readOnThisDevice: true })
    app.unmount()
  })

  it('★ 同じ人が続けてタッチ → 前のシリアル由来の行に重ねず、新しい serial: の行を置く', async () => {
    lookupMock.mockResolvedValue(EMP_1)
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', EVT)
    await settle()
    expect(hub.latest.value?.id).toBe('serial:1')
    emitEvent('TIMECARD', EVT)
    await settle()

    expect(hub.latest.value?.id).toBe('serial:2')
    app.unmount()
  })

  it('★ 応答待ちにサーバ由来の行が届き、照会が 404 → その行はそのまま (印なし)', async () => {
    captureConsole()
    const d = deferred<typeof EMP_1>()
    lookupMock.mockReturnValue(d.promise)
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', EVT)
    hub.setFromServer(serverPunch({ id: 'row-1', employeeId: 'emp-1' }))
    d.reject(httpError(404))
    await settle()

    expect(hub.latest.value?.id).toBe('row-1')
    expect(hub.latest.value?.readOnThisDevice).toBeUndefined()
    app.unmount()
  })

  // --- 古い結果を捨てる ---

  it('★★ 連続タッチ: 2 回目の読み取りの後に届いた 1 回目の応答は捨てる', async () => {
    const first = deferred<typeof EMP_1>()
    const second = deferred<typeof EMP_2>()
    lookupMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', EVT)
    emitEvent('TIMECARD', ['card_id=FFFF000011112222', 'card_kind=nfca_uid'])
    second.resolve(EMP_2)
    await settle()
    expect(hub.latest.value).toMatchObject({ id: 'serial:1', employeeId: 'emp-2' })

    first.resolve(EMP_1)
    await settle()

    expect(hub.latest.value).toMatchObject({ id: 'serial:1', employeeId: 'emp-2' })
    app.unmount()
  })

  it('★ オフラインの読み取りが挟まっても、前の照会の応答は捨てる', async () => {
    const first = deferred<typeof EMP_2>()
    lookupMock.mockReturnValue(first.promise)
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', EVT)
    setOnline(false)
    emitEvent('TIMECARD', EVT)
    expect(hub.latest.value).toMatchObject({ id: 'serial:1', employeeId: 'emp-1' })

    first.resolve(EMP_2)
    await settle()

    expect(hub.latest.value).toMatchObject({ id: 'serial:1', employeeId: 'emp-1' })
    app.unmount()
  })

  it('★ unmount の後に届いた応答は何も変えない', async () => {
    const c = captureConsole()
    const d = deferred<typeof EMP_1>()
    lookupMock.mockReturnValue(d.promise)
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', EVT)
    app.unmount()
    d.resolve(EMP_1)
    await settle()

    expect(hub.latest.value).toBeNull()
    expect(c.warn).not.toHaveBeenCalled()
  })

  it('unmount の後に上限が来ても、手元の写しで引かない', async () => {
    vi.useFakeTimers()
    const c = captureConsole()
    lookupMock.mockReturnValue(new Promise(() => {}))
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', EVT)
    app.unmount()
    await vi.advanceTimersByTimeAsync(6_000)

    expect(hub.latest.value).toBeNull()
    expect(resolveMock).not.toHaveBeenCalled()
    expect(c.warn).not.toHaveBeenCalled()
  })
})
