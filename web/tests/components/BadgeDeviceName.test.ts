// 右下の版の表示の「端末: <名前>」(Refs ippoan/alc-app-s3#352)。
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import BadgeDeviceName from '~/components/BadgeDeviceName.vue'

const device = ref<{ text: string, title: string } | null>(null)
mockNuxtImport('useBadgeDeviceName', () => () => device)

describe('BadgeDeviceName', () => {
  it('名前があれば「/ 端末: <名前> (<短縮 id>)」を出し、title に id の全文を入れる', async () => {
    device.value = { text: 'vein-事務所 (alarm-012345…)', title: 'vein-事務所 (alarm-0123456789abcdef)' }
    const w = await mountSuspended(BadgeDeviceName)
    const el = w.find('[data-testid="badge-device-name"]')
    expect(el.text()).toBe('/ 端末: vein-事務所 (alarm-012345…)')
    expect(el.find('[title]').attributes('title')).toBe('vein-事務所 (alarm-0123456789abcdef)')
  })

  it('名前が無ければ何も出さない', async () => {
    device.value = null
    const w = await mountSuspended(BadgeDeviceName)
    expect(w.find('[data-testid="badge-device-name"]').exists()).toBe(false)
  })
})
