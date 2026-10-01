// CoreS3 のファームの更新の置き場 (Refs ippoan/alc-app#403)。
// いまは報告 (useFirmwareReport) を mount で始め、unmount で止めるだけで、描画するものは無い。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import FirmwareOtaHost from '~/components/FirmwareOtaHost.vue'

const reportMock = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }))
mockNuxtImport('useFirmwareReport', () => () => reportMock)

describe('FirmwareOtaHost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('mount で報告を始め、unmount で止める', async () => {
    const wrapper = await mountSuspended(FirmwareOtaHost)
    expect(reportMock.start).toHaveBeenCalledTimes(1)
    expect(reportMock.stop).not.toHaveBeenCalled()

    wrapper.unmount()

    expect(reportMock.stop).toHaveBeenCalledTimes(1)
    expect(reportMock.start).toHaveBeenCalledTimes(1)
  })

  it('描画するものは無い (要素を 1 つも出さない)', async () => {
    const wrapper = await mountSuspended(FirmwareOtaHost)
    expect(wrapper.element.nodeType).not.toBe(Node.ELEMENT_NODE)
    expect(wrapper.text()).toBe('')
    wrapper.unmount()
  })
})
