// 名前の表 (機体の鍵のラベル + 登録簿) を 1 回だけ取って使い回す composable (Refs ippoan/alc-cam#2)。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'

const api = vi.hoisted(() => ({ listCamHostKeys: vi.fn(), listDeviceLabels: vi.fn() }))
vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  ...api,
}))

import { loadDeviceNames, resetDeviceNames, useDeviceNames } from '~/composables/useDeviceNames'

beforeEach(() => {
  resetDeviceNames()
  vi.clearAllMocks()
  api.listDeviceLabels.mockResolvedValue({ devices: [{ device_id: 'cores3-a', label: '旧ハブ' }] })
  api.listCamHostKeys.mockResolvedValue({
    keys: [{ device_id: 'alarm:a', label: '事務所' }],
    names: [{ device_id: 'alarm:a', label: '事務所' }, { device_id: 'alarm:old', label: '旧機', revoked: true }],
  })
})

describe('useDeviceNames', () => {
  it('名前の表を引き、名前・鍵のラベル・担当付けの鍵を返す (届くと自動で替わる)', async () => {
    const { nameOf, keyLabelOf, keys, ready } = useDeviceNames()
    expect(nameOf('alarm:a')).toBe('名前未登録の端末')
    await ready
    expect(nameOf('alarm:a')).toBe('事務所')
    expect(nameOf('alarm:old')).toBe('旧機 (失効)')
    expect(nameOf('cores3-a')).toBe('旧ハブ (鍵の ID 未登録)')
    expect(keyLabelOf('alarm:a')).toBe('事務所')
    expect(keyLabelOf('cores3-a')).toBeNull()
    expect(keyLabelOf(null)).toBeNull()
    expect(keys.value).toEqual([{ device_id: 'alarm:a', label: '事務所' }])
  })

  it('何度使っても API は 1 回ずつ (使い回す)。force で引き直す', async () => {
    await useDeviceNames().ready
    await useDeviceNames().ready
    await loadDeviceNames()
    expect(api.listCamHostKeys).toHaveBeenCalledTimes(1)
    expect(api.listDeviceLabels).toHaveBeenCalledTimes(1)
    await loadDeviceNames(true)
    expect(api.listCamHostKeys).toHaveBeenCalledTimes(2)
  })

  it('names が無い応答 (古い API) は鍵の名前なし。片方だけ失敗しても取れたほうは使う', async () => {
    api.listCamHostKeys.mockResolvedValue({ keys: [] })
    api.listDeviceLabels.mockRejectedValue(new Error('403'))
    const { nameOf, keyNames, registry, ready } = useDeviceNames()
    await ready
    expect(keyNames.value).toEqual([])
    expect(registry.value).toEqual([])
    expect(nameOf('alarm:a')).toBe('名前未登録の端末')
  })

  it('API の呼び出しが同期的に投げても失敗として扱う (loading は reject にならない)', async () => {
    api.listCamHostKeys.mockImplementation(() => { throw new Error('ログインが必要です') })
    api.listDeviceLabels.mockImplementation(() => { throw new Error('ログインが必要です') })
    await expect(useDeviceNames().ready).resolves.toBeUndefined()
  })

  it('両方失敗したら覚えず、次に使うときに引き直す', async () => {
    api.listCamHostKeys.mockRejectedValue(new Error('x'))
    api.listDeviceLabels.mockRejectedValue(new Error('y'))
    await useDeviceNames().ready
    await flushPromises()
    api.listCamHostKeys.mockResolvedValue({ keys: [], names: [{ device_id: 'alarm:a', label: '事務所' }] })
    api.listDeviceLabels.mockResolvedValue({ devices: [] })
    const { nameOf, ready } = useDeviceNames()
    await ready
    expect(nameOf('alarm:a')).toBe('事務所')
    expect(api.listCamHostKeys).toHaveBeenCalledTimes(2)
  })
})
