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

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    listTimecardCardsMock.mockReset()
    listTimecardCardsMock.mockResolvedValue([])
    _resetTimecardCardIndex()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
  })

  /** 背景で走らせている refresh() を消化する */
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))

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

    // 1 回目は空振り。**従来どおり WS 由来のボタンへ倒れるだけ**
    expect(idx.resolve('NEW1')).toBeNull()
    await settle()

    expect(listTimecardCardsMock).toHaveBeenCalledTimes(1)
    expect(idx.resolve('NEW1')).toBe('emp-new')
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
