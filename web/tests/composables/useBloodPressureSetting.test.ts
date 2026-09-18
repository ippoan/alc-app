import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, readonly } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

const deviceId = ref<string | null>('device-1')
const deviceSettingsToken = ref<string | null>('tok-1')
mockNuxtImport('useAuth', () => () => ({ deviceId, deviceSettingsToken }))

// 端末の血圧計のヒント (gateway の bp_bond 通知 or 実接続)
const hasBpHardware = ref(false)
mockNuxtImport('useBleGateway', () => () => ({ hasBpHardware: readonly(hasBpHardware) }))

// 署名つきでサーバへ渡したボンド状態 (Refs ippoan/alc-app#336 / #347)
const signedBpBonded = ref<boolean | null>(null)
const hasProbedBpBond = ref(false)
mockNuxtImport('useDeviceToken', () => () => ({
  signedBpBonded: readonly(signedBpBonded),
  hasProbedBpBond: readonly(hasProbedBpBond),
}))

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
async function freshModule() {
  vi.resetModules()
  return await import('~/composables/useBloodPressureSetting')
}
async function freshComposable() {
  return (await freshModule()).useBloodPressureSetting
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

  // ---------- bpConfirmed (Refs ippoan/alc-app#322) ----------
  // 「サーバが false と答えた」と「まだサーバに聞けていない」を画面が区別するための公開

  describe('bpConfirmed — サーバの設定が決まったか', () => {
    it('サーバ設定が届くまでは false', async () => {
      api.getDeviceSettings.mockImplementation(() => new Promise(() => {})) // 未解決のまま
      const useBloodPressureSetting = await freshComposable()

      expect(useBloodPressureSetting().bpConfirmed.value).toBe(false)
    })

    it('サーバ設定が届くと true (bp_enabled=false でも true)', async () => {
      api.getDeviceSettings.mockResolvedValue(deviceSettingsResponse(false))
      const useBloodPressureSetting = await freshComposable()

      const bp = useBloodPressureSetting()
      await flush()

      expect(bp.bpConfirmed.value).toBe(true)
      expect(bp.bpEnabled.value).toBe(false)
    })

    it('端末設定の画面で setBpEnabled が呼ばれても true', async () => {
      deviceId.value = null // サーバ読み込みは走らせない
      const useBloodPressureSetting = await freshComposable()

      const bp = useBloodPressureSetting()
      bp.setBpEnabled(true)

      expect(bp.bpConfirmed.value).toBe(true)
    })

    it('端末登録が無く読みに行けない → false のまま (「未登録」を画面が判別できる)', async () => {
      deviceId.value = null
      const useBloodPressureSetting = await freshComposable()

      const bp = useBloodPressureSetting()
      await flush()

      expect(bp.bpConfirmed.value).toBe(false)
    })

    it('取得に失敗した → false のまま (「取得失敗」を画面が判別できる)', async () => {
      api.getDeviceSettings.mockRejectedValue(new Error('offline'))
      const useBloodPressureSetting = await freshComposable()

      const bp = useBloodPressureSetting()
      await flush()

      expect(bp.bpConfirmed.value).toBe(false)
    })
  })
})

// ---------- useBpUiEnabled (Refs ippoan/alc-app#347) ----------
// 「この端末で血圧を使うか」を 1 か所で決める。CoreS3 キオスクは deviceId が構造的に
// 空で bpEnabled が永久に false、bp_bond 通知も取りこぼすので、署名済みの値を足す。

describe('useBpUiEnabled — 血圧を使うかの判定 1 か所 (Refs ippoan/alc-app#347)', () => {
  beforeEach(() => {
    deviceId.value = 'device-1'
    deviceSettingsToken.value = 'tok-1'
    hasBpHardware.value = false
    signedBpBonded.value = null
    hasProbedBpBond.value = false
    api.getDeviceSettings.mockReset()
    api.getDeviceSettings.mockResolvedValue(deviceSettingsResponse(false))
  })

  /** サーバ読み込みを走らせないまま (= bpConfirmed false) 判定を取る */
  async function unconfirmed() {
    deviceId.value = null
    const mod = await freshModule()
    return mod.useBpUiEnabled()
  }

  it('サーバが bp_enabled=true と答えたら show', async () => {
    api.getDeviceSettings.mockResolvedValue(deviceSettingsResponse(true))
    const mod = await freshModule()
    const bp = mod.useBpUiEnabled()
    await flush()

    expect(bp.bpUiState.value).toBe('show')
    expect(bp.showBpUi.value).toBe(true)
  })

  it('血圧計のヒント (hasBpHardware) だけでも show (未登録端末を締め出さない、Refs #322)', async () => {
    hasBpHardware.value = true
    const bp = await unconfirmed()

    expect(bp.bpUiState.value).toBe('show')
    expect(bp.showBpUi.value).toBe(true)
  })

  it('★ 署名済みのボンド状態が true なら show (CoreS3 キオスクの症状そのもの、Refs #347)', async () => {
    signedBpBonded.value = true
    hasProbedBpBond.value = true
    const bp = await unconfirmed()

    expect(bp.bpUiState.value).toBe('show')
    expect(bp.showBpUi.value).toBe(true)
  })

  it('サーバが bp_enabled=false と答えたら unused', async () => {
    const mod = await freshModule()
    const bp = mod.useBpUiEnabled()
    await flush()

    expect(bp.bpUiState.value).toBe('unused')
    expect(bp.showBpUi.value).toBe(false)
  })

  it('署名で「血圧計は無い」と確認できたら unused (取りに行った後の false)', async () => {
    signedBpBonded.value = false
    hasProbedBpBond.value = true
    const bp = await unconfirmed()

    expect(bp.bpUiState.value).toBe('unused')
  })

  it('★ まだ取りに行っていないあいだは checking — 未使用に倒さない (Refs #347)', async () => {
    const bp = await unconfirmed()

    expect(bp.bpUiState.value).toBe('checking')
    expect(bp.showBpUi.value).toBe(false)
  })

  it('★ 取りに行く前の false は unused にしない (hasProbedBpBond=false なら checking)', async () => {
    signedBpBonded.value = false
    hasProbedBpBond.value = false
    const bp = await unconfirmed()

    expect(bp.bpUiState.value).toBe('checking')
  })

  it('取りに行っても分からず、ブラウザ側の端末登録も無い → unregistered', async () => {
    hasProbedBpBond.value = true
    const bp = await unconfirmed()

    expect(bp.bpUiState.value).toBe('unregistered')
  })

  it('取りに行っても分からず、端末登録はあるがサーバ設定が取れない → unavailable', async () => {
    api.getDeviceSettings.mockRejectedValue(new Error('offline'))
    hasProbedBpBond.value = true
    const mod = await freshModule()
    const bp = mod.useBpUiEnabled()
    await flush()

    expect(bp.bpUiState.value).toBe('unavailable')
  })

  it('後から署名が届いたら show に変わる (computed なので画面が読み直さなくても入れ替わる)', async () => {
    hasProbedBpBond.value = true
    const bp = await unconfirmed()
    expect(bp.bpUiState.value).toBe('unregistered')

    signedBpBonded.value = true
    expect(bp.bpUiState.value).toBe('show')
    expect(bp.showBpUi.value).toBe(true)
  })
})
