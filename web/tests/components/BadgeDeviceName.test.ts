// 右下の版の表示の「端末: <名前>」(Refs ippoan/alc-app-s3#352)。
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import BadgeDeviceName from '~/components/BadgeDeviceName.vue'

const text = ref<string | null>(null)
mockNuxtImport('useBadgeDeviceName', () => () => text)

describe('BadgeDeviceName', () => {
  it('名前があれば「/ 端末: <名前>」を出し、title に全文を入れる', async () => {
    text.value = 'vein-事務所 / 事務所の CoreS3'
    const w = await mountSuspended(BadgeDeviceName)
    const el = w.find('[data-testid="badge-device-name"]')
    expect(el.text()).toBe('/ 端末: vein-事務所 / 事務所の CoreS3')
    expect(el.find('[title]').attributes('title')).toBe('vein-事務所 / 事務所の CoreS3')
  })

  it('名前が無ければ何も出さない', async () => {
    text.value = null
    const w = await mountSuspended(BadgeDeviceName)
    expect(w.find('[data-testid="badge-device-name"]').exists()).toBe(false)
  })
})
