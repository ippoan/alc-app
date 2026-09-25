import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { openIdb } from '~/utils/idb'

// IndexedDB を開く共通の口 (Refs ippoan/vein-match#20)。store の作り方は呼び出し側が渡す

describe('openIdb', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
  })

  it('初回は upgrade で store を作り、開いた DB を返す', async () => {
    const upgrade = vi.fn((db: IDBDatabase) => { db.createObjectStore('items') })
    const db = await openIdb('test-db', 1, upgrade)
    expect(upgrade).toHaveBeenCalledTimes(1)
    expect([...db.objectStoreNames]).toEqual(['items'])
    db.close()
  })

  it('同じ版で開き直すときは upgrade を呼ばない', async () => {
    const upgrade = vi.fn((db: IDBDatabase) => { db.createObjectStore('items') })
    ;(await openIdb('test-db', 1, upgrade)).close()
    ;(await openIdb('test-db', 1, upgrade)).close()
    expect(upgrade).toHaveBeenCalledTimes(1)
  })

  it('開けなければ reject する (保存済みより古い版を指定したとき)', async () => {
    ;(await openIdb('test-db', 2, () => {})).close()
    await expect(openIdb('test-db', 1, () => {})).rejects.toMatchObject({ name: 'VersionError' })
  })
})
