import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

const deviceId = ref<string | null>('device-1')
const deviceSettingsToken = ref<string | null>('tok-1')
mockNuxtImport('useAuth', () => () => ({ deviceId, deviceSettingsToken }))

// 端末設定 (サーバ) — 血圧計を使うかの正本は `devices.bp_enabled`
const api = vi.hoisted(() => ({ getDeviceSettings: vi.fn() }))
vi.mock('~/utils/api', async original => ({
  ...(await original() as object),
  getDeviceSettings: api.getDeviceSettings,
}))
const deviceSettingsResponse = (bp: boolean) => ({
  call_enabled: true,
  call_schedule: null,
  status: 'approved',
  always_on: false,
  bp_enabled: bp,
})

/** 「初回に 1 回だけ」は module スコープで数えるので、毎回まっさらに読み直す */
async function freshComposable() {
  vi.resetModules()
  const mod = await import('~/composables/useBloodPressureSetting')
  return mod.useBloodPressureSetting
}

/** 初回読み込み (await しない async) を流し切る */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('useBloodPressureSetting — 血圧計を使うかの受け口は 1 本 (Refs ippoan/alc-app-s3#135)', () => {
  beforeEach(() => {
    deviceId.value = 'device-1'
    deviceSettingsToken.value = 'tok-1'
    api.getDeviceSettings.mockReset()
    api.getDeviceSettings.mockResolvedValue(deviceSettingsResponse(false))
  })

  it('サーバ設定が届くまでの既定は false (血圧計を繋いでいない端末)', async () => {
    const useBloodPressureSetting = await freshComposable()
    expect(useBloodPressureSetting().bpEnabled.value).toBe(false)
  })

  it('setBpEnabled で流し込んだ値を、別の呼び出し元も同じように見る', async () => {
    const useBloodPressureSetting = await freshComposable()
    const a = useBloodPressureSetting()
    const b = useBloodPressureSetting()
    a.setBpEnabled(true)
    expect(a.bpEnabled.value).toBe(true)
    expect(b.bpEnabled.value).toBe(true)

    b.setBpEnabled(false)
    expect(a.bpEnabled.value).toBe(false)
  })

  it('(受け口) 最初に使われたときにサーバの設定を 1 回だけ読む', async () => {
    api.getDeviceSettings.mockResolvedValue(deviceSettingsResponse(true))
    const useBloodPressureSetting = await freshComposable()

    // 端末設定の画面を開かない端末 (キオスク) でも、血圧を使う画面が引き金になる
    const bp = useBloodPressureSetting()
    await flush()

    expect(api.getDeviceSettings).toHaveBeenCalledTimes(1)
    expect(api.getDeviceSettings).toHaveBeenCalledWith('device-1', 'tok-1')
    expect(bp.bpEnabled.value).toBe(true)
  })

  it('(受け口) 2 回使われても取得は 1 回', async () => {
    api.getDeviceSettings.mockResolvedValue(deviceSettingsResponse(true))
    const useBloodPressureSetting = await freshComposable()

    useBloodPressureSetting()
    useBloodPressureSetting()
    await flush()

    expect(api.getDeviceSettings).toHaveBeenCalledTimes(1)
  })

  it('(受け口) 取得に失敗しても既定のまま進む', async () => {
    api.getDeviceSettings.mockRejectedValue(new Error('offline'))
    const useBloodPressureSetting = await freshComposable()

    const bp = useBloodPressureSetting()
    await flush()

    expect(bp.bpEnabled.value).toBe(false)
  })

  it('(受け口) 端末登録が無ければ読みに行かない', async () => {
    deviceId.value = null
    const useBloodPressureSetting = await freshComposable()

    const bp = useBloodPressureSetting()
    await flush()

    expect(api.getDeviceSettings).not.toHaveBeenCalled()
    expect(bp.bpEnabled.value).toBe(false)
  })

  it('(受け口) 待っている間に端末設定の画面から決まっていたら上書きしない', async () => {
    api.getDeviceSettings.mockResolvedValue(deviceSettingsResponse(false))
    const useBloodPressureSetting = await freshComposable()

    const bp = useBloodPressureSetting()
    bp.setBpEnabled(true) // 画面で ON にした直後に、古い取得が返ってくる
    await flush()

    expect(bp.bpEnabled.value).toBe(true)
  })
})
