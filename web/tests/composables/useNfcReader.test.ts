import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, readonly, nextTick } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import type { NfcReadEvent, NfcLicenseReadEvent, NfcErrorEvent } from '~/types'
import { parseLicenseIssueDate, parseLicenseExpiryDate } from '~/utils/license'
import { withSetup } from '../helpers/with-setup'

// --- WebSerial 対応判定 ---

const serialSupport = vi.hoisted(() => ({ supported: true }))
vi.mock('~/utils/webserial', () => ({
  isWebSerialSupported: () => serialSupport.supported,
}))

// --- useCoreS3Serial のモック (公開 API 11 キー) ---

const coreState = {
  isConnected: ref(false),
}
/** useNfcReader が繋いだ EVT の受け口 */
let coreEventHandlers: Array<(name: string, args: string[]) => void> = []
const coreMock = {
  isSupported: true,
  onJson: vi.fn(),
  onEvent: vi.fn((cb: (name: string, args: string[]) => void) => { coreEventHandlers.push(cb) }),
  onOpen: vi.fn(),
  onClose: vi.fn(),
  write: vi.fn(async () => true),
  connect: vi.fn(async () => coreState.isConnected.value),
  requestPort: vi.fn(async () => true),
  release: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
}
mockNuxtImport('useCoreS3Serial', () => () => ({
  ...coreMock,
  isConnected: readonly(coreState.isConnected),
}))

/** CoreS3 から `EVT <NAME> <args...>` が届いた体にする */
function emitCoreEvent(name: string, args: string[] = []) {
  for (const cb of [...coreEventHandlers]) cb(name, args)
}

// --- useNfcWebSocket のモック (公開 API 9 キー) ---

const wsState = {
  isConnected: ref(false),
  error: ref<string | null>(null),
  readers: ref<string[]>([]),
  bridgeVersion: ref<string | null>(null),
}
const wsCallbacks = {
  read: [] as Array<(e: NfcReadEvent) => void>,
  license: [] as Array<(e: NfcLicenseReadEvent) => void>,
  error: [] as Array<(e: NfcErrorEvent) => void>,
}
const wsMock = {
  connect: vi.fn(),
  disconnect: vi.fn(() => { wsState.isConnected.value = false }),
  onRead: vi.fn((cb: (e: NfcReadEvent) => void) => {
    wsCallbacks.read.push(cb)
    return () => {}
  }),
  onLicenseRead: vi.fn((cb: (e: NfcLicenseReadEvent) => void) => {
    wsCallbacks.license.push(cb)
    return () => {}
  }),
  onError: vi.fn((cb: (e: NfcErrorEvent) => void) => {
    wsCallbacks.error.push(cb)
    return () => {}
  }),
}
mockNuxtImport('useNfcWebSocket', () => () => ({
  ...wsMock,
  isConnected: readonly(wsState.isConnected),
  error: readonly(wsState.error),
  readers: readonly(wsState.readers),
  bridgeVersion: readonly(wsState.bridgeVersion),
}))

/**
 * ブリッジ経由で免許証が届いた体にする。
 * 実物の useNfcWebSocket は onLicenseRead → onRead の順で配る (:57 → :64)。
 */
function emitBridgeLicense(cardId: string) {
  for (const cb of [...wsCallbacks.license]) {
    cb({ type: 'nfc_license_read', card_type: 'driver_license', card_id: cardId, atr: '', expiry_date: cardId })
  }
  for (const cb of [...wsCallbacks.read]) {
    cb({ type: 'nfc_read', employee_id: cardId.substring(10, 26) })
  }
}

// --- Tests ---

const ISSUE = '20230401'
const EXPIRY = '20280401'
/** CoreS3 が組み立てるはずの 26 桁 (先頭 10 桁は詰め物) */
const CARD_ID = '0000000000' + ISSUE + EXPIRY

describe('useNfcReader', () => {
  let mod: typeof import('~/composables/useNfcReader')
  let app: ReturnType<typeof withSetup>[1] | null = null

  /** モジュール状態 (wired) ごと作り直して composable を立ち上げる */
  async function load() {
    vi.resetModules()
    mod = await import('~/composables/useNfcReader')
    const [reader, created] = withSetup(() => mod.useNfcReader())
    app = created
    return reader
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    serialSupport.supported = true
    coreEventHandlers = []
    wsCallbacks.read = []
    wsCallbacks.license = []
    wsCallbacks.error = []
    coreState.isConnected.value = false
    wsState.isConnected.value = false
    wsState.error.value = null
    wsState.readers.value = []
    wsState.bridgeVersion.value = null
  })

  afterEach(() => {
    app?.unmount()
    app = null
    vi.useRealTimers()
  })

  // ---------- 公開 API ----------

  it('useNfcWebSocket と同じ 9 キーを返す', async () => {
    const reader = await load()
    expect(Object.keys(reader).sort()).toEqual([
      'bridgeVersion', 'connect', 'disconnect', 'error', 'isConnected',
      'onError', 'onLicenseRead', 'onRead', 'readers',
    ])
  })

  it('WebSerial が無ければ useNfcWebSocket にそのまま委譲する', async () => {
    serialSupport.supported = false
    const reader = await load()

    expect(reader.connect).toBe(wsMock.connect)
    expect(reader.disconnect).toBe(wsMock.disconnect)
    // CoreS3 には一切触らない
    expect(coreMock.onEvent).not.toHaveBeenCalled()
  })

  it('EVT の受け口は 1 度しか繋がない (解除できないため)', async () => {
    const reader = await load()
    expect(coreMock.onEvent).toHaveBeenCalledTimes(1)

    // 2 つ目の component が同じ composable を呼んでも増えない
    const [second, secondApp] = withSetup(() => mod.useNfcReader())
    expect(coreMock.onEvent).toHaveBeenCalledTimes(1)

    // それでも 2 つ目にもイベントは配られる
    const seen: string[] = []
    second.onRead(e => seen.push(e.employee_id))
    reader.onRead(() => {})
    emitCoreEvent('NFC_LICENSE', [`issue=${ISSUE}`, `expiry=${EXPIRY}`])
    expect(seen).toEqual([ISSUE + EXPIRY])

    secondApp.unmount()
  })

  it('unmount した component には配らない', async () => {
    const reader = await load()
    const seen: string[] = []
    reader.onRead(e => seen.push(e.employee_id))

    app!.unmount()
    app = null
    emitCoreEvent('NFC_LICENSE', [`issue=${ISSUE}`, `expiry=${EXPIRY}`])
    expect(seen).toEqual([])
  })

  // ---------- CoreS3 直結の組み立て ----------

  it('NFC_LICENSE を 26 桁に組み立て、onLicenseRead → onRead の順で配る', async () => {
    const reader = await load()
    const order: string[] = []
    let license: NfcLicenseReadEvent | null = null
    let read: NfcReadEvent | null = null
    reader.onLicenseRead((e) => { order.push('license'); license = e })
    reader.onRead((e) => { order.push('read'); read = e })

    emitCoreEvent('NFC_LICENSE', [`issue=${ISSUE}`, `expiry=${EXPIRY}`])

    expect(order).toEqual(['license', 'read'])
    expect(license).toEqual({
      type: 'nfc_license_read',
      card_type: 'driver_license',
      card_id: CARD_ID,
      expiry_date: CARD_ID,
      atr: '',
    })
    expect(read).toEqual({ type: 'nfc_read', employee_id: ISSUE + EXPIRY })
  })

  it('組み立てた 26 桁は utils/license.ts の桁の契約を満たす', async () => {
    const reader = await load()
    let license: NfcLicenseReadEvent | null = null
    reader.onLicenseRead((e) => { license = e })

    emitCoreEvent('NFC_LICENSE', [`expiry=${EXPIRY}`, `issue=${ISSUE}`])

    const hex = license!.expiry_date!
    expect(hex).toHaveLength(26)
    expect(parseLicenseIssueDate(hex)).toEqual(new Date(2023, 3, 1))
    expect(parseLicenseExpiryDate(hex)).toEqual(new Date(2028, 3, 1))
    // LicenseRegistration が nfc_id に使う 16 桁
    expect(license!.card_id.substring(10, 26)).toBe(ISSUE + EXPIRY)
  })

  it.each([
    ['issue が無い', [`expiry=${EXPIRY}`]],
    ['expiry の桁が足りない', [`issue=${ISSUE}`, 'expiry=2028040']],
  ])('26 桁にできない NFC_LICENSE (%s) は捨てる', async (_label, args) => {
    const reader = await load()
    const seen: unknown[] = []
    reader.onLicenseRead(e => seen.push(e))
    reader.onRead(e => seen.push(e))

    emitCoreEvent('NFC_LICENSE', args)
    expect(seen).toEqual([])
  })

  it('LICENSE_EXPIRED を onError へ配る', async () => {
    const reader = await load()
    const seen: NfcErrorEvent[] = []
    reader.onError(e => seen.push(e))

    emitCoreEvent('LICENSE_EXPIRED', ['20200401'])
    expect(seen).toEqual([{ type: 'nfc_error', error: 'license_expired' }])
  })

  it('引数の無い EVT (NFC_REMOVED) は何も起こさない', async () => {
    const reader = await load()
    const seen: unknown[] = []
    reader.onRead(e => seen.push(e))
    reader.onError(e => seen.push(e))
    reader.onLicenseRead(e => seen.push(e))

    emitCoreEvent('NFC_REMOVED')
    expect(seen).toEqual([])
  })

  // ---------- 重複除去 ----------

  it('両経路から同じ免許証が来ても onRead は 1 回だけ', async () => {
    const reader = await load()
    const seen: string[] = []
    reader.onRead(e => seen.push(e.employee_id))

    emitCoreEvent('NFC_LICENSE', [`issue=${ISSUE}`, `expiry=${EXPIRY}`])
    // 常駐アプリがまだ生きていて 9876 からも同じ免許証が届く
    emitBridgeLicense(CARD_ID)

    expect(seen).toEqual([ISSUE + EXPIRY])
  })

  it('3 秒を過ぎれば同じ免許証をもう一度配る', async () => {
    const reader = await load()
    const seen: string[] = []
    reader.onRead(e => seen.push(e.employee_id))

    emitCoreEvent('NFC_LICENSE', [`issue=${ISSUE}`, `expiry=${EXPIRY}`])
    vi.advanceTimersByTime(3000)
    emitCoreEvent('NFC_LICENSE', [`issue=${ISSUE}`, `expiry=${EXPIRY}`])

    expect(seen).toHaveLength(2)
  })

  it('別の免許証は窓の中でも配る', async () => {
    const reader = await load()
    const seen: string[] = []
    reader.onRead(e => seen.push(e.employee_id))

    emitCoreEvent('NFC_LICENSE', [`issue=${ISSUE}`, `expiry=${EXPIRY}`])
    emitCoreEvent('NFC_LICENSE', ['issue=20240501', `expiry=${EXPIRY}`])

    expect(seen).toEqual([ISSUE + EXPIRY, '2024050120280401'])
  })

  // ---------- ブリッジ経由の中継 ----------

  it('ブリッジ経由の免許証も onLicenseRead / onRead へ中継する', async () => {
    const reader = await load()
    const licenses: NfcLicenseReadEvent[] = []
    const reads: string[] = []
    reader.onLicenseRead(e => licenses.push(e))
    reader.onRead(e => reads.push(e.employee_id))

    emitBridgeLicense(CARD_ID)

    expect(licenses).toHaveLength(1)
    expect(reads).toEqual([ISSUE + EXPIRY])
  })

  it('ブリッジのエラーを onError へ中継する', async () => {
    const reader = await load()
    const seen: NfcErrorEvent[] = []
    reader.onError(e => seen.push(e))

    for (const cb of wsCallbacks.error) cb({ type: 'nfc_error', error: 'no_readers' })
    expect(seen).toEqual([{ type: 'nfc_error', error: 'no_readers' }])
  })

  it('購読を解除したら配られない', async () => {
    const reader = await load()
    const reads: string[] = []
    const licenses: unknown[] = []
    const errors: unknown[] = []
    reader.onRead(e => reads.push(e.employee_id))()
    reader.onLicenseRead(e => licenses.push(e))()
    reader.onError(e => errors.push(e))()

    emitCoreEvent('NFC_LICENSE', [`issue=${ISSUE}`, `expiry=${EXPIRY}`])
    emitCoreEvent('LICENSE_EXPIRED', ['20200401'])

    expect(reads).toEqual([])
    expect(licenses).toEqual([])
    expect(errors).toEqual([])
  })

  // ---------- 経路の切り替え ----------

  it('connect(): CoreS3 を掴みに行き、直結していなければブリッジも繋ぐ', async () => {
    const reader = await load()
    reader.connect()

    expect(coreMock.connect).toHaveBeenCalledTimes(1)
    expect(wsMock.connect).toHaveBeenCalledTimes(1)
  })

  it('connect(): 直結済みならブリッジは繋がない', async () => {
    coreState.isConnected.value = true
    const reader = await load()
    reader.connect()

    expect(coreMock.connect).toHaveBeenCalledTimes(1)
    expect(wsMock.connect).not.toHaveBeenCalled()
  })

  it('core.isConnected が既に true の状態で新しく呼ぶと、connect() を呼ばなくても isConnected が即 true になる', async () => {
    // タブを戻して component が再 mount されたときの再現 (Refs ippoan/alc-app#219)
    coreState.isConnected.value = true
    const reader = await load()

    expect(reader.isConnected.value).toBe(true)
    expect(reader.readers.value).toEqual(['CoreS3'])
    expect(coreMock.connect).not.toHaveBeenCalled()
  })

  it('直結したらブリッジを切り、readers は CoreS3 になる', async () => {
    const reader = await load()
    reader.connect()
    wsState.error.value = 'NFC ブリッジとの接続でエラーが発生しました'
    wsState.bridgeVersion.value = '0.1.0'

    coreState.isConnected.value = true
    await nextTick()

    expect(wsMock.disconnect).toHaveBeenCalledTimes(1)
    expect(reader.isConnected.value).toBe(true)
    expect(reader.readers.value).toEqual(['CoreS3'])
    // 直結中はブリッジ側の状態を見せない
    expect(reader.error.value).toBeNull()
    expect(reader.bridgeVersion.value).toBeNull()
  })

  it('直結が切れたらブリッジへ戻す', async () => {
    const reader = await load()
    reader.connect()
    coreState.isConnected.value = true
    await nextTick()
    wsMock.connect.mockClear()

    coreState.isConnected.value = false
    await nextTick()

    expect(wsMock.connect).toHaveBeenCalledTimes(1)
  })

  it('connect() していなければ直結が切れてもブリッジへ戻さない', async () => {
    const reader = await load()
    coreState.isConnected.value = true
    await nextTick()
    coreState.isConnected.value = false
    await nextTick()

    expect(wsMock.connect).not.toHaveBeenCalled()
    expect(reader.isConnected.value).toBe(false)
  })

  it('直結していないあいだはブリッジの状態が透ける', async () => {
    const reader = await load()

    wsState.isConnected.value = true
    wsState.readers.value = ['ACS ACR122U']
    wsState.bridgeVersion.value = '0.3.1'
    wsState.error.value = null
    await nextTick()

    expect(reader.isConnected.value).toBe(true)
    expect(reader.readers.value).toEqual(['ACS ACR122U'])
    expect(reader.bridgeVersion.value).toBe('0.3.1')
  })

  it('disconnect(): ブリッジを切って未接続になり、以後は戻さない', async () => {
    const reader = await load()
    reader.connect()
    wsState.isConnected.value = true
    await nextTick()

    reader.disconnect()
    expect(wsMock.disconnect).toHaveBeenCalledTimes(1)
    expect(reader.isConnected.value).toBe(false)

    // CoreS3 のポートは BLE ゲートウェイと共有しているので手放さない
    expect(coreMock.disconnect).not.toHaveBeenCalled()

    wsMock.connect.mockClear()
    coreState.isConnected.value = true
    await nextTick()
    coreState.isConnected.value = false
    await nextTick()
    expect(wsMock.connect).not.toHaveBeenCalled()
  })
})
