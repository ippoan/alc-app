import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { withSetup } from '../helpers/with-setup'
import { useVeinRefreshSuggest } from '~/composables/useVeinRefreshSuggest'

/** 「この端末で撮り直す」の提案。足す手順そのものは useVeinAddDevice.test.ts の領分で、ここは出す条件・ログ・状態だけ */

const diag = vi.hoisted(() => ({ appendDiag: vi.fn() }))
vi.mock('~/utils/serialDiagLog', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/serialDiagLog')>()),
  ...diag,
}))

const addDevice = { add: vi.fn(async (_id: string) => true), reset: vi.fn(), scope: null as string | null }
const addState = {
  adding: ref(false),
  available: ref(true),
  added: ref(false),
  error: ref<string | null>(null),
  notice: ref<string | null>(null),
}
mockNuxtImport('useVeinAddDevice', () => (opts: { scope: string }) => {
  addDevice.scope = opts.scope
  return { ...addState, add: addDevice.add, reset: addDevice.reset }
})

function setup() {
  return withSetup(() => useVeinRefreshSuggest({ scope: 'manager-device', label: 'test-screen' }))
}

describe('useVeinRefreshSuggest', () => {
  let info: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    addDevice.add.mockClear()
    addDevice.reset.mockClear()
    diag.appendDiag.mockClear()
    info = vi.spyOn(console, 'info').mockImplementation(() => {})
  })
  afterEach(() => info.mockRestore())

  it('via が FP のときだけ提案を出し、shown を診断ログに残す (画面の鍵で足す)', () => {
    const [s, app] = setup()
    expect(addDevice.scope).toBe('manager-device')
    s.offer('emp-test-1', 'FP')
    expect(s.target.value).toBe('emp-test-1')
    expect(info).toHaveBeenCalledWith('[vein] 撮り直しの提案 shown screen=test-screen')
    expect(diag.appendDiag).toHaveBeenCalledWith('[vein] 撮り直しの提案 shown screen=test-screen')
    app.unmount()
  })

  it('FV・null (古いファーム) では出さない', () => {
    const [s, app] = setup()
    s.offer('emp-test-1', 'FV')
    s.offer('emp-test-1', null)
    expect(s.target.value).toBeNull()
    expect(info).not.toHaveBeenCalled()
    app.unmount()
  })

  it('承認するとその人で足し、accepted を残す。対象が無ければ何もしない', async () => {
    const [s, app] = setup()
    await s.accept()
    expect(addDevice.add).not.toHaveBeenCalled()
    s.offer('emp-test-1', 'FP')
    await s.accept()
    expect(addDevice.add).toHaveBeenCalledWith('emp-test-1')
    expect(info).toHaveBeenCalledWith('[vein] 撮り直しの提案 accepted screen=test-screen')
    app.unmount()
  })

  it('「あとで」で消え、dismissed を残す。出ていなければ何も残さない。clear はログを残さず片付ける', () => {
    const [s, app] = setup()
    s.dismiss()
    expect(info).not.toHaveBeenCalled()
    s.offer('emp-test-1', 'FP')
    info.mockClear()
    s.dismiss()
    expect(s.target.value).toBeNull()
    expect(info).toHaveBeenCalledWith('[vein] 撮り直しの提案 dismissed screen=test-screen')
    s.offer('emp-test-1', 'FP')
    info.mockClear()
    s.clear()
    expect(s.target.value).toBeNull()
    expect(info).not.toHaveBeenCalled()
    app.unmount()
  })
})
