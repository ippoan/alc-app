import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { VeinTemplateSnapshot } from '~/utils/vein-db'

// オフラインの指静脈照合 (Refs ippoan/vein-match#20)。wasm は偽物に差し替え、
// 「一覧の i 番目 = 利用者番号 i+1」の対応・level 2・学習しない (t8 を渡さない)・
// 版の突き合わせを見る。本物の wasm が読めることは vein-match.wasm.test.ts が見る

const wasm = vi.hoisted(() => ({
  init: vi.fn(async (_opts: unknown) => ({})),
  logicVersion: vi.fn(() => '0.1.1'),
  /** 作られた VeinLibrary (最後の 1 つ) */
  libraries: [] as FakeLibrary[],
  /** search_user_hex が返す ret */
  searchRet: -1,
  /** import_temp_b64 が返す rc (利用者番号 → rc。無ければ 0) */
  importRc: new Map<number, number>(),
  /** true なら search_user_hex が投げる */
  searchThrows: false,
}))

interface FakeLibrary {
  n: number
  imported: [number, string][]
  searches: [string, number, unknown][]
  freed: boolean
  resultFreed: boolean
}

vi.mock('~/vendor/vein-match/vein_match_wasm', () => ({
  default: wasm.init,
  logic_version: wasm.logicVersion,
  VeinLibrary: class {
    state: FakeLibrary
    constructor(n: number) {
      this.state = { n, imported: [], searches: [], freed: false, resultFreed: false }
      wasm.libraries.push(this.state)
    }

    import_temp_b64(user: number, tmpl: string) {
      this.state.imported.push([user, tmpl])
      return wasm.importRc.get(user) ?? 0
    }

    search_user_hex(probe: string, level: number, t8?: number | null) {
      this.state.searches.push([probe, level, t8])
      if (wasm.searchThrows) throw new Error('boom')
      const state = this.state
      return { ret: wasm.searchRet, free: () => { state.resultFreed = true } }
    }

    free() { this.state.freed = true }
  },
}))

let mod: typeof import('~/utils/vein-match')

function snapshot(ids: string[], logicVersion = '0.1.1'): VeinTemplateSnapshot {
  return {
    logicVersion,
    fetchedAt: 1000,
    templates: ids.map(id => ({ employeeId: id, template: `T-${id}`, updatedAt: '2026-09-25T00:00:00Z' })),
  }
}

describe('vein-match — オフラインの照合', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    wasm.init.mockImplementation(async () => ({}))
    wasm.logicVersion.mockReturnValue('0.1.1')
    wasm.libraries = []
    wasm.searchRet = -1
    wasm.importRc = new Map()
    wasm.searchThrows = false
    // wasm の読み込み状態 (モジュールスコープ) をテストごとに捨てる
    vi.resetModules()
    mod = await import('~/utils/vein-match')
  })

  it('当たり: 戻りの番号 (1 始まり) を一覧の順の employee_id に戻す', async () => {
    wasm.searchRet = 2
    const r = await mod.matchVeinOffline('BDBD', snapshot(['emp-a', 'emp-b', 'emp-c']))
    expect(r).toEqual({ kind: 'hit', employeeId: 'emp-b' })
    const lib = wasm.libraries[0]!
    expect(lib.n).toBe(3)
    expect(lib.imported).toEqual([[1, 'T-emp-a'], [2, 'T-emp-b'], [3, 'T-emp-c']])
    expect(lib.freed).toBe(true)
    expect(lib.resultFreed).toBe(true)
  })

  it('★ level 2 (サーバーと同じ) で、t8 を渡さない = 学習しない', async () => {
    await mod.matchVeinOffline('BDBD', snapshot(['emp-a']))
    expect(wasm.libraries[0]!.searches).toEqual([['BDBD', 2, undefined]])
    expect(mod.VEIN_SEARCH_LEVEL).toBe(2)
  })

  it('外れ: -1', async () => {
    wasm.searchRet = -1
    expect(await mod.matchVeinOffline('BDBD', snapshot(['emp-a', 'emp-b']))).toEqual({ kind: 'miss' })
  })

  it('形式エラー: -1 以外の負数はそのまま code に', async () => {
    wasm.searchRet = -3
    expect(await mod.matchVeinOffline('zz', snapshot(['emp-a', 'emp-b']))).toEqual({ kind: 'invalid_chara', code: -3 })
  })

  it('0 件: Library は最小の 2 で作り、外れになる', async () => {
    const r = await mod.matchVeinOffline('BDBD', snapshot([]))
    expect(r).toEqual({ kind: 'miss' })
    expect(wasm.libraries[0]!.n).toBe(2)
    expect(wasm.libraries[0]!.imported).toEqual([])
  })

  it('1 件: Library は最小の 2 で作る', async () => {
    await mod.matchVeinOffline('BDBD', snapshot(['emp-a']))
    expect(wasm.libraries[0]!.n).toBe(2)
  })

  it('★ 版の不一致: 照合せずに止める (Library を作らない)', async () => {
    wasm.searchRet = 1
    const r = await mod.matchVeinOffline('BDBD', snapshot(['emp-a'], '0.1.0'))
    expect(r).toEqual({ kind: 'version_mismatch', stored: '0.1.0', wasm: '0.1.1' })
    expect(wasm.libraries).toEqual([])
  })

  it('上限 500 件を超えた分は入れない (警告を出す)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ids = Array.from({ length: 501 }, (_, i) => `emp-${i}`)
    wasm.searchRet = 500
    const r = await mod.matchVeinOffline('BDBD', snapshot(ids))
    expect(r).toEqual({ kind: 'hit', employeeId: 'emp-499' })
    expect(wasm.libraries[0]!.n).toBe(500)
    expect(wasm.libraries[0]!.imported).toHaveLength(500)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('上限 500 件'))
    warn.mockRestore()
  })

  it('読めないテンプレートは警告して飛ばし、残りで照合する', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    wasm.importRc.set(1, -2)
    wasm.searchRet = 2
    expect(await mod.matchVeinOffline('BDBD', snapshot(['emp-a', 'emp-b']))).toEqual({ kind: 'hit', employeeId: 'emp-b' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('employee_id=emp-a, rc=-2'))
    warn.mockRestore()
  })

  it('検索が投げても Library を解放する', async () => {
    wasm.searchThrows = true
    await expect(mod.matchVeinOffline('BDBD', snapshot(['emp-a']))).rejects.toThrow('boom')
    expect(wasm.libraries[0]!.freed).toBe(true)
  })
})

describe('vein-match — wasm の読み込み', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    wasm.init.mockImplementation(async () => ({}))
    vi.resetModules()
    mod = await import('~/utils/vein-match')
  })

  it('/vein/ の wasm を初回だけ読み、以後は使い回す', async () => {
    await mod.loadVeinWasm()
    await mod.loadVeinWasm()
    expect(wasm.init).toHaveBeenCalledTimes(1)
    expect(wasm.init).toHaveBeenCalledWith({ module_or_path: '/vein/vein_match_wasm_bg.wasm' })
  })

  it('読み込みに失敗したら投げ、次の呼び出しで読み直す', async () => {
    wasm.init.mockRejectedValueOnce(new Error('offline'))
    await expect(mod.loadVeinWasm()).rejects.toThrow('offline')
    await mod.loadVeinWasm()
    expect(wasm.init).toHaveBeenCalledTimes(2)
  })
})
