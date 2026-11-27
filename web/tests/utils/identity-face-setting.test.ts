import { describe, it, expect, beforeEach } from 'vitest'
import { readIdentityFaceSource, writeIdentityFaceSource } from '~/utils/identity-face-setting'

describe('identity-face-setting (本人確認の顔を何で残すか。Refs ippoan/alc-app#720)', () => {
  beforeEach(() => localStorage.clear())

  it('既定は端末のカメラ。監視カメラを選ぶと cam を保存し、戻すと消す', () => {
    expect(readIdentityFaceSource()).toBe('kiosk')
    writeIdentityFaceSource('cam')
    expect(localStorage.getItem('alc-identity-face')).toBe('cam')
    expect(readIdentityFaceSource()).toBe('cam')
    writeIdentityFaceSource('kiosk')
    expect(localStorage.getItem('alc-identity-face')).toBeNull()
    expect(readIdentityFaceSource()).toBe('kiosk')
  })

  it('壊れた値は既定の端末のカメラ', () => {
    localStorage.setItem('alc-identity-face', 'x')
    expect(readIdentityFaceSource()).toBe('kiosk')
  })

  it('localStorage が使えなくても投げない (読みは既定)', () => {
    const get = Storage.prototype.getItem
    const set = Storage.prototype.setItem
    Storage.prototype.getItem = () => { throw new Error('denied') }
    Storage.prototype.setItem = () => { throw new Error('denied') }
    try {
      expect(readIdentityFaceSource()).toBe('kiosk')
      expect(() => writeIdentityFaceSource('cam')).not.toThrow()
    }
    finally {
      Storage.prototype.getItem = get
      Storage.prototype.setItem = set
    }
  })
})
