import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const envMock = vi.hoisted(() => ({ isClient: true }))
vi.mock('~/utils/env', () => envMock)

import { readVeinAddedFingerMode, writeVeinAddedFingerMode } from '~/utils/vein-added-finger-mode'

const KEY = 'alc-vein-added-finger'

describe('vein-added-finger-mode (Refs ippoan/alc-app#558)', () => {
  beforeEach(() => {
    envMock.isClient = true
    localStorage.clear()
  })
  afterEach(() => vi.restoreAllMocks())

  it('★ 未設定・壊れた値は native (この端末で撮った記録)、mixed だけ mixed (Refs ippoan/alc-app-s3#352)', () => {
    expect(readVeinAddedFingerMode()).toBe('native')
    localStorage.setItem(KEY, 'yes')
    expect(readVeinAddedFingerMode()).toBe('native')
    localStorage.setItem(KEY, 'mixed')
    expect(readVeinAddedFingerMode()).toBe('mixed')
  })

  it('write は localStorage へ保存する', () => {
    writeVeinAddedFingerMode('native')
    expect(localStorage.getItem(KEY)).toBe('native')
    writeVeinAddedFingerMode('mixed')
    expect(localStorage.getItem(KEY)).toBe('mixed')
  })

  it('クライアントでなければ読まず (native)、書かない', () => {
    localStorage.setItem(KEY, 'mixed')
    envMock.isClient = false
    expect(readVeinAddedFingerMode()).toBe('native')
    writeVeinAddedFingerMode('native')
    expect(localStorage.getItem(KEY)).toBe('mixed')
  })

  it('localStorage が使えない環境でも投げない', () => {
    const denied = () => { throw new Error('denied') }
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied })
    try {
      expect(readVeinAddedFingerMode()).toBe('native')
      expect(() => writeVeinAddedFingerMode('mixed')).not.toThrow()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})
