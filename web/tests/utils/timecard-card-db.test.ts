import { describe, it, expect, beforeEach } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { saveTimecardCardIndex, loadTimecardCardIndex } from '~/utils/timecard-card-db'

// 打刻カードの台帳 (card_id → 社員 ID) を IndexedDB に置く (Refs ippoan/rust-alc-api#644)。
// **リロードを跨いで残る**のが目的 — キオスクは実測で 44 分に 11 回開き直しており、
// メモリだけだとその直後のタップがクラウド待ちに戻る。

describe('timecard-card-db', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
  })

  it('保存して読み戻せる', async () => {
    await saveTimecardCardIndex([
      { cardId: 'AAAA', employeeId: 'emp-1', fetchedAt: 1000 },
      { cardId: 'BBBB', employeeId: 'emp-2', fetchedAt: 1000 },
    ])

    const loaded = await loadTimecardCardIndex()
    expect(loaded).toHaveLength(2)
    expect(loaded.find(e => e.cardId === 'AAAA')?.employeeId).toBe('emp-1')
  })

  it('★ まるごと差し替える (サーバで消されたカードを手元に残さない)', async () => {
    await saveTimecardCardIndex([
      { cardId: 'AAAA', employeeId: 'emp-1', fetchedAt: 1000 },
      { cardId: 'BBBB', employeeId: 'emp-2', fetchedAt: 1000 },
    ])
    // 退職などで BBBB が消えた台帳を保存し直す
    await saveTimecardCardIndex([{ cardId: 'AAAA', employeeId: 'emp-1', fetchedAt: 2000 }])

    const loaded = await loadTimecardCardIndex()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.cardId).toBe('AAAA')
  })

  it('取得時刻を一緒に持つ (古さが分かるように)', async () => {
    await saveTimecardCardIndex([{ cardId: 'AAAA', employeeId: 'emp-1', fetchedAt: 4242 }])
    expect((await loadTimecardCardIndex())[0]!.fetchedAt).toBe(4242)
  })

  it('まだ何も保存していなければ空を返す', async () => {
    expect(await loadTimecardCardIndex()).toEqual([])
  })

  it('空で保存すれば空になる', async () => {
    await saveTimecardCardIndex([{ cardId: 'AAAA', employeeId: 'emp-1', fetchedAt: 1 }])
    await saveTimecardCardIndex([])
    expect(await loadTimecardCardIndex()).toEqual([])
  })
})
