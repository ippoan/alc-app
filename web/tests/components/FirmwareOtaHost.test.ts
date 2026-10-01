// CoreS3 のファームの更新の置き場 (Refs ippoan/alc-app#403)。
// 報告 (useFirmwareReport) を mount で始め、unmount で止める。更新の状態 (useSerialOta().state) が
// idle でない間だけ、画面全体に「更新中」の幕を出す (合図の受けはここには無い)。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import FirmwareOtaHost from '~/components/FirmwareOtaHost.vue'
import type { SerialOtaState } from '~/composables/useSerialOta'

const reportMock = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }))
mockNuxtImport('useFirmwareReport', () => () => reportMock)

const ota = vi.hoisted(() => ({
  state: null as unknown as { value: SerialOtaState },
  run: vi.fn(),
  enqueue: vi.fn(),
  runQueued: vi.fn(async () => {}),
}))
mockNuxtImport('useSerialOta', () => () => ota)

const timecardWatch = vi.hoisted(() => vi.fn())
mockNuxtImport('useTimecardWatch', () => timecardWatch)

const overlay = (wrapper: { find: (selector: string) => { exists: () => boolean, text: () => string, classes: () => string[] } }) =>
  wrapper.find('[data-testid="serial-ota-overlay"]')

describe('FirmwareOtaHost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ota.state = ref<SerialOtaState>({ kind: 'idle' })
  })

  it('mount で報告を始め、unmount で止める', async () => {
    const wrapper = await mountSuspended(FirmwareOtaHost)
    expect(reportMock.start).toHaveBeenCalledTimes(1)
    expect(reportMock.stop).not.toHaveBeenCalled()

    wrapper.unmount()

    expect(reportMock.stop).toHaveBeenCalledTimes(1)
    expect(reportMock.start).toHaveBeenCalledTimes(1)
  })

  it('更新していない間は描画するものは無い (要素を 1 つも出さない)', async () => {
    const wrapper = await mountSuspended(FirmwareOtaHost)
    expect(wrapper.element.nodeType).not.toBe(Node.ELEMENT_NODE)
    expect(wrapper.text()).toBe('')
    wrapper.unmount()
  })

  it.each([
    [{ kind: 'downloading' }, '端末を更新しています 0%'],
    [{ kind: 'writing', pct: 42 }, '端末を更新しています 42%'],
    [{ kind: 'rebooting' }, '端末を再起動しています…'],
    [{ kind: 'confirming' }, '端末を再起動しています…'],
    [{ kind: 'done', ver: '0.2.0' }, '更新しました 0.2.0'],
    [{ kind: 'failed', reason: 'OTA ERR write' }, '更新できませんでした (元の版のまま)'],
  ] as Array<[SerialOtaState, string]>)('状態 %o は画面全体に「%s」と出す', async (state, text) => {
    const wrapper = await mountSuspended(FirmwareOtaHost)
    expect(overlay(wrapper).exists()).toBe(false)

    ota.state.value = state
    await flushPromises()
    expect(overlay(wrapper).text()).toBe(text)

    ota.state.value = { kind: 'idle' }
    await flushPromises()
    expect(overlay(wrapper).exists()).toBe(false)
    wrapper.unmount()
  })

  it('幕はどのモーダル (z-50) よりも上に出る', async () => {
    ota.state.value = { kind: 'writing', pct: 1 }
    const wrapper = await mountSuspended(FirmwareOtaHost)
    expect(overlay(wrapper).classes()).toContain('z-[60]')
    expect(overlay(wrapper).classes()).not.toContain('z-50')
    wrapper.unmount()
  })

  it('合図の購読も、更新の開始もしない (幕を描くだけ)', async () => {
    const wrapper = await mountSuspended(FirmwareOtaHost)
    ota.state.value = { kind: 'downloading' }
    await flushPromises()
    expect(timecardWatch).not.toHaveBeenCalled()
    expect(ota.enqueue).not.toHaveBeenCalled()
    expect(ota.runQueued).not.toHaveBeenCalled()
    expect(ota.run).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
