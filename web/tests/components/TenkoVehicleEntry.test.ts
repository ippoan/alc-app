import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import TenkoVehicleEntry from '~/components/TenkoVehicleEntry.vue'

// 車両番号の段 (業務前 二十 ハ)。CoreS3 の NFC_CARINS を最優先に受け、無い・読めない・一致しないときは入力欄で登録する

const isConnected = ref(true)
let carinsHandler: ((name: string, args: string[]) => void) | null = null
const offMock = vi.fn()
mockNuxtImport('useCoreS3Serial', () => () => ({
  isConnected,
  onEvent: (cb: (name: string, args: string[]) => void) => {
    carinsHandler = cb
    return offMock
  },
}))

async function mountEntry(props: { modelValue?: string, manualRequired?: boolean } = {}) {
  return await mountSuspended(TenkoVehicleEntry, { props: { modelValue: '', ...props } })
}

const input = (w: Awaited<ReturnType<typeof mountEntry>>) => w.find('[data-testid="vehicle-number-input"]')

describe('TenkoVehicleEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isConnected.value = true
    carinsHandler = null
  })

  it('★ CoreS3 がつながっていれば車検証を優先して案内し、入力欄は隠しておく', async () => {
    const w = await mountEntry({ modelValue: '予定の車' })
    expect(w.text()).toContain('電子車検証を CoreS3 にかざしてください')
    expect(input(w).exists()).toBe(false)
    expect(w.find('[data-testid="show-manual-vehicle"]').exists()).toBe(true)
    w.unmount()
  })

  it('★ 車検証の管理番号が読めたら carins_cert_no で submit する', async () => {
    const w = await mountEntry()
    carinsHandler!('NFC_CARINS', ['mgno=CERT-1', 'carid=ID-1'])
    expect(w.emitted('submit')![0]).toEqual([{ carins_cert_no: 'CERT-1' }])
    w.unmount()
  })

  it('NFC_CARINS 以外のイベントは無視する', async () => {
    const w = await mountEntry()
    carinsHandler!('NFC_LICENSE', ['mgno=CERT-1'])
    expect(w.emitted('submit')).toBeUndefined()
    w.unmount()
  })

  it('★ 読み取り失敗 (rc=) や管理番号の無い古いファームは、案内を出して入力欄を開く。submit しない', async () => {
    const w = await mountEntry()
    carinsHandler!('NFC_CARINS', ['rc=12'])
    await w.vm.$nextTick()
    expect(w.find('[data-testid="carins-read-error"]').exists()).toBe(true)
    expect(input(w).exists()).toBe(true)
    expect(w.emitted('submit')).toBeUndefined()

    // もう一度かざして読めれば、案内は消える
    carinsHandler!('NFC_CARINS', ['mgno=CERT-2'])
    await w.vm.$nextTick()
    expect(w.find('[data-testid="carins-read-error"]').exists()).toBe(false)
    expect(w.emitted('submit')![0]).toEqual([{ carins_cert_no: 'CERT-2' }])

    carinsHandler!('NFC_CARINS', [])
    await w.vm.$nextTick()
    expect(w.find('[data-testid="carins-read-error"]').exists()).toBe(true)
    w.unmount()
  })

  it('「車検証が使えないときは…」を押すと入力欄が開く', async () => {
    const w = await mountEntry()
    await w.find('[data-testid="show-manual-vehicle"]').trigger('click')
    expect(input(w).exists()).toBe(true)
    expect(w.find('[data-testid="show-manual-vehicle"]').exists()).toBe(false)
    w.unmount()
  })

  it('★ サーバーが車検証を見つけられなかった (manualRequired) ときは入力欄を開く', async () => {
    const w = await mountEntry({ manualRequired: true })
    expect(input(w).exists()).toBe(true)
    w.unmount()
  })

  it('★ CoreS3 がつながっていなければ、車検証の案内なしで入力欄を最初から出す(初期値は親が持つ)', async () => {
    isConnected.value = false
    const w = await mountEntry({ modelValue: '予定の車' })
    expect(w.text()).not.toContain('かざしてください')
    expect((input(w).element as HTMLInputElement).value).toBe('予定の車')
    w.unmount()
  })

  it('入力すると update:modelValue、登録で vehicle_number を trim して submit する', async () => {
    isConnected.value = false
    const w = await mountEntry({ modelValue: '  ' })
    const button = w.find('[data-testid="submit-vehicle-number"]')
    // 空(空白だけ)では押せない・Enter でも送られない
    expect(button.attributes('disabled')).toBeDefined()
    await input(w).trigger('keyup.enter')
    await button.trigger('click')
    expect(w.emitted('submit')).toBeUndefined()

    await input(w).setValue('品川 100 あ 12-34')
    expect(w.emitted('update:modelValue')![0]).toEqual(['品川 100 あ 12-34'])

    await w.setProps({ modelValue: ' 品川 100 あ 12-34 ' })
    expect(w.find('[data-testid="submit-vehicle-number"]').attributes('disabled')).toBeUndefined()
    await w.find('[data-testid="submit-vehicle-number"]').trigger('click')
    expect(w.emitted('submit')![0]).toEqual([{ vehicle_number: '品川 100 あ 12-34' }])
    await input(w).trigger('keyup.enter')
    expect(w.emitted('submit')![1]).toEqual([{ vehicle_number: '品川 100 あ 12-34' }])
    w.unmount()
  })

  it('unmount でイベントの購読を解除する', async () => {
    const w = await mountEntry()
    expect(offMock).not.toHaveBeenCalled()
    w.unmount()
    expect(offMock).toHaveBeenCalledTimes(1)
  })
})
