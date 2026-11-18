// 右下の版の表示に出す「このページがつかんでいる機体の名前」(Refs ippoan/alc-app-s3#352)。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope, nextTick, type EffectScope } from 'vue'
import { flushPromises } from '@vue/test-utils'

const api = vi.hoisted(() => ({ getDeviceName: vi.fn(), listCamHostKeys: vi.fn(), listDeviceLabels: vi.fn() }))
vi.mock('~/utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  ...api,
}))

import { badgeDeviceText, useBadgeDeviceName as useBadgeDeviceNameRaw } from '~/composables/useBadgeDeviceName'
import { reportedCoreS3DeviceId, reportedVeinDeviceId } from '~/utils/reported-device-id'

const ids = { vein: reportedVeinDeviceId, coreS3: reportedCoreS3DeviceId }

// 架空の指紋 (本番の機体ではない)
const VEIN_ID = 'alarm-0123456789abcdef'
const NAMES: Record<string, string | null> = { [VEIN_ID]: 'vein-事務所', 'cores3-test': '事務所の CoreS3' }

// 前のテストの watch が id の変化に反応しないよう、テストごとの scope で生成して止める
let scope: EffectScope | null = null
function useBadgeDeviceName() {
  scope = effectScope()
  return scope.run(() => useBadgeDeviceNameRaw())!
}
afterEach(() => {
  scope?.stop()
  scope = null
})

beforeEach(() => {
  vi.clearAllMocks()
  ids.vein.value = null
  ids.coreS3.value = null
  api.getDeviceName.mockImplementation(async (id: string) => ({ device_id: id, name: NAMES[id] ?? null }))
})

describe('badgeDeviceText', () => {
  const vein = { name: 'vein-a', id: 'alarm-0123456789abcdef' }
  const coreS3 = { name: 'cores3-b', id: 'cores3-test' }

  it('名前の後ろに id の短縮形を括弧で付け、title には id の全文を入れる', () => {
    expect(badgeDeviceText(vein, null)).toEqual({
      text: 'vein-a (alarm-012345…)',
      title: 'vein-a (alarm-0123456789abcdef)',
    })
    // 12 文字以下の id は省略しない
    expect(badgeDeviceText(null, coreS3)).toEqual({ text: 'cores3-b (cores3-test)', title: 'cores3-b (cores3-test)' })
  })

  it('両方なら「指静脈 / CoreS3」で各名前の後ろに付け、どちらも無ければ null', () => {
    expect(badgeDeviceText(vein, coreS3)).toEqual({
      text: 'vein-a (alarm-012345…) / cores3-b (cores3-test)',
      title: 'vein-a (alarm-0123456789abcdef) / cores3-b (cores3-test)',
    })
    expect(badgeDeviceText(null, null)).toBeNull()
  })
})

describe('useBadgeDeviceName', () => {
  it('どちらも繋がっていなければ (報告の id が無い) 出さず、名前の API も叩かない', async () => {
    const text = useBadgeDeviceName()
    await flushPromises()
    expect(text.value).toBeNull()
    expect(api.getDeviceName).not.toHaveBeenCalled()
  })

  it('★ 指静脈端末: 自分の端末 1 台の名前の口から引いた名前を出す (管理者限定の一覧は読まない)', async () => {
    ids.vein.value = VEIN_ID
    const text = useBadgeDeviceName()
    await flushPromises()
    expect(text.value?.text).toBe('vein-事務所 (alarm-012345…)')
    expect(api.getDeviceName).toHaveBeenCalledWith(VEIN_ID)
    expect(api.listCamHostKeys).not.toHaveBeenCalled()
    expect(api.listDeviceLabels).not.toHaveBeenCalled()
  })

  it('指静脈端末: 名前が null なら Vein Station <指紋 8 字>', async () => {
    api.getDeviceName.mockResolvedValue({ device_id: VEIN_ID, name: null })
    ids.vein.value = VEIN_ID
    const text = useBadgeDeviceName()
    await flushPromises()
    expect(text.value?.text).toBe('Vein Station 01234567 (alarm-012345…)')
  })

  it('CoreS3: 名前を出し、null なら「名前未登録の端末」', async () => {
    ids.coreS3.value = 'cores3-test'
    const text = useBadgeDeviceName()
    await flushPromises()
    expect(text.value?.text).toBe('事務所の CoreS3 (cores3-test)')
    ids.coreS3.value = 'cores3-other'
    await nextTick()
    await flushPromises()
    expect(text.value?.text).toBe('名前未登録の端末 (cores3-other)')
  })

  it('両方: 「指静脈 / CoreS3」。後から繋がった機体も足し、外れたら消える', async () => {
    ids.vein.value = VEIN_ID
    const text = useBadgeDeviceName()
    await flushPromises()
    expect(text.value?.text).toBe('vein-事務所 (alarm-012345…)')
    ids.coreS3.value = 'cores3-test'
    await nextTick()
    await flushPromises()
    expect(text.value?.text).toBe('vein-事務所 (alarm-012345…) / 事務所の CoreS3 (cores3-test)')
    expect(text.value?.title).toBe('vein-事務所 (alarm-0123456789abcdef) / 事務所の CoreS3 (cores3-test)')
    ids.vein.value = null
    await nextTick()
    expect(text.value?.text).toBe('事務所の CoreS3 (cores3-test)')
    ids.coreS3.value = null
    await nextTick()
    expect(text.value).toBeNull()
  })

  it('★ id ごとに 1 回だけ引く (null の答えも覚える。引いている間に同じ id が来ても重ねない)', async () => {
    let resolve!: (v: { device_id: string, name: string | null }) => void
    api.getDeviceName.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    ids.coreS3.value = 'cores3-other'
    const text = useBadgeDeviceName()
    // 引いている間に別の id の変化が来ても、同じ id は重ねて引かない
    ids.vein.value = VEIN_ID
    await nextTick()
    resolve({ device_id: 'cores3-other', name: null })
    await flushPromises()
    ids.vein.value = null
    await nextTick()
    ids.vein.value = VEIN_ID
    await nextTick()
    await flushPromises()
    expect(api.getDeviceName.mock.calls.map(c => c[0])).toEqual(['cores3-other', VEIN_ID])
    expect(text.value?.text).toBe('vein-事務所 (alarm-012345…) / 名前未登録の端末 (cores3-other)')
  })

  it('引けなかった id は覚えず、次に id が変わったときに引き直す', async () => {
    api.getDeviceName.mockRejectedValueOnce(new Error('401'))
    ids.vein.value = VEIN_ID
    const text = useBadgeDeviceName()
    await flushPromises()
    expect(text.value?.text).toBe('Vein Station 01234567 (alarm-012345…)')
    ids.coreS3.value = 'cores3-test'
    await nextTick()
    await flushPromises()
    expect(api.getDeviceName).toHaveBeenCalledTimes(3)
    expect(text.value?.text).toBe('vein-事務所 (alarm-012345…) / 事務所の CoreS3 (cores3-test)')
  })
})
