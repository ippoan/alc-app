// 人の目に触れる端末 ID を名前に揃える共通部品 (Refs ippoan/alc-cam#2)。値は合成
import { describe, it, expect } from 'vitest'
import {
  BROWSER_DEVICE_NAME, deviceDisplayName, isKeyDeviceId, keyDeviceLabel, KEY_UNREGISTERED_SUFFIX, UNNAMED_DEVICE,
} from '~/utils/device-name'

const FP = '0666000000000000'

describe('isKeyDeviceId', () => {
  it('機体の鍵 (alarm: / alarm-) だけ true', () => {
    expect(isKeyDeviceId(`alarm:${FP}`)).toBe(true)
    expect(isKeyDeviceId(`alarm-${FP}`)).toBe(true)
    expect(isKeyDeviceId('cores3-a')).toBe(false)
    expect(isKeyDeviceId('browser')).toBe(false)
  })
})

describe('keyDeviceLabel', () => {
  it('鍵のラベル。失効は「 (失効)」。alarm: と alarm- の違いを吸収。label 無しの行は飛ばす。無ければ null', () => {
    const keys = [
      { device_id: `alarm:${FP}`, label: null },
      { device_id: `alarm:${FP}`, label: 'VoiceS3R' },
      { device_id: 'alarm:old', label: '旧機', revoked: true },
      { device_id: 'alarm:new', label: '現役', revoked: false },
    ]
    expect(keyDeviceLabel(`alarm-${FP}`, keys)).toBe('VoiceS3R')
    expect(keyDeviceLabel('alarm:old', keys)).toBe('旧機 (失効)')
    expect(keyDeviceLabel('alarm:new', keys)).toBe('現役')
    expect(keyDeviceLabel('alarm:none', keys)).toBeNull()
  })
})

describe('deviceDisplayName (browser → 鍵 → 登録簿 → 名前未登録)', () => {
  const keys = [{ device_id: 'alarm:a', label: '事務所の機体' }]
  const registry = [{ device_id: 'cores3-a', label: '旧ハブ' }, { device_id: 'cores3-b', label: null }, { device_id: 'alarm:a', label: '登録簿の別名' }]

  it('browser は鍵・登録簿に何があっても固定の名前', () => {
    expect(deviceDisplayName('browser', keys, [{ device_id: 'browser', label: '別名' }])).toBe(BROWSER_DEVICE_NAME)
  })
  it('鍵の ID は鍵のラベル。登録簿のラベルは使わない。引けなければ名前未登録', () => {
    expect(deviceDisplayName('alarm:a', keys, registry)).toBe('事務所の機体')
    expect(deviceDisplayName('alarm:zzz', keys, registry)).toBe(UNNAMED_DEVICE)
  })
  it('結び付きの無い hub の ID は登録簿のラベル + 「(鍵の ID 未登録)」', () => {
    expect(deviceDisplayName('cores3-a', keys, registry)).toBe(`旧ハブ ${KEY_UNREGISTERED_SUFFIX}`)
    expect(deviceDisplayName('cores3-a', keys, registry)).toBe('旧ハブ (鍵の ID 未登録)')
  })
  it('どれにも無い・登録簿の label が無い・登録簿を渡さない → 名前未登録の端末', () => {
    expect(deviceDisplayName('cores3-b', keys, registry)).toBe('名前未登録の端末')
    expect(deviceDisplayName('cores3-z', keys, registry)).toBe('名前未登録の端末')
    expect(deviceDisplayName('cores3-a', keys)).toBe('名前未登録の端末')
  })
})
