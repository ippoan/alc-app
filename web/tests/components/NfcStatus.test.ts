import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, readonly } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import NfcStatus from '~/components/NfcStatus.vue'

// --- composable のモック (serial ブロックの表示条件だけを動かす、Refs #234) ---

const isConnected = ref(false)
mockNuxtImport('useNfcReader', () => () => ({
  isConnected: readonly(isConnected),
  error: ref<string | null>(null),
  readers: ref<string[]>([]),
  bridgeVersion: ref<string | null>(null),
  connect: vi.fn(),
  onRead: vi.fn(),
  onLicenseRead: vi.fn(),
}))

mockNuxtImport('useNfcBridgeUpdate', () => () => ({
  latestVersion: ref<string | null>(null),
  checkLatestVersion: vi.fn(async () => {}),
  isUpdateAvailable: vi.fn(() => false),
}))

const coreS3Connected = ref(false)
const requestPortMock = vi.fn(async () => true)
mockNuxtImport('useCoreS3Serial', () => () => ({
  isConnected: readonly(coreS3Connected),
  requestPort: requestPortMock,
}))

mockNuxtImport('useFingerprint', () => () => ({
  isAndroidApp: ref(false),
  deviceModel: ref<string | null>(null),
}))

const isCheckingKioskAccess = ref(false)
mockNuxtImport('useKioskAccess', () => () => ({ isCheckingKioskAccess }))

let webSerialSupported = true
vi.mock('~/utils/webserial', () => ({
  isWebSerialSupported: () => webSerialSupported,
}))

function findButtonByText(wrapper: { findAll: (s: string) => { text: () => string }[] }, text: string) {
  return wrapper.findAll('button').find(b => b.text() === text)
}

describe('NfcStatus — serial ブロックの表示条件 (Refs #234)', () => {
  beforeEach(() => {
    isConnected.value = false
    coreS3Connected.value = false
    webSerialSupported = true
    isCheckingKioskAccess.value = false
    requestPortMock.mockClear()
  })

  it('NFC ブリッジ未接続・CoreS3 未接続なら USB 許可ボタンを出す', async () => {
    const wrapper = await mountSuspended(NfcStatus)
    expect(findButtonByText(wrapper, 'USB デバイスを選択')).toBeTruthy()
    wrapper.unmount()
  })

  it('NFC ブリッジは接続済みでも CoreS3 が未接続なら USB 許可ボタンを出す (ブリッジ接続とは切り離す)', async () => {
    isConnected.value = true
    const wrapper = await mountSuspended(NfcStatus)
    expect(findButtonByText(wrapper, 'USB デバイスを選択')).toBeTruthy()
    wrapper.unmount()
  })

  it('CoreS3 が接続済みなら USB 許可ボタンを出さない', async () => {
    coreS3Connected.value = true
    const wrapper = await mountSuspended(NfcStatus)
    expect(findButtonByText(wrapper, 'USB デバイスを選択')).toBeFalsy()
    wrapper.unmount()
  })

  it('WebSerial 未対応かつ NFC ブリッジ未接続なら従来の案内を出す', async () => {
    webSerialSupported = false
    const wrapper = await mountSuspended(NfcStatus)
    expect(findButtonByText(wrapper, 'USB デバイスを選択')).toBeFalsy()
    expect(wrapper.text()).toContain('NFC ブリッジがインストールされていない場合は')
    wrapper.unmount()
  })

  it('WebSerial 未対応かつ NFC ブリッジ接続済みなら何も出さない', async () => {
    webSerialSupported = false
    isConnected.value = true
    const wrapper = await mountSuspended(NfcStatus)
    expect(wrapper.text()).not.toContain('NFC ブリッジがインストールされていない場合は')
    wrapper.unmount()
  })

  it('USB 許可ボタン押下で coreS3.requestPort を呼ぶ', async () => {
    const wrapper = await mountSuspended(NfcStatus)
    const button = findButtonByText(wrapper, 'USB デバイスを選択')
    await (button as unknown as { trigger: (e: string) => Promise<void> }).trigger('click')
    expect(requestPortMock).toHaveBeenCalled()
    wrapper.unmount()
  })

  // 起動時 CoreS3 探索中は「未登録」確定の表示を出さない (Refs #238)
  it('確認中は USB 許可ボタンを出さない (起動時 CoreS3 探索中)', async () => {
    isCheckingKioskAccess.value = true
    const wrapper = await mountSuspended(NfcStatus)
    expect(findButtonByText(wrapper, 'USB デバイスを選択')).toBeFalsy()
    wrapper.unmount()
  })

  it('確認中は「NFC リーダー未検出」を出さない', async () => {
    isConnected.value = true
    isCheckingKioskAccess.value = true
    const wrapper = await mountSuspended(NfcStatus)
    expect(wrapper.text()).not.toContain('NFC リーダー未検出')
    wrapper.unmount()
  })

  it('確認が終われば USB 許可ボタン・ステータス文言が出る', async () => {
    isCheckingKioskAccess.value = true
    const wrapper = await mountSuspended(NfcStatus)
    expect(findButtonByText(wrapper, 'USB デバイスを選択')).toBeFalsy()

    isCheckingKioskAccess.value = false
    await wrapper.vm.$nextTick()
    expect(findButtonByText(wrapper, 'USB デバイスを選択')).toBeTruthy()
    wrapper.unmount()
  })
})
