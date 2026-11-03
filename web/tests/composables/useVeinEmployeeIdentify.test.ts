import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, readonly, nextTick } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { withSetup } from '../helpers/with-setup'

// --- 指静脈の機体 (useVeinSerial) のモック ---

const connected = ref(false)
let fingerCb: (() => void) | null = null
const stopFinger = vi.fn()
const lastMatch = ref<{ via: 'FV' | 'FP' | null } | null>(null)
const vein = {
  isSupported: true,
  lastMatch: readonly(lastMatch),
  isConnected: readonly(connected),
  connect: vi.fn(async () => true),
  say: vi.fn(async () => {}),
  identify: vi.fn(async (_onAgain?: () => void) => 12 as number | null),
  verify: vi.fn(async (_id: number, _onAgain?: () => void) => true),
  capture: vi.fn(async () => 'abcd'),
  onFingerPlaced: vi.fn((cb: () => void) => { fingerCb = cb; return stopFinger }),
}
mockNuxtImport('useVeinSerial', () => () => vein)

// --- 照合と同期 (utils) のモック ---

/** 照合に置いた指を撮った記録 (中身は使わない) */
const RECORD = vi.hoisted(() => new Uint8Array([0xDE, 0xED]))
const mod = vi.hoisted(() => ({
  usesVeinModule: vi.fn(() => true),
  identifyVeinModuleEmployee: vi.fn(),
  prepareVeinModuleRecord: vi.fn(async () => 12 as number | null),
  // 本人が決まった人の照合 (撮ってから 1:N、当たった ID がその人の枠か) と、通った後の入れ替え。中身は utils/vein-module.test.ts
  matchVeinModuleEmployee: vi.fn(async (..._args: unknown[]) => ({ id: 12, record: RECORD }) as { id: number; record: Uint8Array | null } | null),
  rotateVeinModuleRecord: vi.fn(async (..._args: unknown[]) => {}),
}))
// 不一致のやり直し (retryOnVeinMiss) は本物を使う
vi.mock('~/utils/vein-module', async importOriginal => ({
  retryOnVeinMiss: (await importOriginal<typeof import('~/utils/vein-module')>()).retryOnVeinMiss,
  ...mod,
}))
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
    lastMatch.value = null
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

  it('★ モジュールが不一致なら 1 回だけ自動でやり直す (again が立つ)。2 回とも不一致なら不一致', async () => {
    vein.identify.mockResolvedValueOnce(null).mockResolvedValueOnce(12)
    const { api, app, opts } = setup()
    await api.identify()
    expect(vein.identify).toHaveBeenCalledTimes(2)
    expect(api.again.value).toBe(true)
    // やり直しの前に機器でも「もう一度置いて」を鳴らす (黙って待つと止まったように見える)
    expect(vein.say).toHaveBeenCalledWith('AGAIN')
    expect(mod.identifyVeinModuleEmployee).toHaveBeenCalledWith(12, undefined)
    expect(opts.onEmployee).toHaveBeenCalledWith(EMP, null)
    vein.identify.mockClear()
    vein.identify.mockResolvedValue(null)
    mod.identifyVeinModuleEmployee.mockResolvedValue({ kind: 'miss' })
    await api.identify()
    expect(vein.identify).toHaveBeenCalledTimes(2)
    expect(mod.identifyVeinModuleEmployee).toHaveBeenLastCalledWith(null, undefined)
    app.unmount()
  })

  it('モジュールで照合し、特定できた人を渡す。撮り直しの合図で again が立つ', async () => {
    vein.identify.mockImplementationOnce(async (onAgain) => { onAgain?.(); return 12 })
    const { api, app, opts } = setup()
    await api.identify()
    expect(opts.onStart).toHaveBeenCalledTimes(1)
    expect(vein.say).toHaveBeenCalledWith('PLACE')
    expect(mod.identifyVeinModuleEmployee).toHaveBeenCalledWith(12, undefined)
    expect(opts.onEmployee).toHaveBeenCalledWith(EMP, null)
    expect(api.again.value).toBe(true)
    expect(api.error.value).toBeNull()
    expect(api.busy.value).toBe(false)
    expect(vein.say).not.toHaveBeenCalledWith('FAILED')
    app.unmount()
  })

  it('モジュールの照合がどの層で当たったか (via) を onEmployee の第 2 引数に渡す。古い構成では前の照合の値を渡さない', async () => {
    vein.identify.mockImplementationOnce(async () => { lastMatch.value = { via: 'FP' }; return 12 })
    const a = setup()
    await a.api.identify()
    expect(a.opts.onEmployee).toHaveBeenCalledWith(EMP, 'FP')
    a.app.unmount()
    mod.usesVeinModule.mockReturnValue(false)
    const b = setup()
    await b.api.identify()
    expect(b.opts.onEmployee).toHaveBeenCalledWith(EMP, null)
    b.app.unmount()
  })

  it('照合の開始を、どの画面かの印つきで [vein] に残す (印が無ければ -)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const a = setup({ label: 'kiosk' })
    await a.api.identify()
    expect(info).toHaveBeenCalledWith('[vein] 照合開始 screen=kiosk prompt=true')
    a.app.unmount()
    const b = setup()
    await b.api.identify({ prompt: false })
    expect(info).toHaveBeenCalledWith('[vein] 照合開始 screen=- prompt=false')
    b.app.unmount()
    info.mockRestore()
  })

  it('古い構成は特徴量を読んで照合する。prompt: false なら「指を置いて」を鳴らさない', async () => {
    mod.usesVeinModule.mockReturnValue(false)
    const { api, app, opts } = setup({ onStart: undefined })
    await api.identify({ prompt: false })
    expect(vein.say).not.toHaveBeenCalled()
    expect(vein.capture).toHaveBeenCalledTimes(1)
    expect(ident.identifyVeinEmployee).toHaveBeenCalledWith('abcd')
    expect(opts.onEmployee).toHaveBeenCalledWith(EMP, null)
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

  describe('本人が先に決まっている (expectedEmployeeId、Refs ippoan/alc-app-s3#352)', () => {
    it('★ その人をモジュールに用意して 1:1 で照合する。指の合図からなら「指を置いて」を鳴らさない', async () => {
      const { api, app, opts } = setup({ expectedEmployeeId: () => 'emp-test-1', scope: 'manager-device' })
      fingerCb?.()
      await vi.waitFor(() => expect(opts.onEmployee).toHaveBeenCalledWith(EMP, null))
      expect(mod.prepareVeinModuleRecord).toHaveBeenCalledWith(vein, 'emp-test-1', 'manager-device')
      // VEIN VERIFY <id> は使わない (指定と違う ID に当たっても成功を返すため)。1:N で本人の枠か確かめる
      expect(mod.matchVeinModuleEmployee).toHaveBeenCalledWith(vein, 'emp-test-1', expect.any(Function), expect.any(Function))
      expect(vein.verify).not.toHaveBeenCalled()
      expect(mod.identifyVeinModuleEmployee).toHaveBeenCalledWith(12, 'manager-device')
      expect(vein.say).not.toHaveBeenCalledWith('PLACE')
      expect(api.error.value).toBeNull()
      app.unmount()
    })

    it('記録が無ければ、noRecordMessage が無い画面は missMessage を出す', async () => {
      mod.prepareVeinModuleRecord.mockResolvedValueOnce(null)
      const { api, app } = setup({ expectedEmployeeId: () => 'emp-test-1' })
      await api.identify()
      expect(mod.matchVeinModuleEmployee).not.toHaveBeenCalled()
      expect(api.error.value).toBe('一致しません')
      app.unmount()
    })

    it('★ 本人の枠に当たらなければ (他人・不一致) 不一致。入れ替えない', async () => {
      mod.matchVeinModuleEmployee.mockResolvedValueOnce(null)
      const { api, app, opts } = setup({ expectedEmployeeId: () => 'emp-test-1' })
      await api.identify()
      expect(api.error.value).toBe('一致しません')
      expect(opts.onEmployee).not.toHaveBeenCalled()
      expect(mod.rotateVeinModuleRecord).not.toHaveBeenCalled()
      expect(vein.say).toHaveBeenCalledWith('FAILED')
      app.unmount()
    })

    it('★ 通ったら人を渡してから、同じ置き方で撮った記録で入れ替える (画面は待たない)', async () => {
      const order: string[] = []
      let finish: () => void = () => {}
      mod.rotateVeinModuleRecord.mockImplementationOnce(() => new Promise<void>((resolve) => {
        order.push('rotate')
        finish = resolve
      }))
      lastMatch.value = { via: 'FP' }
      const { api, app, opts } = setup({ expectedEmployeeId: () => 'emp-test-1', scope: 'manager-device' })
      opts.onEmployee.mockImplementationOnce(() => { order.push('onEmployee'); return null })
      // 入れ替えが終わらなくても照合は終わる
      await api.identify()
      expect(opts.onEmployee).toHaveBeenCalledWith(EMP, 'FP')
      expect(mod.rotateVeinModuleRecord).toHaveBeenCalledWith(vein, { id: 12, record: RECORD }, 'emp-test-1', 'manager-device')
      expect(order).toEqual(['onEmployee', 'rotate'])
      expect(api.busy.value).toBe(false)
      expect(api.error.value).toBeNull()
      finish()
      app.unmount()
    })

    it('用意・照合の失敗は理由を出す。本人の枠に当たっても乗務員を引けなければ、その理由を出して入れ替えない', async () => {
      const { api, app, opts } = setup({ expectedEmployeeId: () => 'emp-test-1' })
      mod.prepareVeinModuleRecord.mockRejectedValueOnce(new Error('WRITE_SEQ'))
      await api.identify()
      expect(api.error.value).toBe('指静脈の記録をこの端末に用意できませんでした (WRITE_SEQ)')
      mod.matchVeinModuleEmployee.mockRejectedValueOnce(new Error('TIMEOUT'))
      await api.identify()
      expect(api.error.value).toBe('指静脈を読み取れませんでした (TIMEOUT)')
      mod.identifyVeinModuleEmployee.mockResolvedValueOnce({ kind: 'error', message: '乗務員の情報が手元にありません' })
      await api.identify()
      expect(api.error.value).toBe('乗務員の情報が手元にありません')
      expect(opts.onEmployee).not.toHaveBeenCalled()
      expect(mod.rotateVeinModuleRecord).not.toHaveBeenCalled()
      app.unmount()
    })

    it('prewrite は先に書き始め、照合はその用意を待って使う。失敗した用意は使い回さない。モジュールを使わない構成は書かない', async () => {
      const { api, app } = setup({ expectedEmployeeId: () => 'emp-test-1' })
      mod.prepareVeinModuleRecord.mockRejectedValueOnce(new Error('WRITE_SEQ'))
      api.prewrite('emp-test-1')
      await nextTick()
      await api.identify()
      // 失敗した用意は捨て、照合のときに取り直す
      expect(mod.prepareVeinModuleRecord).toHaveBeenCalledTimes(2)
      expect(api.error.value).toBeNull()
      api.prewrite('emp-test-1')
      await api.identify()
      expect(mod.prepareVeinModuleRecord).toHaveBeenCalledTimes(3)
      mod.usesVeinModule.mockReturnValue(false)
      api.prewrite('emp-test-1')
      expect(mod.prepareVeinModuleRecord).toHaveBeenCalledTimes(3)
      app.unmount()
    })
  })
})
