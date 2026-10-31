import { describe, it, expect, beforeEach } from 'vitest'
import { useVeinAddedFingerSetting } from '~/composables/useVeinAddedFingerSetting'

const KEY = 'alc-vein-added-finger'

describe('useVeinAddedFingerSetting (Refs ippoan/alc-app#558)', () => {
  beforeEach(() => localStorage.clear())

  it('未設定は mixed (混ぜた記録)', () => {
    expect(useVeinAddedFingerSetting().mode.value).toBe('mixed')
  })

  it('保存された native を読む', () => {
    localStorage.setItem(KEY, 'native')
    expect(useVeinAddedFingerSetting().mode.value).toBe('native')
  })

  it('setMode は即時に反映し、localStorage へ保存する。別の呼び出し元からも同じ値が見える', () => {
    const a = useVeinAddedFingerSetting()
    const b = useVeinAddedFingerSetting()
    a.setMode('native')
    expect(b.mode.value).toBe('native')
    expect(localStorage.getItem(KEY)).toBe('native')
    a.setMode('mixed')
    expect(b.mode.value).toBe('mixed')
    expect(localStorage.getItem(KEY)).toBe('mixed')
  })
})
