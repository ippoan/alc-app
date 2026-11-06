import { describe, it, expect, beforeEach } from 'vitest'
import { readVeinRotateEnabled, writeVeinRotateEnabled } from '~/utils/vein-rotate-setting'

describe('vein-rotate-setting', () => {
  beforeEach(() => localStorage.clear())

  it('既定は入れ替える。止めると 0 を保存し、戻すと消す', () => {
    expect(readVeinRotateEnabled()).toBe(true)
    writeVeinRotateEnabled(false)
    expect(localStorage.getItem('alc-vein-rotate')).toBe('0')
    expect(readVeinRotateEnabled()).toBe(false)
    writeVeinRotateEnabled(true)
    expect(localStorage.getItem('alc-vein-rotate')).toBeNull()
    expect(readVeinRotateEnabled()).toBe(true)
  })

  it('localStorage が使えなくても投げない (読みは既定の true)', () => {
    const get = Storage.prototype.getItem
    const set = Storage.prototype.setItem
    Storage.prototype.getItem = () => { throw new Error('denied') }
    Storage.prototype.setItem = () => { throw new Error('denied') }
    try {
      expect(readVeinRotateEnabled()).toBe(true)
      expect(() => writeVeinRotateEnabled(false)).not.toThrow()
    }
    finally {
      Storage.prototype.getItem = get
      Storage.prototype.setItem = set
    }
  })
})
