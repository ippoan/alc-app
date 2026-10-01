import { describe, it, expect, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ItTenkoGuide from '~/components/ItTenkoGuide.vue'

// IT点呼 の手順書の枠 (Refs ippoan/alc-app#387)。手順書そのものは public/it-tenko-guide.html
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
    expect(iframe.attributes('title')).toBe('IT点呼 の手順')
    wrapper.unmount()
  })

  it('説明は「IT点呼 の手順書です (A4 2 枚)。印刷して使ってください。」だけ (試験・本番の語を書かない)', async () => {
    const wrapper = await mountSuspended(ItTenkoGuide)
    expect(wrapper.find('p').text()).toBe('IT点呼 の手順書です (A4 2 枚)。印刷して使ってください。')
    for (const word of ['試験', '開発', '本番']) expect(wrapper.text()).not.toContain(word)
    wrapper.unmount()
  })

  it('「印刷する」で iframe の contentWindow.print が 1 回呼ばれる', async () => {
    const wrapper = await mountSuspended(ItTenkoGuide)
    const print = vi.fn()
    const iframe = wrapper.find('iframe').element as HTMLIFrameElement
    Object.defineProperty(iframe, 'contentWindow', { value: { print }, configurable: true })

    await wrapper.findAll('button').find(b => b.text() === '印刷する')!.trigger('click')
    expect(print).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('contentWindow が取れないときに「印刷する」を押しても例外を出さない', async () => {
    const wrapper = await mountSuspended(ItTenkoGuide)
    const iframe = wrapper.find('iframe').element as HTMLIFrameElement
    Object.defineProperty(iframe, 'contentWindow', { value: null, configurable: true })

    await expect(
      wrapper.findAll('button').find(b => b.text() === '印刷する')!.trigger('click'),
    ).resolves.toBeUndefined()
    wrapper.unmount()
  })
})
