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

const latestVersion = ref<string | null>(null)
mockNuxtImport('useNfcBridgeUpdate', () => () => ({
  latestVersion,
  checkLatestVersion: vi.fn(async () => {}),
  isUpdateAvailable: vi.fn(() => false),
}))

const coreS3Connected = ref(false)
const requestPortMock = vi.fn(async () => true)
mockNuxtImport('useCoreS3Serial', () => () => ({
  isConnected: readonly(coreS3Connected),
  requestPort: requestPortMock,
  startupProbe: vi.fn(async () => false),
  isStartupProbing: ref(false),
}))

// 血圧測定台の Atom S3 (Refs ippoan/alc-app#353)
const atomS3Connected = ref(false)
mockNuxtImport('useAtomS3Serial', () => () => ({
  isConnected: readonly(atomS3Connected),
}))

const deviceModelForFingerprint = ref<string | null>(null)
mockNuxtImport('useFingerprint', () => () => ({
  isAndroidApp: ref(false),
  deviceModel: deviceModelForFingerprint,
}))

const isCheckingKioskAccess = ref(false)
mockNuxtImport('useKioskAccess', () => () => ({ isCheckingKioskAccess }))

// 端末の名乗り (`DEVICE bp-station`)。測定台かどうかの判定は `useBpStationMode` 1 か所で、
// URL の印と名乗りの OR (Refs ippoan/alc-app#368)
const arbitratedDeviceKind = ref<'bp-station' | 'other' | null>(null)
mockNuxtImport('useSerialArbiter', () => () => ({
  arbitratedDeviceKind: readonly(arbitratedDeviceKind),
}))

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
    atomS3Connected.value = false
    arbitratedDeviceKind.value = null
    latestVersion.value = null
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

// 測定台 (`?station=bp`) は CoreS3 ではなく Atom S3 が挿さる (Refs ippoan/alc-app#353)。
// 「カードは読めるのに赤ランプ + CoreS3 を確認しろ」と出さない
describe('NfcStatus — 血圧測定台の未接続案内 (Refs #353)', () => {
  beforeEach(() => {
    isConnected.value = false
    coreS3Connected.value = false
    atomS3Connected.value = false
    arbitratedDeviceKind.value = null
    latestVersion.value = null
    webSerialSupported = true
    isCheckingKioskAccess.value = false
  })

  it('CoreS3 キオスク: 未接続案内は従来どおり CoreS3 を名指しし、ATOM S3 は出ない', async () => {
    const wrapper = await mountSuspended(NfcStatus)
    expect(wrapper.text()).toContain('CoreS3 が USB でつながっているか確認してください。')
    expect(wrapper.text()).toContain('初めて使う端末では、下のボタンで USB デバイスの使用を許可してください。')
    expect(wrapper.text()).not.toContain('ATOM S3')
    expect(findButtonByText(wrapper, 'USB デバイスを選択')).toBeTruthy()
    wrapper.unmount()
  })

  it('測定台: 未接続案内は ATOM S3 (VoiceS3R) を名指しし、CoreS3 は出ない', async () => {
    const wrapper = await mountSuspended(NfcStatus, { route: '/?role=driver&tab=bp&station=bp' })
    expect(wrapper.text()).toContain('測定台の ATOM S3 (VoiceS3R) が USB でつながっているか確認してください。')
    expect(wrapper.text()).toContain('初めて使う端末では、下のボタンで USB デバイスの使用を許可してください。')
    expect(wrapper.text()).not.toContain('CoreS3')
    // 許可ボタンは測定台でも要る (初回の USB 許可はユーザー操作)
    expect(findButtonByText(wrapper, 'USB デバイスを選択')).toBeTruthy()
    wrapper.unmount()
  })

  it('測定台: ATOM S3 が繋がっていれば未接続案内も USB 許可ボタンも出さない', async () => {
    atomS3Connected.value = true
    const wrapper = await mountSuspended(NfcStatus, { route: '/?role=driver&tab=bp&station=bp' })
    expect(wrapper.text()).not.toContain('が USB でつながっているか確認してください')
    expect(wrapper.text()).not.toContain('CoreS3')
    expect(findButtonByText(wrapper, 'USB デバイスを選択')).toBeFalsy()
    wrapper.unmount()
  })

  it('ATOM S3 が USB 直結なら NFC ブリッジの更新案内は出さない', async () => {
    isConnected.value = true
    latestVersion.value = '9.9.9'
    atomS3Connected.value = true
    const wrapper = await mountSuspended(NfcStatus)
    expect(wrapper.text()).not.toContain('NFC ブリッジの新しいバージョン')
    wrapper.unmount()
  })

  it('CoreS3 が USB 直結でも NFC ブリッジの更新案内は出さない (従来どおり)', async () => {
    isConnected.value = true
    latestVersion.value = '9.9.9'
    coreS3Connected.value = true
    const wrapper = await mountSuspended(NfcStatus)
    expect(wrapper.text()).not.toContain('NFC ブリッジの新しいバージョン')
    wrapper.unmount()
  })

  it('USB 直結が無くブリッジだけが繋がっていれば、NFC ブリッジの更新案内を出す (従来どおり)', async () => {
    isConnected.value = true
    latestVersion.value = '9.9.9'
    const wrapper = await mountSuspended(NfcStatus)
    expect(wrapper.text()).toContain('NFC ブリッジの新しいバージョン')
    wrapper.unmount()
  })
})

// IC カードの打刻案内ボタンをタッチ枠の中に出す (Refs ippoan/rust-alc-api#644)
describe('NfcStatus — promptActive (タッチ枠の中身の差し替え、Refs #644)', () => {
  beforeEach(() => {
    isConnected.value = false
    coreS3Connected.value = false
    atomS3Connected.value = false
    arbitratedDeviceKind.value = null
    latestVersion.value = null
    webSerialSupported = true
    isCheckingKioskAccess.value = false
  })

  it('promptActive が false なら「NFC カードをタッチしてください」を出す', async () => {
    const wrapper = await mountSuspended(NfcStatus, {
      props: { promptActive: false },
      slots: { 'punch-prompt': '<div data-testid="slot-content">案内ボタン</div>' },
    })
    expect(wrapper.text()).toContain('NFC カードをタッチしてください')
    // punch-prompt スロットは promptActive に関係なく**常に**描画する。中身
    // (IcPunchAlcoholPrompt) が自分で出す/出さないを決め、出しているあいだだけ
    // 呼び出し元が promptActive を true にする。ここを v-if で包むと、マウントされない
    // → emit されない → 永久に false のままの鶏と卵になる (実機で再現、Refs #644)
    expect(wrapper.find('[data-testid="slot-content"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('promptActive が true ならタッチの案内を出さず、スロットの中身を出す', async () => {
    const wrapper = await mountSuspended(NfcStatus, {
      props: { promptActive: true },
      slots: { 'punch-prompt': '<div data-testid="slot-content">案内ボタン</div>' },
    })
    expect(wrapper.text()).not.toContain('NFC カードをタッチしてください')
    expect(wrapper.find('[data-testid="slot-content"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('promptActive が true でも NFC 位置ガイド / 読み取り ID / 免許証有効期限は今までどおり出す', async () => {
    deviceModelForFingerprint.value = 'KC-T305CN'
    const wrapper = await mountSuspended(NfcStatus, {
      props: { promptActive: true },
      slots: { 'punch-prompt': '<div data-testid="slot-content">案内ボタン</div>' },
    })
    // NFC 位置ガイドボタン (Kyocera 端末判定) は promptActive に関係なく出る
    expect(findButtonByText(wrapper, 'NFC 位置ガイド')).toBeTruthy()
    deviceModelForFingerprint.value = null
    wrapper.unmount()
  })
})

// 測定台かどうかは URL だけでなく端末の名乗りでも決まる (Refs ippoan/alc-app#368)。
// 未接続案内が変わるのは「一度繋いで名乗りが決着したあとに抜線した」ときだけ —
// 未接続のままなら probe が走らず名乗りも立たないので、(b) の CoreS3 のままが正しい。
describe('NfcStatus — 測定台の判定は端末の名乗りも見る (Refs #368)', () => {
  beforeEach(() => {
    isConnected.value = false
    coreS3Connected.value = false
    atomS3Connected.value = false
    arbitratedDeviceKind.value = null
    latestVersion.value = null
    webSerialSupported = true
    isCheckingKioskAccess.value = false
  })

  it('(a) URL に station=bp が無くても、端末が bp-station と名乗れば ATOM S3 を名指しする', async () => {
    arbitratedDeviceKind.value = 'bp-station'
    const wrapper = await mountSuspended(NfcStatus, { route: '/' })
    expect(wrapper.text()).toContain('測定台の ATOM S3 (VoiceS3R) が USB でつながっているか確認してください。')
    expect(wrapper.text()).not.toContain('CoreS3')
    wrapper.unmount()
  })

  it('(b) URL に station=bp が無く、名乗りが未決着 (null) なら CoreS3 のまま', async () => {
    arbitratedDeviceKind.value = null
    const wrapper = await mountSuspended(NfcStatus, { route: '/' })
    expect(wrapper.text()).toContain('CoreS3 が USB でつながっているか確認してください。')
    expect(wrapper.text()).not.toContain('ATOM S3')
    wrapper.unmount()
  })

  it('(c) URL に station=bp があれば、名乗りが未決着でも従来どおり ATOM S3 を名指しする', async () => {
    arbitratedDeviceKind.value = null
    const wrapper = await mountSuspended(NfcStatus, { route: '/?role=driver&tab=bp&station=bp' })
    expect(wrapper.text()).toContain('測定台の ATOM S3 (VoiceS3R) が USB でつながっているか確認してください。')
    expect(wrapper.text()).not.toContain('CoreS3')
    wrapper.unmount()
  })
})
