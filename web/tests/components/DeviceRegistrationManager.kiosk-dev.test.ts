import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import DeviceRegistrationManager from '~/components/DeviceRegistrationManager.vue'

// 「この端末をキオスクにする」の開発用の選択肢 (Refs ippoan/alc-app#387)。
// 開発者にだけチェックを出し、チェックしたときだけ setupAsKiosk に devDevice: true を渡す。

// 開発者の判定に使うアドレスはコンポーネントのソースから取る (テストに書き写さない)
const SOURCE = readFileSync(
  resolve(import.meta.dirname!, '../../app/components/DeviceRegistrationManager.vue'),
  'utf-8',
)
const DEVELOPER_EMAIL = SOURCE.match(/user\.value\?\.email === '([^']+)'/)![1]!

vi.mock('~/utils/api', () => ({
  listDevices: vi.fn(async () => []),
  listPendingDeviceRegistrations: vi.fn(async () => []),
  createDeviceUrlToken: vi.fn(),
  createPermanentQr: vi.fn(),
  createDeviceOwnerToken: vi.fn(),
  approveDevice: vi.fn(),
  rejectDevice: vi.fn(),
  disableDevice: vi.fn(),
  enableDevice: vi.fn(),
  deleteDevice: vi.fn(),
  updateDeviceCallSettings: vi.fn(),
  testFcmNotification: vi.fn(),
  testFcmAll: vi.fn(),
  triggerUpdate: vi.fn(),
  authorizeRepair: vi.fn(),
}))

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,') } }))

const user = ref<{ email: string } | null>(null)
const accessToken = ref<string | null>('admin-jwt')
mockNuxtImport('useAuth', () => () => ({ user, accessToken }))

const setupAsKioskMock = vi.fn<(...args: unknown[]) => Promise<boolean | 'dev_forbidden'>>(async () => true)
mockNuxtImport('useDeviceToken', () => () => ({
  hasKioskCredential: ref(false),
  setupAsKiosk: setupAsKioskMock,
}))

async function mountIt() {
  const wrapper = await mountSuspended(DeviceRegistrationManager)
  await flushPromises()
  return wrapper
}

function kioskButton(wrapper: Awaited<ReturnType<typeof mountIt>>) {
  return wrapper.findAll('button').find(b => b.text() === 'キオスクにする')!
}

describe('DeviceRegistrationManager — 開発用のキオスク', () => {
  beforeEach(() => {
    setupAsKioskMock.mockReset()
    setupAsKioskMock.mockResolvedValue(true)
    accessToken.value = 'admin-jwt'
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })))
  })

  it('開発者でないとチェックを出さず、devDevice: false で設定する', async () => {
    user.value = { email: 'someone@example.com' }
    const wrapper = await mountIt()

    expect(wrapper.find('[data-testid="kiosk-records-dev"]').exists()).toBe(false)
    await kioskButton(wrapper).trigger('click')
    await flushPromises()

    expect(setupAsKioskMock).toHaveBeenCalledWith('admin-jwt', 'kiosk', { devDevice: false })
    expect(wrapper.text()).toContain('この端末をキオスクに設定しました')
  })

  it('開発者にはチェックを出し、チェックすると devDevice: true を渡して開発用と添える', async () => {
    user.value = { email: DEVELOPER_EMAIL }
    const wrapper = await mountIt()

    const box = wrapper.find('[data-testid="kiosk-records-dev"]')
    expect(box.exists()).toBe(true)
    expect(wrapper.text()).toContain('記録を開発用にする (本番の記録に入りません)')
    await box.setValue(true)
    await kioskButton(wrapper).trigger('click')
    await flushPromises()

    expect(setupAsKioskMock).toHaveBeenCalledWith('admin-jwt', 'kiosk', { devDevice: true })
    expect(wrapper.text()).toContain('この端末を開発用のキオスクに設定しました')
  })

  it('開発者でもチェックしなければ devDevice: false', async () => {
    user.value = { email: DEVELOPER_EMAIL }
    const wrapper = await mountIt()

    await kioskButton(wrapper).trigger('click')
    await flushPromises()

    expect(setupAsKioskMock).toHaveBeenCalledWith('admin-jwt', 'kiosk', { devDevice: false })
  })

  it('開発用を断られた (403) ら Google ログインの案内を出す', async () => {
    user.value = { email: DEVELOPER_EMAIL }
    setupAsKioskMock.mockResolvedValue('dev_forbidden')
    const wrapper = await mountIt()

    await wrapper.find('[data-testid="kiosk-records-dev"]').setValue(true)
    await kioskButton(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('開発用のキオスクは開発者の Google ログインでだけ作れます')
  })

  it('それ以外の失敗は従来の文言', async () => {
    user.value = { email: 'someone@example.com' }
    setupAsKioskMock.mockResolvedValue(false)
    const wrapper = await mountIt()

    await kioskButton(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('キオスク設定に失敗しました')
  })
})
