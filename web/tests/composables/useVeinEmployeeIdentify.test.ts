import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, readonly, nextTick } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { withSetup } from '../helpers/with-setup'

// --- 指静脈の機体 (useVeinSerial) のモック ---

const connected = ref(false)
let fingerCb: (() => void) | null = null
const stopFinger = vi.fn()
const vein = {
  isSupported: true,
  isConnected: readonly(connected),
  connect: vi.fn(async () => true),
  say: vi.fn(async () => {}),
  identify: vi.fn(async (_onAgain?: () => void) => 12 as number | null),
  capture: vi.fn(async () => 'abcd'),
  onFingerPlaced: vi.fn((cb: () => void) => { fingerCb = cb; return stopFinger }),
}
mockNuxtImport('useVeinSerial', () => () => vein)

// --- 照合と同期 (utils) のモック ---

const mod = vi.hoisted(() => ({
  usesVeinModule: vi.fn(() => true),
  identifyVeinModuleEmployee: vi.fn(),
}))
vi.mock('~/utils/vein-module', () => mod)
const ident = vi.hoisted(() => ({
  identifyVeinEmployee: vi.fn(),
  syncVeinTemplates: vi.fn(async () => true),
  VEIN_TEMPLATE_SYNC_INTERVAL_MS: 600_000,
}))
vi.mock('~/utils/vein-identify', () => ident)

const EMP = { id: 'emp-test-1', name: 'テスト太郎', role: ['driver'] }

let useVeinEmployeeIdentify: typeof import('~/composables/useVeinEmployeeIdentify').useVeinEmployeeIdentify

function setup(over: Partial<Parameters<typeof useVeinEmployeeIdentify>[0]> = {}) {
  const opts = {
    missMessage: '一致しません',
    pendingMessage: (name: string | null) => `${name ?? 'この人'}は未承認`,
    onEmployee: vi.fn((): string | null => null),
    isIdle: vi.fn(() => true),
    onStart: vi.fn(),
    ...over,
  }
  const [api, app] = withSetup(() => useVeinEmployeeIdentify(opts))
  return { api, app, opts }
}

describe('useVeinEmployeeIdentify', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    connected.value = true
    fingerCb = null
    vein.isSupported = true
    mod.usesVeinModule.mockReturnValue(true)
    mod.identifyVeinModuleEmployee.mockResolvedValue({ kind: 'hit', employee: EMP })
    ident.identifyVeinEmployee.mockResolvedValue({ kind: 'hit', employee: EMP })
    vein.identify.mockResolvedValue(12)
    vi.resetModules()
    useVeinEmployeeIdentify = (await import('~/composables/useVeinEmployeeIdentify')).useVeinEmployeeIdentify
  })

  it('mount で機体につなぎ、写しを同期する (モジュールの構成は機体も揃える)', () => {
    const { app } = setup()
    expect(vein.connect).toHaveBeenCalledTimes(1)
    expect(ident.syncVeinTemplates).toHaveBeenCalledWith({ module: vein })
    app.unmount()
  })

  it('モジュールを使わない構成は機体を渡さずに同期する。sync は呼び手の条件を渡す', () => {
    mod.usesVeinModule.mockReturnValue(false)
    const { api, app } = setup()
    expect(ident.syncVeinTemplates).toHaveBeenCalledWith({ module: undefined })
    void api.sync({ ifOlderThanMs: 5 })
    expect(ident.syncVeinTemplates).toHaveBeenLastCalledWith({ ifOlderThanMs: 5, module: undefined })
    app.unmount()
  })

  it('鍵の種類を渡すと、同期と当たった人の照会をその鍵で行う', async () => {
    const { api, app } = setup({ scope: 'manager-device' })
    expect(ident.syncVeinTemplates).toHaveBeenCalledWith({ module: vein, scope: 'manager-device' })
    await api.identify()
    expect(mod.identifyVeinModuleEmployee).toHaveBeenCalledWith(12, 'manager-device')
    app.unmount()
  })

  it('つながったときだけ、古ければ同期し直す', async () => {
    connected.value = false
    const { app } = setup()
    ident.syncVeinTemplates.mockClear()
    connected.value = true
    await nextTick()
    expect(ident.syncVeinTemplates).toHaveBeenCalledWith({ ifOlderThanMs: 600_000, module: vein })
    connected.value = false
    await nextTick()
    expect(ident.syncVeinTemplates).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('モジュールで照合し、特定できた人を渡す。撮り直しの合図で again が立つ', async () => {
    vein.identify.mockImplementationOnce(async (onAgain) => { onAgain?.(); return 12 })
    const { api, app, opts } = setup()
    await api.identify()
    expect(opts.onStart).toHaveBeenCalledTimes(1)
    expect(vein.say).toHaveBeenCalledWith('PLACE')
    expect(mod.identifyVeinModuleEmployee).toHaveBeenCalledWith(12, undefined)
    expect(opts.onEmployee).toHaveBeenCalledWith(EMP)
    expect(api.again.value).toBe(true)
    expect(api.error.value).toBeNull()
    expect(api.busy.value).toBe(false)
    expect(vein.say).not.toHaveBeenCalledWith('FAILED')
    app.unmount()
  })

  it('古い構成は特徴量を読んで照合する。prompt: false なら「指を置いて」を鳴らさない', async () => {
    mod.usesVeinModule.mockReturnValue(false)
    const { api, app, opts } = setup({ onStart: undefined })
    await api.identify({ prompt: false })
    expect(vein.say).not.toHaveBeenCalled()
    expect(vein.capture).toHaveBeenCalledTimes(1)
    expect(ident.identifyVeinEmployee).toHaveBeenCalledWith('abcd')
    expect(opts.onEmployee).toHaveBeenCalledWith(EMP)
    app.unmount()
  })

  it.each([
    [{ kind: 'miss' }, '一致しません'],
    [{ kind: 'pending', employeeId: 'x', name: 'テスト花子' }, 'テスト花子は未承認'],
    [{ kind: 'pending', employeeId: 'x', name: null }, 'この人は未承認'],
    [{ kind: 'error', message: '照合データが古い' }, '照合データが古い'],
  ])('進めなかった結果 %o は理由を出して失敗の案内を鳴らす', async (outcome, message) => {
    mod.identifyVeinModuleEmployee.mockResolvedValueOnce(outcome)
    const { api, app, opts } = setup()
    await api.identify()
    expect(api.error.value).toBe(message)
    expect(opts.onEmployee).not.toHaveBeenCalled()
    expect(vein.say).toHaveBeenLastCalledWith('FAILED')
    app.unmount()
  })

  it('読み取りの失敗は理由を出す。失敗の案内が鳴らせなくても落ちない', async () => {
    vein.identify.mockRejectedValueOnce(new Error('NO_MODULE'))
    vein.say.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('NO_SPEAKER'))
    const { api, app } = setup()
    await api.identify()
    expect(api.error.value).toBe('指静脈を読み取れませんでした (NO_MODULE)')
    expect(api.busy.value).toBe(false)
    app.unmount()
  })

  it('特定した人を画面が通さなかったときは、その理由を出す', async () => {
    const { api, app } = setup({ onEmployee: async () => '権限がありません' })
    await api.identify()
    expect(api.error.value).toBe('権限がありません')
    app.unmount()
  })

  it('繋がっていない・Web Serial が無い・読み取り中なら何もしない', async () => {
    const { api, app, opts } = setup()
    connected.value = false
    await api.identify()
    connected.value = true
    api.busy.value = true
    await api.identify()
    expect(opts.onStart).not.toHaveBeenCalled()
    expect(vein.identify).not.toHaveBeenCalled()
    app.unmount()

    vein.isSupported = false
    const other = setup()
    expect(other.api.ready.value).toBe(false)
    await other.api.identify()
    expect(vein.identify).not.toHaveBeenCalled()
    other.app.unmount()
  })

  it('指が置かれた合図は、待機中のときだけ「指を置いて」なしで照合を始める。unmount で外す', async () => {
    const isIdle = vi.fn(() => false)
    const { app } = setup({ isIdle })
    fingerCb!()
    await nextTick()
    expect(vein.identify).not.toHaveBeenCalled()

    isIdle.mockReturnValue(true)
    fingerCb!()
    await vi.waitFor(() => expect(vein.identify).toHaveBeenCalledTimes(1))
    expect(vein.say).not.toHaveBeenCalledWith('PLACE')

    app.unmount()
    expect(stopFinger).toHaveBeenCalledTimes(1)
  })
})
