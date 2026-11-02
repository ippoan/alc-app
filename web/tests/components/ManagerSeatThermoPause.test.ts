// 運行管理者の画面の間は席の Vein Base に体温計へつながせない (Refs ippoan/alc-app-s3#352)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import ManagerSeatThermoPause from '~/components/ManagerSeatThermoPause.vue'

const { appendDiag } = vi.hoisted(() => ({ appendDiag: vi.fn() }))
vi.mock('~/utils/serialDiagLog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/serialDiagLog')>()),
  appendDiag,
}))

const vein = vi.hoisted(() => ({
  isConnected: null as unknown as { value: boolean },
  request: vi.fn(),
}))
mockNuxtImport('useVeinSerial', () => () => vein)

describe('ManagerSeatThermoPause', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vein.isConnected = ref(false)
    vein.request.mockImplementation(async (line: string) => `OK THERMO=${line.endsWith('ON') ? 1 : 0}`)
  })

  it('★ つながるたびに THERMO OFF を送り、画面を離れたら THERMO ON に戻す', async () => {
    const wrapper = await mountSuspended(ManagerSeatThermoPause)
    expect(wrapper.text()).toBe('')
    expect(vein.request).not.toHaveBeenCalled()
    vein.isConnected.value = true
    await flushPromises()
    vein.isConnected.value = false
    await flushPromises()
    vein.isConnected.value = true
    await flushPromises()
    expect(vein.request.mock.calls).toEqual([
      ['THERMO OFF', 'OK THERMO=', 3000, 'ERR'],
      ['THERMO OFF', 'OK THERMO=', 3000, 'ERR'],
    ])
    expect(appendDiag).toHaveBeenCalledWith('[thermo] 運行管理者の画面 OK THERMO=0')
    wrapper.unmount()
    await flushPromises()
    expect(vein.request).toHaveBeenLastCalledWith('THERMO ON', 'OK THERMO=', 3000, 'ERR')
  })

  it('つながっていなければ離れても送らない。古いファームが断っても投げない', async () => {
    vein.request.mockRejectedValue(new Error('不明なコマンド'))
    vein.isConnected.value = true
    const wrapper = await mountSuspended(ManagerSeatThermoPause)
    await flushPromises()
    expect(appendDiag).toHaveBeenCalledWith('[thermo] THERMO OFF を送れませんでした: 不明なコマンド')
    vein.isConnected.value = false
    wrapper.unmount()
    await flushPromises()
    expect(vein.request).toHaveBeenCalledTimes(1)
  })
})
