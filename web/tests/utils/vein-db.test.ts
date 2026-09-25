import { describe, it, expect, beforeEach } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { saveVeinTemplates, loadVeinTemplates } from '~/utils/vein-db'
import type { VeinTemplateSnapshot } from '~/utils/vein-db'

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
})
