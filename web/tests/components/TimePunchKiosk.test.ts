import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, readonly } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import TimePunchKiosk from '~/components/TimePunchKiosk.vue'
import { getEmployees, listTimePunches } from '~/utils/api'

/** onMounted の await 群と watch の後段を流し切る */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

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
const coreS3Supported = ref(true)
const coreS3RequestPortMock = vi.fn(async () => true)
mockNuxtImport('useCoreS3Serial', () => () => ({
  isConnected: readonly(coreS3Connected),
  isSupported: coreS3Supported.value,
  requestPort: coreS3RequestPortMock,
}))

mockNuxtImport('useAuth', () => () => ({
  accessToken: ref(null),
}))

mockNuxtImport('useFingerprint', () => () => ({
  deviceModel: ref(null),
}))

const deviceJwtReady = ref(false)
mockNuxtImport('useDeviceToken', () => () => ({
  getDeviceJwt: vi.fn(() => null),
  hasDeviceJwt: readonly(deviceJwtReady),
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
    coreS3Supported.value = true
    coreS3RequestPortMock.mockClear()
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

describe('TimePunchKiosk — CoreS3 の USB 許可ボタン (Refs #234)', () => {
  beforeEach(() => {
    nfcConnected.value = false
    coreS3Connected.value = false
    coreS3Supported.value = true
    coreS3RequestPortMock.mockClear()
  })

  it('WebSerial 対応かつ CoreS3 未接続ならボタンを出す', async () => {
    const wrapper = await mountSuspended(TimePunchKiosk)
    expect(wrapper.text()).toContain('CoreS3 を USB で許可')
    wrapper.unmount()
  })

  it('CoreS3 が接続済みならボタンを出さない', async () => {
    coreS3Connected.value = true
    const wrapper = await mountSuspended(TimePunchKiosk)
    expect(wrapper.text()).not.toContain('CoreS3 を USB で許可')
    wrapper.unmount()
  })

  it('WebSerial 未対応環境ではボタンを出さない', async () => {
    coreS3Supported.value = false
    const wrapper = await mountSuspended(TimePunchKiosk)
    expect(wrapper.text()).not.toContain('CoreS3 を USB で許可')
    wrapper.unmount()
  })

  it('ボタン押下で coreS3.requestPort を呼ぶ', async () => {
    const wrapper = await mountSuspended(TimePunchKiosk)
    const button = wrapper.findAll('button').find(b => b.text() === 'CoreS3 を USB で許可')
    expect(button).toBeTruthy()
    await button!.trigger('click')
    expect(coreS3RequestPortMock).toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('TimePunchKiosk — 端末 JWT が取れたら一覧を引き直す (Refs #238)', () => {
  beforeEach(() => {
    deviceJwtReady.value = false
    vi.mocked(getEmployees).mockClear()
    vi.mocked(listTimePunches).mockClear()
  })

  it('hasDeviceJwt が true になったら employees と本日の打刻を引き直す', async () => {
    const wrapper = await mountSuspended(TimePunchKiosk)
    await flush()
    expect(getEmployees).toHaveBeenCalledTimes(1)
    expect(listTimePunches).toHaveBeenCalledTimes(1)

    deviceJwtReady.value = true
    await flush()
    expect(getEmployees).toHaveBeenCalledTimes(2)
    expect(listTimePunches).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('hasDeviceJwt が false に戻っても (抜線でキャッシュ破棄) 引き直さない', async () => {
    deviceJwtReady.value = true
    const wrapper = await mountSuspended(TimePunchKiosk)
    await flush()
    vi.mocked(getEmployees).mockClear()
    vi.mocked(listTimePunches).mockClear()

    deviceJwtReady.value = false
    await flush()
    expect(getEmployees).not.toHaveBeenCalled()
    expect(listTimePunches).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
