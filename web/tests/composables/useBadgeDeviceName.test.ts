// 右下の版の表示に出す「このページがつかんでいる機体の名前」(Refs ippoan/alc-app-s3#352)。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { flushPromises } from '@vue/test-utils'

const api = vi.hoisted(() => ({ listCamHostKeys: vi.fn(), listDeviceLabels: vi.fn() }))
vi.mock('~/utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  ...api,
}))

import { badgeDeviceText, useBadgeDeviceName } from '~/composables/useBadgeDeviceName'
import { resetDeviceNames } from '~/composables/useDeviceNames'
import { reportedCoreS3DeviceId, reportedVeinDeviceId } from '~/utils/reported-device-id'

const ids = { vein: reportedVeinDeviceId, coreS3: reportedCoreS3DeviceId }

// 架空の指紋 (本番の機体ではない)
const VEIN_ID = 'alarm-0123456789abcdef'

beforeEach(() => {
  resetDeviceNames()
  vi.clearAllMocks()
  ids.vein.value = null
  ids.coreS3.value = null
  api.listDeviceLabels.mockResolvedValue({ devices: [{ device_id: 'cores3-test', label: '事務所の CoreS3' }] })
  api.listCamHostKeys.mockResolvedValue({ keys: [], names: [{ device_id: 'alarm:0123456789abcdef', label: 'vein-事務所' }] })
})

describe('badgeDeviceText', () => {
  it('両方なら「指静脈 / CoreS3」、片方ならそれだけ、どちらも無ければ null', () => {
    expect(badgeDeviceText('vein-a', 'cores3-b')).toBe('vein-a / cores3-b')
    expect(badgeDeviceText('vein-a', null)).toBe('vein-a')
    expect(badgeDeviceText(null, 'cores3-b')).toBe('cores3-b')
    expect(badgeDeviceText(null, null)).toBeNull()
  })
})

describe('useBadgeDeviceName', () => {
  it('どちらも繋がっていなければ (報告の id が無い) 出さず、名前の API も叩かない', async () => {
    const text = useBadgeDeviceName()
    await flushPromises()
    expect(text.value).toBeNull()
    expect(api.listCamHostKeys).not.toHaveBeenCalled()
  })

  it('指静脈端末: 鍵のラベルがあればそれを出す', async () => {
    ids.vein.value = VEIN_ID
    const text = useBadgeDeviceName()
    await flushPromises()
    expect(text.value).toBe('vein-事務所')
  })

  it('指静脈端末: 鍵のラベルが無ければ Vein Station <指紋 8 字>', async () => {
    api.listCamHostKeys.mockResolvedValue({ keys: [], names: [] })
    ids.vein.value = VEIN_ID
    const text = useBadgeDeviceName()
    await flushPromises()
    expect(text.value).toBe('Vein Station 01234567')
  })

  it('CoreS3 だけ: 端末の表示名を出す', async () => {
    ids.coreS3.value = 'cores3-test'
    const text = useBadgeDeviceName()
    await flushPromises()
    expect(text.value).toBe('事務所の CoreS3 (鍵の ID 未登録)')
  })

  it('両方: 「指静脈 / CoreS3」。後から繋がった機体も足し、外れたら消える', async () => {
    ids.vein.value = VEIN_ID
    const text = useBadgeDeviceName()
    await flushPromises()
    expect(text.value).toBe('vein-事務所')
    ids.coreS3.value = 'cores3-test'
    await nextTick()
    await flushPromises()
    expect(text.value).toBe('vein-事務所 / 事務所の CoreS3 (鍵の ID 未登録)')
    ids.vein.value = null
    await nextTick()
    expect(text.value).toBe('事務所の CoreS3 (鍵の ID 未登録)')
    ids.coreS3.value = null
    await nextTick()
    expect(text.value).toBeNull()
  })

  it('名前の表が取れなかったら、次に機体が出たときに読み直す', async () => {
    api.listCamHostKeys.mockRejectedValue(new Error('401'))
    api.listDeviceLabels.mockRejectedValue(new Error('401'))
    ids.vein.value = VEIN_ID
    const text = useBadgeDeviceName()
    await flushPromises()
    expect(text.value).toBe('Vein Station 01234567')
    api.listCamHostKeys.mockResolvedValue({ keys: [], names: [{ device_id: 'alarm:0123456789abcdef', label: 'vein-事務所' }] })
    api.listDeviceLabels.mockResolvedValue({ devices: [] })
    ids.coreS3.value = 'cores3-test'
    await nextTick()
    await flushPromises()
    expect(api.listCamHostKeys).toHaveBeenCalledTimes(2)
    expect(text.value).toBe('vein-事務所 / 名前未登録の端末')
  })
})
