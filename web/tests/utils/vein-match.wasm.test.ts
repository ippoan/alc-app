import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { initSync, logic_version, VeinLibrary } from '~/vendor/vein-match/vein_match_wasm'

// 同梱した本物の wasm (`public/vein/`) が glue (`app/vendor/vein-match/`) で読めること
// (Refs ippoan/vein-match#20)。glue と本体の組み合わせを取り違えると、ここで初期化が落ちる。
// 版を上げたら期待値を README (`app/vendor/vein-match/README.md`) と一緒に書き換える

const WASM_PATH = resolve(import.meta.dirname, '../../public/vein/vein_match_wasm_bg.wasm')

describe('同梱の vein-match wasm', () => {
  initSync({ module: readFileSync(WASM_PATH) })

  it('logic_version() が 0.1.1', () => {
    expect(logic_version()).toBe('0.1.1')
  })

  it('空の Library で search_user_hex は外れ (-1) か形式エラー (負数) を返し、当たりは返さない', () => {
    const lib = new VeinLibrary(2)
    try {
      const result = lib.search_user_hex('BDBD', 2, undefined)
      expect(result.ret).toBeLessThan(0)
      result.free()
    }
    finally {
      lib.free()
    }
  })

  it('Library の件数は 2..=500 (範囲外は投げる)', () => {
    expect(() => new VeinLibrary(1)).toThrow()
    expect(() => new VeinLibrary(501)).toThrow()
  })
})
