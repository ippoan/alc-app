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

  it('未設定・壊れた値は mixed、native だけ native', () => {
    expect(readVeinAddedFingerMode()).toBe('mixed')
    localStorage.setItem(KEY, 'yes')
    expect(readVeinAddedFingerMode()).toBe('mixed')
    localStorage.setItem(KEY, 'native')
    expect(readVeinAddedFingerMode()).toBe('native')
  })

  it('write は localStorage へ保存する', () => {
    writeVeinAddedFingerMode('native')
    expect(localStorage.getItem(KEY)).toBe('native')
    writeVeinAddedFingerMode('mixed')
    expect(localStorage.getItem(KEY)).toBe('mixed')
  })

  it('クライアントでなければ読まず (mixed)、書かない', () => {
    localStorage.setItem(KEY, 'native')
    envMock.isClient = false
    expect(readVeinAddedFingerMode()).toBe('mixed')
    writeVeinAddedFingerMode('mixed')
    expect(localStorage.getItem(KEY)).toBe('native')
  })

  it('localStorage が使えない環境でも投げない', () => {
    const denied = () => { throw new Error('denied') }
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied })
    try {
      expect(readVeinAddedFingerMode()).toBe('mixed')
      expect(() => writeVeinAddedFingerMode('native')).not.toThrow()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})
