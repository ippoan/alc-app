import { describe, it, expect, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ItTenkoGuide from '~/components/ItTenkoGuide.vue'

// IT点呼 の試験の手順書の枠 (Refs ippoan/alc-app#387)。手順書そのものは public/it-tenko-guide.html
const GUIDE_PATH = '/it-tenko-guide.html'

describe('ItTenkoGuide', () => {
  it('iframe の src と「別のタブで開く」の href が同じパスを指す', async () => {
    const wrapper = await mountSuspended(ItTenkoGuide)
    const iframe = wrapper.find('iframe')
    const link = wrapper.find('a')
    expect(iframe.attributes('src')).toBe(GUIDE_PATH)
    expect(link.attributes('href')).toBe(GUIDE_PATH)
    expect(link.text()).toBe('別のタブで開く')
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toBe('noopener')
    expect(iframe.attributes('title')).toBe('IT点呼 試験の手順')
    wrapper.unmount()
  })

  it('説明に A4 2 枚と、試験の記録が本番の記録簿に出ないことを書く', async () => {
    const wrapper = await mountSuspended(ItTenkoGuide)
    expect(wrapper.text()).toContain('A4 2 枚')
    expect(wrapper.text()).toContain('本番の点呼記録簿には出ません')
    wrapper.unmount()
  })

  it('「印刷する」で iframe の contentWindow.print が 1 回呼ばれる', async () => {
    const wrapper = await mountSuspended(ItTenkoGuide, { attachTo: document.body })
    const print = vi.fn()
    const iframe = wrapper.find('iframe').element as HTMLIFrameElement
    Object.defineProperty(iframe, 'contentWindow', { value: { print }, configurable: true })

    await wrapper.findAll('button').find(b => b.text() === '印刷する')!.trigger('click')
    expect(print).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('contentWindow が取れないときに「印刷する」を押しても例外を出さない', async () => {
    const wrapper = await mountSuspended(ItTenkoGuide, { attachTo: document.body })
    const iframe = wrapper.find('iframe').element as HTMLIFrameElement
    Object.defineProperty(iframe, 'contentWindow', { value: null, configurable: true })

    await expect(
      wrapper.findAll('button').find(b => b.text() === '印刷する')!.trigger('click'),
    ).resolves.toBeUndefined()
    wrapper.unmount()
  })
})
