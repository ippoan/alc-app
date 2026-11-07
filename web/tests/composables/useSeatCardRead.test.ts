import { describe, it, expect, vi, beforeEach } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { useSeatCardRead } from '~/composables/useSeatCardRead'

// 警告デバイスの合図 (連番 + 照会に送る id) と、USB の機体の行の受け口
const cardRead = ref<{ seq: number, lookupId: string } | null>(null)
mockNuxtImport('useAlarmDevice', () => () => ({ cardRead }))
type HubEventHandler = (name: string, args: string[], source: string) => void
let hubHandler: HubEventHandler | null = null
const hubOff = vi.fn()
mockNuxtImport('useUsbHub', () => () => ({
  nfc: { onEvent: (cb: HubEventHandler) => { hubHandler = cb; return hubOff } },
}))

function mountReader() {
  const onCard = vi.fn()
  const wrapper = mount(defineComponent({
    setup() {
      useSeatCardRead(onCard)
      return () => h('div')
    },
  }))
  return { wrapper, onCard }
}

describe('useSeatCardRead', () => {
  beforeEach(() => {
    cardRead.value = null
    hubHandler = null
    hubOff.mockClear()
  })

  it('警告デバイスのカードと、USB の機体のカードの行 (社員証・免許証) を同じ合図で渡す', async () => {
    const { wrapper, onCard } = mountReader()
    cardRead.value = { seq: 1, lookupId: '0123456789abcdef' }
    await nextTick()
    hubHandler!('TIMECARD', ['card_id=04a1b2c3', 'card_kind=nfca_uid'], 'vein-station')
    hubHandler!('NFC_LICENSE', ['issue=20230609', 'expiry=20280513'], 'cores3')
    expect(onCard.mock.calls).toEqual([['0123456789abcdef'], ['04a1b2c3'], ['2023060920280513']])
    wrapper.unmount()
  })

  it('カードでない行・合図が消えた (null) ときは渡さない', async () => {
    const { wrapper, onCard } = mountReader()
    hubHandler!('FC1200', ['state=ready'], 'vein-station')
    cardRead.value = { seq: 1, lookupId: '04a1b2c3' }
    await nextTick()
    onCard.mockClear()
    cardRead.value = null
    await nextTick()
    expect(onCard).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('unmount で USB の受け口を外し、その後の合図は渡さない', async () => {
    const { wrapper, onCard } = mountReader()
    const handler = hubHandler!
    wrapper.unmount()
    expect(hubOff).toHaveBeenCalledTimes(1)
    handler('TIMECARD', ['card_id=04a1b2c3', 'card_kind=nfca_uid'], 'vein-station')
    cardRead.value = { seq: 2, lookupId: '04a1b2c3' }
    await nextTick()
    expect(onCard).not.toHaveBeenCalled()
  })
})
