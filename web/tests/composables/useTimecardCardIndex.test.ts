import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'

const listTimecardCardsMock = vi.fn()
vi.mock('~/utils/api', () => ({
  listTimecardCards: (...args: unknown[]) => listTimecardCardsMock(...args),
}))

import { useTimecardCardIndex, _resetTimecardCardIndex } from '~/composables/useTimecardCardIndex'
import { saveTimecardCardIndex, loadTimecardCardIndex } from '~/utils/timecard-card-db'

// 打刻カードの台帳を手元に持ち、**同期で**引けるようにする (Refs ippoan/rust-alc-api#644)。
// 「古くても使い、引き直しは背景で」が要点 — 引き直してから答えるとクラウド待ちに戻る。

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
    await saveTimecardCardIndex([{ cardId: 'AAAA', employeeId: 'emp-1', fetchedAt: 1 }])

    const idx = useTimecardCardIndex()
    await idx.restore()

    expect(idx.resolve('AAAA')).toBe('emp-1')
    resolveFetch([])
    await settle()
  })

  it('★ restore は引き直しを await しない (背景で走る)', async () => {
    let resolveFetch: (v: unknown) => void = () => {}
    listTimecardCardsMock.mockReturnValue(new Promise((r) => { resolveFetch = r }))
    await saveTimecardCardIndex([{ cardId: 'AAAA', employeeId: 'emp-1', fetchedAt: 1 }])

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

  it('IndexedDB が読めなくても restore は落ちず、サーバから引き直す', async () => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB
    listTimecardCardsMock.mockResolvedValue([])

    const idx = useTimecardCardIndex()
    await expect(idx.restore()).resolves.toBeUndefined()
    await settle()

    expect(listTimecardCardsMock).toHaveBeenCalledTimes(1)
  })
})
