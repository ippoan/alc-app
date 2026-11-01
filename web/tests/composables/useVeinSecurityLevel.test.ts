import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import type { EffectScope } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { parseVeinSecuritySetting } from '~/utils/vein-security-level'

// 指静脈モジュールの照合の厳しさを端末設定に合わせる (Refs ippoan/alc-app-s3#352)
const connected = ref(false)
const security = vi.fn(async (level?: number) => level ?? 1)
mockNuxtImport('useVeinSerial', () => () => ({ isConnected: connected, security }))

const KEY = 'alc-vein-security-level'

describe('parseVeinSecuritySetting', () => {
  it('0〜2 は数、それ以外は keep', () => {
    expect(parseVeinSecuritySetting('0')).toBe(0)
    expect(parseVeinSecuritySetting('2')).toBe(2)
    for (const v of ['keep', '3', '', null, undefined, '01']) expect(parseVeinSecuritySetting(v)).toBe('keep')
  })
})

describe('useVeinSecurityLevel', () => {
  let useVeinSecurityLevel: typeof import('~/composables/useVeinSecurityLevel').useVeinSecurityLevel
  // start() の watch は試験ごとに片付ける (前の試験の watch が connected の変化で動かないように)
  let scope: EffectScope
  const start = (s: ReturnType<typeof useVeinSecurityLevel>) => scope.run(() => s.start())
  afterEach(() => scope.stop())
  beforeEach(async () => {
    scope = effectScope()
    localStorage.clear()
    connected.value = false
    security.mockReset()
    security.mockImplementation(async (level?: number) => level ?? 1)
    vi.resetModules()
    useVeinSecurityLevel = (await import('~/composables/useVeinSecurityLevel')).useVeinSecurityLevel
  })

  it('未設定は keep: つながったら読むだけで書かない', async () => {
    const s = useVeinSecurityLevel()
    start(s)
    expect(s.setting.value).toBe('keep')
    connected.value = true
    await nextTick()
    await vi.waitFor(() => expect(s.moduleLevel.value).toBe(1))
    expect(security).toHaveBeenCalledTimes(1)
    expect(security).toHaveBeenCalledWith()
    connected.value = false
    await nextTick()
    expect(s.moduleLevel.value).toBeNull()
  })

  it('★ 設定が 0 なら、つながったときモジュールが 1 なら 0 を書く。同じなら書かない', async () => {
    localStorage.setItem(KEY, '0')
    const s = useVeinSecurityLevel()
    start(s)
    connected.value = true
    await nextTick()
    await vi.waitFor(() => expect(s.moduleLevel.value).toBe(0))
    expect(security.mock.calls).toEqual([[], [0]])
    security.mockClear()
    security.mockImplementation(async () => 0)
    expect(await s.apply()).toBe(0)
    expect(security.mock.calls).toEqual([[]])
  })

  it('設定を変えると保存し、つながっていればその場で書く。つながっていなければ送らない', async () => {
    const s = useVeinSecurityLevel()
    s.setSetting(2)
    expect(localStorage.getItem(KEY)).toBe('2')
    expect(security).not.toHaveBeenCalled()
    connected.value = true
    s.setSetting(0)
    await vi.waitFor(() => expect(s.moduleLevel.value).toBe(0))
    expect(security.mock.calls).toEqual([[], [0]])
  })

  it('古いファーム・失敗は null で黙って続ける', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    security.mockRejectedValue(new Error('VEIN: CAPTURE|SAY が必要です'))
    connected.value = true
    expect(await useVeinSecurityLevel().apply()).toBeNull()
  })
})
