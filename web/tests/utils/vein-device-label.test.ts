import { describe, it, expect } from 'vitest'
import { sameVeinDevice, veinDeviceLabel } from '~/utils/vein-device-label'

// 指静脈の記録を登録した端末の見せ方 (Refs ippoan/alc-app#436)。値は合成
describe('veinDeviceLabel', () => {
  it('鍵の端末は Vein Station と指紋の頭 8 桁 (alarm: でも alarm- でも)', () => {
    expect(veinDeviceLabel('alarm:0123456789abcdef')).toBe('Vein Station 01234567')
    expect(veinDeviceLabel('alarm-0123456789abcdef')).toBe('Vein Station 01234567')
  })
  it('鍵のラベルが引けていればそれ。引けなければ (null / 未指定) 今の短い表記。id が無ければラベルがあっても不明', () => {
    expect(veinDeviceLabel('alarm:0123456789abcdef', '帯広の Vein Station')).toBe('帯広の Vein Station')
    expect(veinDeviceLabel('alarm:0123456789abcdef', null)).toBe('Vein Station 01234567')
    expect(veinDeviceLabel(null, 'ラベル')).toBe('不明')
  })
  it('それ以外は頭 8 文字、無ければ不明', () => {
    expect(veinDeviceLabel('kiosk-123456789')).toBe('kiosk-12')
    expect(veinDeviceLabel(null)).toBe('不明')
    expect(veinDeviceLabel(undefined)).toBe('不明')
    expect(veinDeviceLabel('')).toBe('不明')
  })
})

describe('sameVeinDevice', () => {
  it('alarm: と alarm- の違いを無視して比べる。片方が無ければ false', () => {
    expect(sameVeinDevice('alarm:0123456789abcdef', 'alarm-0123456789abcdef')).toBe(true)
    expect(sameVeinDevice('kiosk-1', 'kiosk-1')).toBe(true)
    expect(sameVeinDevice('kiosk-1', 'kiosk-2')).toBe(false)
    expect(sameVeinDevice(null, 'kiosk-1')).toBe(false)
    expect(sameVeinDevice('kiosk-1', undefined)).toBe(false)
  })
})
