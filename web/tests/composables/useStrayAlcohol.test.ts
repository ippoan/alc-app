import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

// useStrayAlcohol はモジュールスコープに latest / seq / wired を持つシングルトン
// なので、テスト毎に resetModules + dynamic import で分離する
// (useCoreS3Stage.test.ts と同型)。useCoreS3Serial は Nuxt auto-import なので
// mockNuxtImport。onJson は解除の口を返さないので、捕まえた handler へ
// テストから直接メッセージを流す。
let jsonHandler: ((msg: unknown) => void) | null = null
const coreS3Mock = vi.hoisted(() => ({
  onJson: vi.fn(),
}))
mockNuxtImport('useCoreS3Serial', () => () => coreS3Mock)

type Mod = typeof import('~/composables/useStrayAlcohol')

async function load(): Promise<Mod> {
  return await import('~/composables/useStrayAlcohol')
}

describe('useStrayAlcohol', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    jsonHandler = null
    coreS3Mock.onJson.mockImplementation((cb: (msg: unknown) => void) => {
      jsonHandler = cb
    })
  })

  it('初期値は null', async () => {
    const { useStrayAlcohol } = await load()
    const { latest } = useStrayAlcohol()
    expect(latest.value).toBeNull()
  })

  it('type:"alcohol" の JSON を latest に載せる', async () => {
    const { useStrayAlcohol } = await load()
    const { latest } = useStrayAlcohol()
    jsonHandler!({ type: 'alcohol', value: 0.15, unit: 'mg/L', result: 'normal', use_count: 5 })
    expect(latest.value).toEqual({
      seq: 1,
      value: 0.15,
      unit: 'mg/L',
      result: 'normal',
      useCount: 5,
      measuredAt: expect.any(Date),
    })
  })

  it('type が alcohol 以外の JSON は無視する', async () => {
    const { useStrayAlcohol } = await load()
    const { latest } = useStrayAlcohol()
    jsonHandler!({ type: 'temperature', value: 36.5, unit: 'celsius' })
    expect(latest.value).toBeNull()
  })

  it('result が無い (壊れた) alcohol JSON は無視する', async () => {
    const { useStrayAlcohol } = await load()
    const { latest } = useStrayAlcohol()
    jsonHandler!({ type: 'alcohol', value: 0.1 })
    expect(latest.value).toBeNull()
  })

  it('msg が null / プリミティブでも落ちない', async () => {
    const { useStrayAlcohol } = await load()
    const { latest } = useStrayAlcohol()
    jsonHandler!(null)
    jsonHandler!('not an object')
    jsonHandler!(123)
    expect(latest.value).toBeNull()
  })

  it('吹込不良 (error) — value 欠落は 0 に倒す', async () => {
    const { useStrayAlcohol } = await load()
    const { latest } = useStrayAlcohol()
    jsonHandler!({ type: 'alcohol', result: 'error', use_count: 2 })
    expect(latest.value).toEqual(expect.objectContaining({ value: 0, result: 'error', useCount: 2 }))
  })

  it('use_count 欠落は useCount 0 に倒す', async () => {
    const { useStrayAlcohol } = await load()
    const { latest } = useStrayAlcohol()
    jsonHandler!({ type: 'alcohol', value: 0.2, result: 'over' })
    expect(latest.value).toEqual(expect.objectContaining({ useCount: 0 }))
  })

  it('届くたびに seq が増える (同じ値が続けて届いても別物として扱う)', async () => {
    const { useStrayAlcohol } = await load()
    const { latest } = useStrayAlcohol()
    jsonHandler!({ type: 'alcohol', value: 0.1, result: 'normal', use_count: 1 })
    expect(latest.value?.seq).toBe(1)
    jsonHandler!({ type: 'alcohol', value: 0.1, result: 'normal', use_count: 1 })
    expect(latest.value?.seq).toBe(2)
  })

  it('onJson の購読は 1 回だけ (複数回呼んでも handler は 1 本)', async () => {
    const { useStrayAlcohol } = await load()
    useStrayAlcohol()
    useStrayAlcohol()
    expect(coreS3Mock.onJson).toHaveBeenCalledTimes(1)
  })
})
