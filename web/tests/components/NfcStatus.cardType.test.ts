import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, readonly } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import NfcStatus from '~/components/NfcStatus.vue'

// `read` の第 4 引数 (card_type) を、**発火元から NfcStatus の emit まで通して**固定する
// (Refs ippoan/alc-app#387)。useNfcReader と useNfcWebSocket は実物のまま繋ぎ、
// 端 (WebSocket / CoreS3 の EVT) だけを差し替える。
//
// 見るのは 1 点: **card_type はその read 自身の値で、前の読み取りのものが残らない**。
// IT点呼 の本人確認 (免許証だけ) がこれに乗っている — 残ると、免許証のあとにかざした
// 免許証でないカードが前の人の 'driver_license' で通ってしまう。

// --- NFC ブリッジ (WebSocket 9876) ---

let wsInstances: MockWebSocket[] = []
class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readyState = MockWebSocket.OPEN
  onopen: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  constructor(public url: string) {
    wsInstances.push(this)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
  }
}
/** ブリッジから JSON が 1 通届いた体にする */
function bridgeSends(message: Record<string, unknown>) {
  wsInstances[wsInstances.length - 1]!.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }))
}

// --- USB 直結 (CoreS3 / 測定台の Atom S3) ---

// useNfcReader は CoreS3 の EVT を **module で 1 回だけ**繋ぐ。受け口はテストをまたいで
// 持ち続ける (配る先は component の unmount で外れる)
const coreEventHandlers: Array<(name: string, args: string[]) => void> = []
mockNuxtImport('useCoreS3Serial', () => () => ({
  isConnected: readonly(ref(false)),
  connect: vi.fn(async () => false),
  requestPort: vi.fn(async () => true),
  onEvent: (cb: (name: string, args: string[]) => void) => { coreEventHandlers.push(cb) },
}))
mockNuxtImport('useAtomS3Serial', () => () => ({
  isConnected: readonly(ref(false)),
  onEvent: () => {},
}))
/** CoreS3 から `EVT <NAME> <args...>` が届いた体にする */
function coreSends(name: string, args: string[]) {
  for (const cb of [...coreEventHandlers]) cb(name, args)
}

const serialSupport = vi.hoisted(() => ({ supported: true }))
vi.mock('~/utils/webserial', () => ({
  isWebSerialSupported: () => serialSupport.supported,
}))

// --- NfcStatus の表示まわり (ここでは見ない) ---

mockNuxtImport('useNfcBridgeUpdate', () => () => ({
  latestVersion: ref<string | null>(null),
  checkLatestVersion: vi.fn(async () => {}),
  isUpdateAvailable: vi.fn(() => false),
}))
mockNuxtImport('useFingerprint', () => () => ({
  isAndroidApp: ref(false),
  deviceModel: ref<string | null>(null),
}))
mockNuxtImport('useKioskAccess', () => () => ({ isCheckingKioskAccess: ref(false) }))
mockNuxtImport('useSerialArbiter', () => () => ({
  arbitratedDeviceKind: readonly(ref(null)),
}))

const ISSUE = '20230401'
const EXPIRY = '20280401'
/** 免許証 IC の 26 桁 (先頭 10 桁は詰め物) */
const LICENSE_CARD_ID = '0000000000' + ISSUE + EXPIRY

describe('NfcStatus — read の第 4 引数 (card_type) は、その読み取り自身の値', () => {
  let originalWebSocket: typeof WebSocket

  beforeEach(() => {
    wsInstances = []
    serialSupport.supported = true
    originalWebSocket = globalThis.WebSocket
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.stubGlobal('WebSocket', originalWebSocket)
    vi.restoreAllMocks()
  })

  /** emit された read の (employee_id, card_type) の並び */
  function readsOf(wrapper: Awaited<ReturnType<typeof mountSuspended>>) {
    return (wrapper.emitted('read') ?? []).map(args => [args[0], args[3]])
  }

  describe.each([
    { name: 'WebSerial 対応 (useNfcReader がブリッジを中継する)', supported: true },
    { name: 'WebSerial 未対応 (useNfcWebSocket に直結)', supported: false },
  ])('$name', ({ supported }) => {
    beforeEach(() => { serialSupport.supported = supported })

    it('ブリッジの免許証は driver_license が載る (既存の 3 引数はそのまま)', async () => {
      const wrapper = await mountSuspended(NfcStatus)

      bridgeSends({
        type: 'nfc_license_read', card_type: 'driver_license', card_id: LICENSE_CARD_ID, expiry_date: LICENSE_CARD_ID, atr: 'XX',
      })

      const emitted = wrapper.emitted('read')!
      expect(emitted).toHaveLength(1)
      const [employeeId, expiryDate, source, cardType] = emitted[0]!
      expect(employeeId).toBe(ISSUE + EXPIRY)
      expect((expiryDate as Date).getFullYear()).toBe(2028)
      expect(source).toBe('bridge')
      expect(cardType).toBe('driver_license')
      wrapper.unmount()
    })

    it.each(['other', 'car_inspection'] as const)('ブリッジの免許証でないカード (%s) は、その種類が載る', async (cardType) => {
      const wrapper = await mountSuspended(NfcStatus)

      bridgeSends({ type: 'nfc_license_read', card_type: cardType, card_id: 'CARD-A', atr: 'XX' })

      expect(readsOf(wrapper)).toEqual([['CARD-A', cardType]])
      wrapper.unmount()
    })

    it('素の nfc_read には載らない', async () => {
      const wrapper = await mountSuspended(NfcStatus)

      bridgeSends({ type: 'nfc_read', employee_id: 'EMP001' })

      expect(readsOf(wrapper)).toEqual([['EMP001', undefined]])
      wrapper.unmount()
    })

    it('★ 免許証 → 素の read の順に来ても、2 件目に card_type が付かない', async () => {
      const wrapper = await mountSuspended(NfcStatus)

      bridgeSends({
        type: 'nfc_license_read', card_type: 'driver_license', card_id: LICENSE_CARD_ID, expiry_date: LICENSE_CARD_ID, atr: 'XX',
      })
      bridgeSends({ type: 'nfc_read', employee_id: 'EMP001' })

      expect(readsOf(wrapper)).toEqual([
        [ISSUE + EXPIRY, 'driver_license'],
        ['EMP001', undefined],
      ])
      // 期限 (第 2 引数) は今までどおり前の免許証のものが残る — 残らないのは card_type だけ。
      // だから「期限があるか」では免許証かどうかを判定できない
      expect(wrapper.emitted('read')![1]![1]).toBeInstanceOf(Date)
      wrapper.unmount()
    })
  })

  it('★ CoreS3 の免許証 → ブリッジの素の read の順でも、2 件目に card_type が付かない', async () => {
    const wrapper = await mountSuspended(NfcStatus)

    coreSends('NFC_LICENSE', [`issue=${ISSUE}`, `expiry=${EXPIRY}`])
    bridgeSends({ type: 'nfc_read', employee_id: 'EMP001' })

    expect(readsOf(wrapper)).toEqual([
      [ISSUE + EXPIRY, 'driver_license'],
      ['EMP001', undefined],
    ])
    expect(wrapper.emitted('read')![0]![2]).toBe('cores3')
    wrapper.unmount()
  })
})
