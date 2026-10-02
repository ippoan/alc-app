import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'

const listTimecardCardsMock = vi.fn()
vi.mock('~/utils/api', () => ({
  listTimecardCards: (...args: unknown[]) => listTimecardCardsMock(...args),
}))

import { useTimecardCardIndex, _resetTimecardCardIndex, normalizeCardId } from '~/composables/useTimecardCardIndex'
import { saveTimecardCardIndex, loadTimecardCardIndex } from '~/utils/timecard-card-db'
import type { TimecardCardEntry } from '~/utils/timecard-card-db'

// 打刻カードの台帳を手元に持ち、**同期で**引けるようにする (Refs ippoan/rust-alc-api#644)。
// 「少し古くても使い、引き直しは背景で」が要点 — 引き直してから答えるとクラウド待ちに戻る。
// ただし古すぎる台帳 (定期同期の間隔の 2 倍超・取得時刻が不明) では引かない (Refs ippoan/alc-app#387)。

describe('useTimecardCardIndex', () => {
  let warn: ReturnType<typeof vi.spyOn>
  let nowSpy: ReturnType<typeof vi.spyOn>
  const realNow = 1_700_000_000_000

  beforeEach(() => {
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow)
    globalThis.indexedDB = new IDBFactory()
    listTimecardCardsMock.mockReset()
    listTimecardCardsMock.mockResolvedValue([])
    _resetTimecardCardIndex()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    nowSpy.mockRestore()
    vi.useRealTimers()
  })

  /** 背景で走らせている refresh() を消化する */
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  /** fake timers 下では setTimeout も止まるので microtask で消化する */
  const settleFake = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

  it('★ restore は IndexedDB を読んで即引けるようにする (リロード後の 1 タップ目が速い)', async () => {
    // **サーバの応答を返さない**ことで、IndexedDB から復元した値だけを見ていることを確かめる
    let resolveFetch: (v: unknown) => void = () => {}
    listTimecardCardsMock.mockReturnValue(new Promise((r) => { resolveFetch = r }))
    // 6 分前の写し: 引き直しは走る (5 分超) が、まだ引いてよい (10 分以内)
    await saveTimecardCardIndex([{ cardId: 'AAAA', employeeId: 'emp-1', fetchedAt: realNow - 6 * 60 * 1000 }])

    const idx = useTimecardCardIndex()
    await idx.restore()

    expect(idx.resolve('AAAA')).toBe('emp-1')
    resolveFetch([])
    await settle()
  })

  it('★ restore は引き直しを await しない (背景で走る)', async () => {
    let resolveFetch: (v: unknown) => void = () => {}
    listTimecardCardsMock.mockReturnValue(new Promise((r) => { resolveFetch = r }))
    // 6 分前の写し: 引き直しは走る (5 分超) が、まだ引いてよい (10 分以内)
    await saveTimecardCardIndex([{ cardId: 'AAAA', employeeId: 'emp-1', fetchedAt: realNow - 6 * 60 * 1000 }])

    const idx = useTimecardCardIndex()
    // サーバの応答が返らなくても restore は完了する
    await idx.restore()
    expect(idx.resolve('AAAA')).toBe('emp-1')

    resolveFetch([])
    await settle()
  })

  it('restore は 1 回だけ効く', async () => {
    const idx = useTimecardCardIndex()
    await idx.restore()
    await settle()
    await idx.restore()
    await settle()
    expect(listTimecardCardsMock).toHaveBeenCalledTimes(1)
  })

  it('refresh はサーバの台帳を in-memory と IndexedDB の両方へ反映する', async () => {
    listTimecardCardsMock.mockResolvedValue([
      { id: 'c1', tenant_id: 't', employee_id: 'emp-9', card_id: 'ZZZZ', created_at: '' },
    ])

    const idx = useTimecardCardIndex()
    await idx.refresh()

    expect(idx.resolve('ZZZZ')).toBe('emp-9')
    expect((await loadTimecardCardIndex())[0]).toMatchObject({ cardId: 'ZZZZ', employeeId: 'emp-9' })
  })

  it('★ 引けなかったら null を返し、背景で引き直す (運用中に登録されたカードを次から拾う)', async () => {
    const idx = useTimecardCardIndex()
    await idx.refresh()
    listTimecardCardsMock.mockClear()
    listTimecardCardsMock.mockResolvedValue([
      { id: 'c1', tenant_id: 't', employee_id: 'emp-new', card_id: 'NEW1', created_at: '' },
    ])
    // 引き直しの下限 (30 秒) を越えさせる
    nowSpy.mockReturnValue(realNow + 31_000)

    // 1 回目は空振り。**従来どおり WS 由来のボタンへ倒れるだけ**
    expect(idx.resolve('NEW1')).toBeNull()
    await settle()

    expect(listTimecardCardsMock).toHaveBeenCalledTimes(1)
    expect(idx.resolve('NEW1')).toBe('emp-new')
  })

  it('★ 未登録カードを連打しても 30 秒に 1 回しか引き直さない', async () => {
    const idx = useTimecardCardIndex()
    await idx.refresh()
    listTimecardCardsMock.mockClear()
    nowSpy.mockReturnValue(realNow + 31_000)

    idx.resolve('NOPE')
    await settle()
    idx.resolve('NOPE')
    idx.resolve('NOPE')
    await settle()

    expect(listTimecardCardsMock).toHaveBeenCalledTimes(1)
  })

  it('★ 引けたときは答えを即返し、台帳が新しければ叩かない', async () => {
    listTimecardCardsMock.mockResolvedValue([
      { id: 'c1', tenant_id: 't', employee_id: 'emp-1', card_id: 'AAAA', created_at: '' },
    ])
    const idx = useTimecardCardIndex()
    await idx.refresh()
    listTimecardCardsMock.mockClear()

    expect(idx.resolve('AAAA')).toBe('emp-1')
    await settle()

    expect(listTimecardCardsMock).not.toHaveBeenCalled()
  })

  it('★ 台帳が 5 分より古ければ、引けても背景で引き直す (取り消されたカードを消す)', async () => {
    listTimecardCardsMock.mockResolvedValue([
      { id: 'c1', tenant_id: 't', employee_id: 'emp-1', card_id: 'AAAA', created_at: '' },
    ])
    const idx = useTimecardCardIndex()
    await idx.refresh()
    listTimecardCardsMock.mockClear()
    // このカードはサーバ側で取り消された
    listTimecardCardsMock.mockResolvedValue([])
    nowSpy.mockReturnValue(realNow + 6 * 60 * 1000)

    // **答えは古い台帳のまま即返る** (待たせない)
    expect(idx.resolve('AAAA')).toBe('emp-1')
    await settle()

    expect(listTimecardCardsMock).toHaveBeenCalledTimes(1)
    // 引き直した後は消えている
    expect(idx.resolve('AAAA')).toBeNull()
  })

  it('★ 定期同期は 5 分ごとに引き直す', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const idx = useTimecardCardIndex()
    await idx.refresh()
    listTimecardCardsMock.mockClear()

    idx.startPeriodicRefresh()
    idx.startPeriodicRefresh()   // 二重に張らない

    nowSpy.mockReturnValue(realNow + 6 * 60 * 1000)
    vi.advanceTimersByTime(5 * 60 * 1000)
    await settleFake()
    expect(listTimecardCardsMock).toHaveBeenCalledTimes(1)

    idx.stopPeriodicRefresh()
    idx.stopPeriodicRefresh()    // 二重に止めても害が無い
    nowSpy.mockReturnValue(realNow + 20 * 60 * 1000)
    vi.advanceTimersByTime(10 * 60 * 1000)
    await settleFake()
    expect(listTimecardCardsMock).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('_reset は走っている定期同期も止める (test 間へタイマーを漏らさない)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const idx = useTimecardCardIndex()
    idx.startPeriodicRefresh()

    _resetTimecardCardIndex()

    listTimecardCardsMock.mockClear()
    nowSpy.mockReturnValue(realNow + 60 * 60 * 1000)
    vi.advanceTimersByTime(60 * 60 * 1000)
    await settleFake()
    expect(listTimecardCardsMock).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('restore は台帳が新しければサーバを叩かない (リロード直後に無駄打ちしない)', async () => {
    await saveTimecardCardIndex([{ cardId: 'AAAA', employeeId: 'emp-1', fetchedAt: realNow }])

    const idx = useTimecardCardIndex()
    await idx.restore()
    await settle()

    expect(listTimecardCardsMock).not.toHaveBeenCalled()
    expect(idx.resolve('AAAA')).toBe('emp-1')
  })

  it('★ 引き直しに失敗しても投げず、手元の台帳を使い続ける', async () => {
    listTimecardCardsMock.mockResolvedValue([
      { id: 'c1', tenant_id: 't', employee_id: 'emp-1', card_id: 'AAAA', created_at: '' },
    ])
    const idx = useTimecardCardIndex()
    await idx.refresh()

    listTimecardCardsMock.mockRejectedValue(new Error('offline'))
    await expect(idx.refresh()).resolves.toBeUndefined()

    expect(idx.resolve('AAAA')).toBe('emp-1')
  })

  it('同時に呼ばれても引き直しは 1 本だけ', async () => {
    let resolveFetch: (v: unknown) => void = () => {}
    listTimecardCardsMock.mockReturnValue(new Promise((r) => { resolveFetch = r }))

    const idx = useTimecardCardIndex()
    const a = idx.refresh()
    const b = idx.refresh()
    resolveFetch([])
    await Promise.all([a, b])

    expect(listTimecardCardsMock).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // カードの番号の正規化 (Refs ippoan/alc-app#387)
  // 機体は大文字の 16 進で出し、サーバの台帳は小文字で返す。揃えないと常に引けない。
  // -------------------------------------------------------------------------

  /** サーバの台帳 1 行 (本番の形 = 正規化済みの小文字)。値は作り物 */
  const card = (card_id: string, employee_id: string) =>
    ({ id: `c-${card_id}`, tenant_id: 't', employee_id, card_id, created_at: '' })

  it.each([
    // backend (rust-alc-api の normalize_card_id) のテストと同じ値
    ['0123456789ABCDEF', '0123456789abcdef'],
    ['  AA:BB:CC:DD  ', 'aabbccdd'],
    ['0123456789abcdef', '0123456789abcdef'],
    ['2023040120280331', '2023040120280331'],
    ['   ', ''],
    // `-` と内側の空白は消さない (backend が消さない)
    ['AA-BB', 'aa-bb'],
    ['AA BB', 'aa bb'],
  ])('normalizeCardId(%j) は %j (backend と同じ規則)', (input, expected) => {
    expect(normalizeCardId(input)).toBe(expected)
  })

  it('★★ 小文字の台帳 (サーバの形) を大文字の番号 (機体の形) で引ける', async () => {
    listTimecardCardsMock.mockResolvedValue([card('0a1b2c3d4e5f6071', 'emp-1')])
    const idx = useTimecardCardIndex()
    await idx.refresh()

    expect(idx.resolve('0A1B2C3D4E5F6071')).toBe('emp-1')
  })

  it('`:` 入り・前後に空白の番号でも引ける / `-` 入りは引けない (backend と同じ)', async () => {
    listTimecardCardsMock.mockResolvedValue([card('0a1b2c3d', 'emp-1')])
    const idx = useTimecardCardIndex()
    await idx.refresh()

    expect(idx.resolve('0A:1B:2C:3D')).toBe('emp-1')
    expect(idx.resolve('  0A1B2C3D ')).toBe('emp-1')
    expect(idx.resolve('0A-1B-2C-3D')).toBeNull()
  })

  it('数字だけの番号はそのまま引ける', async () => {
    listTimecardCardsMock.mockResolvedValue([card('01234567890123', 'emp-7')])
    const idx = useTimecardCardIndex()
    await idx.refresh()

    expect(idx.resolve('01234567890123')).toBe('emp-7')
  })

  it('台帳の側が大文字でも引ける (キーにも同じ正規化を通す)', async () => {
    listTimecardCardsMock.mockResolvedValue([card('0A1B2C3D', 'emp-1')])
    const idx = useTimecardCardIndex()
    await idx.refresh()

    expect(idx.resolve('0a1b2c3d')).toBe('emp-1')
    expect(idx.resolve('0A1B2C3D')).toBe('emp-1')
  })

  it('IndexedDB から戻したキーにも正規化を通す', async () => {
    await saveTimecardCardIndex([{ cardId: '0A:1B:2C:3D', employeeId: 'emp-1', fetchedAt: realNow }])
    const idx = useTimecardCardIndex()
    await idx.restore()

    expect(idx.resolve('0A1B2C3D')).toBe('emp-1')
  })

  // -------------------------------------------------------------------------
  // 台帳の鮮度の上限 (Refs ippoan/alc-app#387)
  // 定期同期の間隔 (5 分) の 2 倍 = 10 分を過ぎた台帳・取得時刻が分からない台帳では引かない。
  // カードを付け替えた後の古い写しで、前の持ち主に結び付く幅を抑える。
  // -------------------------------------------------------------------------

  const MIN = 60 * 1000

  it('★ 取れた直後は引け、isFresh も true', async () => {
    listTimecardCardsMock.mockResolvedValue([card('0a1b2c3d', 'emp-1')])
    const idx = useTimecardCardIndex()
    await idx.refresh()

    expect(idx.isFresh()).toBe(true)
    expect(idx.resolve('0A1B2C3D')).toBe('emp-1')
  })

  it('一度も取れていない台帳は isFresh が false で、引かずに背景で引き直す', async () => {
    const idx = useTimecardCardIndex()

    expect(idx.isFresh()).toBe(false)
    expect(idx.resolve('0A1B2C3D')).toBeNull()
    await settle()
    expect(listTimecardCardsMock).toHaveBeenCalledTimes(1)
  })

  it('★★ 上限 (10 分) ちょうどまでは引け、過ぎると台帳に在っても null', async () => {
    listTimecardCardsMock.mockResolvedValue([card('0a1b2c3d', 'emp-1')])
    const idx = useTimecardCardIndex()
    await idx.refresh()
    // 以後の引き直しは返ってこない (= 手元は古い写しのまま)
    listTimecardCardsMock.mockReturnValue(new Promise(() => {}))

    nowSpy.mockReturnValue(realNow + 10 * MIN)
    expect(idx.resolve('0A1B2C3D')).toBe('emp-1')

    nowSpy.mockReturnValue(realNow + 10 * MIN + 1)
    expect(idx.isFresh()).toBe(false)
    expect(idx.resolve('0A1B2C3D')).toBeNull()
  })

  it('★★ 取得に失敗し続けて上限を過ぎると null、その後に取れると引ける', async () => {
    listTimecardCardsMock.mockResolvedValue([card('0a1b2c3d', 'emp-1')])
    const idx = useTimecardCardIndex()
    await idx.refresh()

    listTimecardCardsMock.mockRejectedValue(new Error('offline'))
    nowSpy.mockReturnValue(realNow + 6 * MIN)
    await idx.refresh()
    // 失敗しても、上限の内側なら手元の台帳で引ける
    expect(idx.resolve('0A1B2C3D')).toBe('emp-1')
    await settle()

    nowSpy.mockReturnValue(realNow + 11 * MIN)
    await idx.refresh()
    // 失敗は取得時刻を進めない → 上限を過ぎたので引かない
    expect(idx.resolve('0A1B2C3D')).toBeNull()
    await settle()

    // 通信が戻った。引かなかったときの背景の引き直しで取れ、次から引ける
    listTimecardCardsMock.mockResolvedValue([card('0a1b2c3d', 'emp-1')])
    expect(idx.resolve('0A1B2C3D')).toBeNull()
    await settle()
    expect(idx.resolve('0A1B2C3D')).toBe('emp-1')
  })

  it('★★ IndexedDB から戻した写しは、保存してある取得時刻で判定する (古ければ null)', async () => {
    // サーバは返ってこない = 手元は IndexedDB から戻した写しだけ
    listTimecardCardsMock.mockReturnValue(new Promise(() => {}))
    await saveTimecardCardIndex([{ cardId: '0a1b2c3d', employeeId: 'emp-1', fetchedAt: realNow - 11 * MIN }])

    const idx = useTimecardCardIndex()
    await idx.restore()

    expect(idx.isFresh()).toBe(false)
    expect(idx.resolve('0A1B2C3D')).toBeNull()
  })

  it('★ IndexedDB から戻した写しに取得時刻が無ければ「分からない」扱いで null', async () => {
    listTimecardCardsMock.mockReturnValue(new Promise(() => {}))
    // 取得時刻を持たない写し (保存形式が違う・壊れている)
    await saveTimecardCardIndex([
      { cardId: '0a1b2c3d', employeeId: 'emp-1' } as unknown as TimecardCardEntry,
    ])

    const idx = useTimecardCardIndex()
    await idx.restore()

    expect(idx.resolve('0A1B2C3D')).toBeNull()
  })

  it('★★ 取得時刻が未来 (端末の時計が後ろへ戻った) の台帳は引かず、間引かずに引き直して回復する', async () => {
    listTimecardCardsMock.mockResolvedValue([card('0a1b2c3d', 'emp-1')])
    const idx = useTimecardCardIndex()
    await idx.refresh()
    listTimecardCardsMock.mockClear()

    // 時計が 1 時間戻った。手元の取得時刻は「今」より未来になる
    nowSpy.mockReturnValue(realNow - 60 * MIN)

    expect(idx.isFresh()).toBe(false)
    expect(idx.resolve('0A1B2C3D')).toBeNull()
    await settle()
    // 経過が負でも間引かれず、背景の引き直しが走っている
    expect(listTimecardCardsMock).toHaveBeenCalledTimes(1)
    // 取れたので取得時刻が今になり、引ける
    expect(idx.isFresh()).toBe(true)
    expect(idx.resolve('0A1B2C3D')).toBe('emp-1')
  })

  it('★★ IndexedDB から戻した写しの取得時刻が未来でも引かず、restore の引き直しも間引かれない', async () => {
    let resolveFetch: (v: unknown) => void = () => {}
    listTimecardCardsMock.mockReturnValue(new Promise((r) => { resolveFetch = r }))
    await saveTimecardCardIndex([{ cardId: '0a1b2c3d', employeeId: 'emp-1', fetchedAt: realNow + 60 * MIN }])

    const idx = useTimecardCardIndex()
    await idx.restore()

    // サーバはまだ返っていない = 手元は未来の時刻の写しだけ
    expect(listTimecardCardsMock).toHaveBeenCalledTimes(1)
    expect(idx.isFresh()).toBe(false)
    expect(idx.resolve('0A1B2C3D')).toBeNull()

    resolveFetch([card('0a1b2c3d', 'emp-1')])
    await settle()
    expect(idx.resolve('0A1B2C3D')).toBe('emp-1')
  })

  it('IndexedDB が読めなくても restore は落ちず、サーバから引き直す', async () => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB
    listTimecardCardsMock.mockResolvedValue([])

    const idx = useTimecardCardIndex()
    await expect(idx.restore()).resolves.toBeUndefined()
    await settle()

    expect(listTimecardCardsMock).toHaveBeenCalledTimes(1)
  })
})
