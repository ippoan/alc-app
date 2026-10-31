import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import ItTenkoVeinRegister from '~/components/ItTenkoVeinRegister.vue'

// IT点呼の開発用席で指静脈登録のあとに出す「この端末で撮り直す」の提案。照合の手順は
// useVeinEmployeeIdentify.test.ts、足す手順は useVeinAddDevice.test.ts の領分で、ここは出す条件と配線だけ

type VeinOpts = Parameters<typeof import('~/composables/useVeinEmployeeIdentify').useVeinEmployeeIdentify>[0]
let veinOpts: VeinOpts | null = null
const veinState = { ready: ref(true), busy: ref(false), again: ref(false), error: ref<string | null>(null) }
mockNuxtImport('useVeinEmployeeIdentify', () => (opts: VeinOpts) => {
  veinOpts = opts
  return { ...veinState, identify: vi.fn(), sync: vi.fn() }
})

const addDevice = { add: vi.fn(async () => true), reset: vi.fn(), scope: null as string | null }
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

const EMP = { id: 'emp-test-1', name: 'テスト太郎', role: ['manager'] } as never
const onEmployee = vi.fn(async (): Promise<string | null> => null)

function mountRegister() {
  return mountSuspended(ItTenkoVeinRegister, { props: { onEmployee, idle: true } })
}
const suggest = (w: Awaited<ReturnType<typeof mountRegister>>) => w.find('[data-testid="vein-refresh-suggest"]')
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('ItTenkoVeinRegister — 指静脈が FP のときの撮り直しの提案', () => {
  beforeEach(() => {
    veinOpts = null
    onEmployee.mockReset().mockResolvedValue(null)
    addDevice.add.mockClear()
    addState.adding.value = false
    addState.added.value = false
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('登録できて FP なら提案を出す (運行管理者席の鍵)。承認するとその人を足す', async () => {
    const wrapper = await mountRegister()
    expect(veinOpts!.scope).toBe('manager-device')
    expect(await veinOpts!.onEmployee(EMP, 'FP')).toBeNull()
    await settle()
    expect(onEmployee).toHaveBeenCalledWith(EMP)
    expect(addDevice.scope).toBe('manager-device')
    expect(suggest(wrapper).exists()).toBe(true)
    expect(console.info).toHaveBeenCalledWith('[vein] 撮り直しの提案 shown screen=it-tenko')
    await wrapper.find('[data-testid="vein-refresh-suggest-accept"]').trigger('click')
    expect(addDevice.add).toHaveBeenCalledWith('emp-test-1')
    wrapper.unmount()
  })

  it('FV・via なしでは出さない。登録できなかったときも出さず、失敗の理由はそのまま返す', async () => {
    const wrapper = await mountRegister()
    await veinOpts!.onEmployee(EMP, 'FV')
    await veinOpts!.onEmployee(EMP, null)
    await settle()
    expect(suggest(wrapper).exists()).toBe(false)
    onEmployee.mockResolvedValue('権限がありません (テスト)')
    expect(await veinOpts!.onEmployee(EMP, 'FP')).toBe('権限がありません (テスト)')
    await settle()
    expect(suggest(wrapper).exists()).toBe(false)
    wrapper.unmount()
  })

  it('「あとで」で消える。次の照合の開始でも消える。足している間は自動照合を受けない', async () => {
    const wrapper = await mountRegister()
    await veinOpts!.onEmployee(EMP, 'FP')
    await settle()
    await wrapper.find('[data-testid="vein-refresh-suggest-dismiss"]').trigger('click')
    expect(suggest(wrapper).exists()).toBe(false)
    expect(console.info).toHaveBeenCalledWith('[vein] 撮り直しの提案 dismissed screen=it-tenko')
    await veinOpts!.onEmployee(EMP, 'FP')
    await settle()
    veinOpts!.onStart!()
    await settle()
    expect(suggest(wrapper).exists()).toBe(false)
    expect(veinOpts!.isIdle()).toBe(true)
    addState.adding.value = true
    expect(veinOpts!.isIdle()).toBe(false)
    wrapper.unmount()
  })
})
