// 端末の id の短縮形 (「端末のファーム」一覧と右下の版の表示で共通。Refs ippoan/alc-app-s3#352)
import { describe, it, expect } from 'vitest'
import { shortDeviceId } from '~/utils/short-device-id'

describe('shortDeviceId', () => {
  it('12 文字以下はそのまま', () => {
    expect(shortDeviceId('cores3-test')).toBe('cores3-test')
    expect(shortDeviceId('abcdefghijkl')).toBe('abcdefghijkl')
  })

  it('12 文字を超えたら先頭 12 文字 + 「…」', () => {
    expect(shortDeviceId('abcdefghijklm')).toBe('abcdefghijkl…')
    expect(shortDeviceId('alarm-0123456789abcdef')).toBe('alarm-012345…')
  })
})
