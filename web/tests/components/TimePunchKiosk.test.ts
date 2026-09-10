import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, readonly } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import TimePunchKiosk from '~/components/TimePunchKiosk.vue'

// --- API のモック (NFC 表示だけを見るので中身は空で足りる) ---

vi.mock('~/utils/api', () => ({
  punchTimecard: vi.fn(async () => {}),
  listTimePunches: vi.fn(async () => ({ punches: [] })),
  getEmployees: vi.fn(async () => []),
}))

// --- composable のモック (NFC 接続表示 3 状態だけを動かす) ---

const nfcConnected = ref(false)
const nfcOnReadMock = vi.fn()
mockNuxtImport('useNfcWebSocket', () => () => ({
  isConnected: readonly(nfcConnected),
  connect: vi.fn(),
  onRead: nfcOnReadMock,
}))

const coreS3Connected = ref(false)
mockNuxtImport('useCoreS3Serial', () => () => ({
  isConnected: readonly(coreS3Connected),
}))

mockNuxtImport('useAuth', () => () => ({
  accessToken: ref(null),
}))

mockNuxtImport('useFingerprint', () => () => ({
  deviceModel: ref(null),
}))

mockNuxtImport('useDeviceToken', () => () => ({
  getDeviceJwt: vi.fn(() => null),
}))

mockNuxtImport('useHubClaim', () => () => ({
  lastError: ref(null),
}))

mockNuxtImport('useTimecardWatch', () => () => ({
  connect: vi.fn(async () => {}),
}))

describe('TimePunchKiosk — NFC 接続表示の 3 状態 (Refs ippoan/alc-app#216)', () => {
  beforeEach(() => {
    nfcConnected.value = false
    coreS3Connected.value = false
  })

  it('CoreS3 直結が繋がっていれば緑で「NFC 端末接続中」を出す', async () => {
    coreS3Connected.value = true
    const wrapper = await mountSuspended(TimePunchKiosk)

    expect(wrapper.text()).toContain('NFC 端末接続中 (端末が打刻します)')
    expect(wrapper.find('.bg-green-500').exists()).toBe(true)
    expect(wrapper.find('.bg-red-500').exists()).toBe(false)
    wrapper.unmount()
  })

  it('CoreS3 は未接続で PC の NFC ブリッジだけ繋がっていれば緑で「NFC ブリッジ接続中」を出す', async () => {
    nfcConnected.value = true
    const wrapper = await mountSuspended(TimePunchKiosk)

    expect(wrapper.text()).toContain('NFC ブリッジ接続中')
    expect(wrapper.find('.bg-green-500').exists()).toBe(true)
    expect(wrapper.find('.bg-red-500').exists()).toBe(false)
    wrapper.unmount()
  })

  it('どちらも未接続なら赤で「NFC リーダー未接続」を出す', async () => {
    const wrapper = await mountSuspended(TimePunchKiosk)

    expect(wrapper.text()).toContain('NFC リーダー未接続')
    expect(wrapper.find('.bg-red-500').exists()).toBe(true)
    expect(wrapper.find('.bg-green-500').exists()).toBe(false)
    wrapper.unmount()
  })
})
