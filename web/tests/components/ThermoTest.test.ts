import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import ThermoTest from '~/components/ThermoTest.vue'
import { createLineDispatch } from '~/utils/serial-line-dispatch'

// 体温計の受信テスト。Vein Station の行は本物の配り方 (createLineDispatch) で流す
const h = vi.hoisted(() => ({
  dispatch: null as null | ReturnType<typeof import('~/utils/serial-line-dispatch').createLineDispatch>,
  connected: null as null | { value: boolean },
  /** 画面が外した購読の数 */
  offs: 0,
}))
function counted(off: () => void): () => void {
  return () => {
    h.offs++
    off()
  }
}
mockNuxtImport('useVeinSerial', () => () => ({
  isConnected: h.connected,
  onEvent: (cb: Parameters<ReturnType<typeof createLineDispatch>['onEvent']>[0]) => counted(h.dispatch!.onEvent(cb)),
  onJson: (cb: Parameters<ReturnType<typeof createLineDispatch>['onJson']>[0]) => counted(h.dispatch!.onJson(cb)),
}))

function rowsText(w: Awaited<ReturnType<typeof mountSuspended>>): string[] {
  return w.findAll('[data-testid="thermo-test-rows"] li').map(li => li.text().replace(/^\d\d:\d\d:\d\d\.\d{3}\s*/, ''))
}

describe('ThermoTest', () => {
  beforeEach(() => {
    h.dispatch = createLineDispatch('VEIN')
    h.connected = ref(true)
    h.offs = 0
  })

  it('体温計の EVT・接続の JSON・体温を新しい順に積み、他の行は無視する', async () => {
    const w = await mountSuspended(ThermoTest)
    expect(rowsText(w)).toEqual(['まだ何も届いていません'])
    expect(w.find('[data-testid="thermo-test-latest"]').text()).toBe('--.- ℃')
    expect(w.find('[data-testid="thermo-test-vein"]').text()).toContain('接続中')

    const d = h.dispatch!
    d.dispatchLine('{"type":"found","device":"thermometer"}')
    d.dispatchLine('EVT THERMO_CONN try')
    d.dispatchLine('{"type":"connected","device":"thermometer"}')
    d.dispatchLine('{"type":"temperature","value":36.54}')
    d.dispatchLine('EVT THERMO_RX ok')
    d.dispatchLine('{"type":"disconnected","device":"thermometer"}')
    // 体温計以外・形の違うものは積まない
    d.dispatchLine('{"type":"connected","device":"blood_pressure"}')
    d.dispatchLine('{"type":"temperature","value":"x"}')
    d.dispatchLine('{"type":"alcohol","value":0}')
    d.dispatchLine('EVT OMRON CONNECTING')
    d.dispatchLine('EVT THERMO_CONN try')
    d.dispatchLine('{"type":"temperature","value":36.8}')
    await w.vm.$nextTick()

    expect(rowsText(w)).toEqual([
      '36.8 ℃',
      'EVT THERMO_CONN try',
      'disconnected',
      'EVT THERMO_RX ok',
      '36.5 ℃',
      'connected',
      'EVT THERMO_CONN try',
      'found',
    ])
    expect(w.find('[data-testid="thermo-test-latest"]').text()).toBe('36.8 ℃')
    expect(w.find('[data-testid="thermo-test-count"]').text()).toBe('受信 2 回')

    await w.find('[data-testid="thermo-test-clear"]').trigger('click')
    expect(rowsText(w)).toEqual(['まだ何も届いていません'])
    expect(w.find('[data-testid="thermo-test-count"]').text()).toBe('受信 0 回')
  })

  it('上限を超えたら古い行から落とす', async () => {
    const w = await mountSuspended(ThermoTest)
    for (let i = 0; i < 305; i++) h.dispatch!.dispatchLine('EVT THERMO_CONN try')
    await w.vm.$nextTick()
    expect(w.findAll('[data-testid="thermo-test-rows"] li')).toHaveLength(300)
  })

  it('Vein Station が未接続なら表示し、戻るで close / unmount で購読を外す', async () => {
    h.connected = ref(false)
    const w = await mountSuspended(ThermoTest)
    expect(w.find('[data-testid="thermo-test-vein"]').text()).toContain('未接続')

    await w.findAll('button').at(-1)!.trigger('click')
    expect(w.emitted('close')).toHaveLength(1)

    w.unmount()
    expect(h.offs).toBe(2)
  })
})
