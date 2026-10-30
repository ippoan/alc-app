// 血圧の画面の「血圧計 (Bluetooth) の設定・ペアリング」(Refs ippoan/alc-app#436)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import BpBluetoothSettings from '~/components/BpBluetoothSettings.vue'
import { veinRestartReload } from '~/utils/vein-restart'

const vein = vi.hoisted(() => ({
  isConnected: null as unknown as { value: boolean },
  omronBp: null as unknown as { value: boolean | null },
  setOmronBp: vi.fn(),
  startPairing: vi.fn(),
  restart: vi.fn(),
}))
mockNuxtImport('useVeinSerial', () => () => vein)

const find = (w: Awaited<ReturnType<typeof mountSuspended>>, id: string) => w.find(`[data-testid="${id}"]`)

describe('BpBluetoothSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vein.isConnected = ref(true)
    vein.omronBp = ref(false)
    vein.setOmronBp.mockResolvedValue(undefined)
    vein.startPairing.mockResolvedValue(undefined)
    vein.restart.mockResolvedValue(undefined)
    veinRestartReload.run = vi.fn()
  })

  it('いまの設定を出し、同じ値のボタンは押せない。分からなければそう出す', async () => {
    const w = await mountSuspended(BpBluetoothSettings)
    expect(find(w, 'bp-ble-state').text()).toBe('使わない')
    expect(find(w, 'bp-ble-off').attributes('disabled')).toBeDefined()
    expect(find(w, 'bp-ble-on').attributes('disabled')).toBeUndefined()
    vein.omronBp.value = true
    await flushPromises()
    expect(find(w, 'bp-ble-state').text()).toBe('使う')
    vein.omronBp.value = null
    await flushPromises()
    expect(find(w, 'bp-ble-state').text()).toContain('分かりません')
  })

  it('★ 「使う」で機体に書き、再起動を促す。再起動で促しを下ろす', async () => {
    const w = await mountSuspended(BpBluetoothSettings)
    await find(w, 'bp-ble-on').trigger('click')
    await flushPromises()
    expect(vein.setOmronBp).toHaveBeenCalledWith(true)
    expect(find(w, 'bp-ble-message').text()).toContain('再起動すると有効')
    expect(find(w, 'bp-ble-restart').classes()).toContain('bg-amber-500')
    await find(w, 'bp-ble-restart').trigger('click')
    await flushPromises()
    expect(vein.restart).toHaveBeenCalledTimes(1)
    expect(find(w, 'bp-ble-restart').classes()).not.toContain('bg-amber-500')
    expect(find(w, 'bp-ble-message').text()).toContain('読み込み直します')
  })

  it('「使わない」も書ける。失敗は理由を出す', async () => {
    vein.omronBp.value = true
    vein.setOmronBp.mockRejectedValue(new Error('血圧計の設定を書けませんでした'))
    const w = await mountSuspended(BpBluetoothSettings)
    await find(w, 'bp-ble-off').trigger('click')
    await flushPromises()
    expect(vein.setOmronBp).toHaveBeenCalledWith(false)
    expect(find(w, 'bp-ble-error').text()).toBe('血圧計の設定を書けませんでした')
    vein.restart.mockRejectedValue('x')
    await find(w, 'bp-ble-restart').trigger('click')
    await flushPromises()
    expect(find(w, 'bp-ble-error').text()).toBe('x')
  })

  it('★ ペアリングは確認を挟んでから受付を開く。やめれば何もしない', async () => {
    const w = await mountSuspended(BpBluetoothSettings)
    await find(w, 'bp-ble-pair').trigger('click')
    expect(find(w, 'bp-ble-pair-confirm').exists()).toBe(true)
    await w.findAll('[data-testid="bp-ble-pair-confirm"] button').find(b => b.text() === 'やめる')!.trigger('click')
    expect(find(w, 'bp-ble-pair-confirm').exists()).toBe(false)
    expect(vein.startPairing).not.toHaveBeenCalled()

    await find(w, 'bp-ble-pair').trigger('click')
    await find(w, 'bp-ble-pair-yes').trigger('click')
    await flushPromises()
    expect(vein.startPairing).toHaveBeenCalledTimes(1)
    expect(find(w, 'bp-ble-message').text()).toContain('-P-')
  })

  it('Vein Station が無ければ操作を出さない。閉じるで close', async () => {
    vein.isConnected.value = false
    const w = await mountSuspended(BpBluetoothSettings)
    expect(w.text()).toContain('Vein Station がつながっていません')
    expect(find(w, 'bp-ble-on').exists()).toBe(false)
    await w.findAll('button').find(b => b.text() === '閉じる')!.trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })
})
