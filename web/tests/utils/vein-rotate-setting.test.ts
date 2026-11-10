import { describe, it, expect, beforeEach } from 'vitest'
import { readVeinRotateEnabled, writeVeinRotateEnabled } from '~/utils/vein-rotate-setting'

describe('vein-rotate-setting', () => {
  beforeEach(() => localStorage.clear())

  it('既定は入れ替えない。入れると 1 を保存し、止めると消す', () => {
    expect(readVeinRotateEnabled()).toBe(false)
    writeVeinRotateEnabled(true)
    expect(localStorage.getItem('alc-vein-rotate')).toBe('1')
    expect(readVeinRotateEnabled()).toBe(true)
    writeVeinRotateEnabled(false)
    expect(localStorage.getItem('alc-vein-rotate')).toBeNull()
    expect(readVeinRotateEnabled()).toBe(false)
  })

  it('前の既定で止めた端末 (0) も、壊れた値も入れ替えない', () => {
    localStorage.setItem('alc-vein-rotate', '0')
    expect(readVeinRotateEnabled()).toBe(false)
    localStorage.setItem('alc-vein-rotate', 'yes')
    expect(readVeinRotateEnabled()).toBe(false)
  })

  it('localStorage が使えなくても投げない (読みは既定の false)', () => {
    const get = Storage.prototype.getItem
    const set = Storage.prototype.setItem
    Storage.prototype.getItem = () => { throw new Error('denied') }
    Storage.prototype.setItem = () => { throw new Error('denied') }
    try {
      expect(readVeinRotateEnabled()).toBe(false)
      expect(() => writeVeinRotateEnabled(true)).not.toThrow()
    }
    finally {
      Storage.prototype.getItem = get
      Storage.prototype.setItem = set
    }
  })
})
