import { describe, it, expect, beforeEach } from 'vitest'
import { IDBFactory, IDBDatabase } from 'fake-indexeddb'
import { saveVeinTemplates, loadVeinTemplates, clearVeinTemplates, loadVeinModuleEntries, putVeinModuleEntry, deleteVeinModuleEntry } from '~/utils/vein-db'
import type { VeinTemplateSnapshot, VeinModuleEntry } from '~/utils/vein-db'

// 指静脈テンプレートの手元の写し (Refs ippoan/vein-match#20)。
// オフラインの照合に使う。正本はサーバーで、ここは丸ごと差し替えるだけ

function snapshot(overrides: Partial<VeinTemplateSnapshot> = {}): VeinTemplateSnapshot {
  return {
    logicVersion: '0.1.1',
    fetchedAt: 1000,
    templates: [
      { employeeId: 'emp-1', template: 'AAAA', updatedAt: '2026-09-25T00:00:00Z' },
      { employeeId: 'emp-2', template: 'BBBB', updatedAt: '2026-09-25T00:00:00Z' },
    ],
    ...overrides,
  }
}

describe('vein-db', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
  })

  it('一度も保存していなければ null', async () => {
    expect(await loadVeinTemplates()).toBeNull()
  })

  it('保存して読み戻せる (logic_version と取得時刻も一緒に)', async () => {
    await saveVeinTemplates(snapshot())
    const loaded = await loadVeinTemplates()
    expect(loaded).toMatchObject({ logicVersion: '0.1.1', fetchedAt: 1000 })
    expect(loaded!.templates).toHaveLength(2)
    expect(loaded!.templates.find(t => t.employeeId === 'emp-2')?.template).toBe('BBBB')
  })

  it('★ まるごと差し替える (サーバーで消された登録を手元に残さない)', async () => {
    await saveVeinTemplates(snapshot())
    await saveVeinTemplates(snapshot({
      logicVersion: '0.1.2',
      fetchedAt: 2000,
      templates: [{ employeeId: 'emp-1', template: 'CCCC', updatedAt: '2026-09-26T00:00:00Z' }],
    }))
    const loaded = await loadVeinTemplates()
    expect(loaded).toMatchObject({ logicVersion: '0.1.2', fetchedAt: 2000 })
    expect(loaded!.templates).toEqual([{ employeeId: 'emp-1', template: 'CCCC', updatedAt: '2026-09-26T00:00:00Z' }])
  })

  it('0 件でも保存できる (版は残る = 同期済みで登録なし)', async () => {
    await saveVeinTemplates(snapshot({ templates: [] }))
    expect(await loadVeinTemplates()).toEqual({ logicVersion: '0.1.1', fetchedAt: 1000, templates: [] })
  })

  it('保存に失敗したら reject する', async () => {
    // keyPath (employeeId) が無い値は put が DataError を投げる → transaction が abort する
    const bad = snapshot({ templates: [{ template: 'X' } as never] })
    await expect(saveVeinTemplates(bad)).rejects.toBeTruthy()
  })

  it('★ clearVeinTemplates: テンプレートと版を両方消す (読み戻すと null)', async () => {
    await saveVeinTemplates(snapshot())
    await clearVeinTemplates()
    expect(await loadVeinTemplates()).toBeNull()
  })

  it('clearVeinTemplates: 一度も保存していなくても成功し、消したあとにまた保存できる', async () => {
    await expect(clearVeinTemplates()).resolves.toBeUndefined()
    await saveVeinTemplates(snapshot())
    expect((await loadVeinTemplates())!.templates).toHaveLength(2)
  })

  it('clearVeinTemplates: transaction が error になったら reject する', async () => {
    // 次の openDb が返す DB の transaction を失敗させる
    const original = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
      const tx = original.apply(this, args)
      queueMicrotask(() => (tx.onerror as ((e: Event) => void) | null)?.(new Event('error')))
      return tx
    }
    try {
      await expect(clearVeinTemplates()).rejects.toBeNull()
    }
    finally {
      IDBDatabase.prototype.transaction = original
    }
  })

  // --- モジュールの ID の対応表 (版 2、Refs ippoan/alc-app#436) ---

  const ENTRY: VeinModuleEntry = { employeeId: 'emp-1', moduleId: 10, updatedAt: '2026-10-21T00:00:00Z', approved: false }

  it('対応表: 書いて読み戻し、同じ乗務員は置き換わり、外せる (居なくても成功)', async () => {
    expect(await loadVeinModuleEntries()).toEqual([])
    await putVeinModuleEntry(ENTRY)
    await putVeinModuleEntry({ ...ENTRY, approved: true })
    await putVeinModuleEntry({ ...ENTRY, employeeId: 'emp-2', moduleId: 11 })
    expect(await loadVeinModuleEntries()).toEqual([{ ...ENTRY, approved: true }, { ...ENTRY, employeeId: 'emp-2', moduleId: 11 }])
    await deleteVeinModuleEntry('emp-1')
    await deleteVeinModuleEntry('emp-none')
    expect((await loadVeinModuleEntries()).map(e => e.employeeId)).toEqual(['emp-2'])
  })

  it('対応表は写しの差し替え・全消去で消えない', async () => {
    await putVeinModuleEntry(ENTRY)
    await saveVeinTemplates(snapshot())
    await clearVeinTemplates()
    expect(await loadVeinModuleEntries()).toEqual([ENTRY])
  })

  it('★ 版 1 の DB から上げても、既存の写しは消えずに対応表が足される', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('alc-vein-db', 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore('templates', { keyPath: 'employeeId' })
        req.result.createObjectStore('meta')
      }
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['templates', 'meta'], 'readwrite')
        tx.objectStore('templates').put({ employeeId: 'emp-old', template: 'OLD', updatedAt: 'x' })
        tx.objectStore('meta').put({ logicVersion: '0.1.0', fetchedAt: 5 }, 'current')
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })
    expect(await loadVeinTemplates()).toEqual({
      logicVersion: '0.1.0', fetchedAt: 5, templates: [{ employeeId: 'emp-old', template: 'OLD', updatedAt: 'x' }],
    })
    await putVeinModuleEntry(ENTRY)
    expect(await loadVeinModuleEntries()).toEqual([ENTRY])
  })

  it('対応表: 書き込み・読み出し・外すの失敗は reject する', async () => {
    // keyPath (employeeId) が無い値は put が DataError を投げる
    await expect(putVeinModuleEntry({ moduleId: 10 } as never)).rejects.toBeTruthy()
    const original = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
      const tx = original.apply(this, args)
      queueMicrotask(() => (tx.onerror as ((e: Event) => void) | null)?.(new Event('error')))
      return tx
    }
    try {
      await expect(loadVeinModuleEntries()).rejects.toBeNull()
      await expect(putVeinModuleEntry(ENTRY)).rejects.toBeNull()
      await expect(deleteVeinModuleEntry('emp-1')).rejects.toBeNull()
    }
    finally {
      IDBDatabase.prototype.transaction = original
    }
  })
})
