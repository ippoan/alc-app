import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withSetup } from '../helpers/with-setup'

// Track all created MockWebSocket instances
let wsInstances: MockWebSocket[] = []

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = MockWebSocket.CONNECTING
  url: string
  onopen: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string) {
    this.url = url
    wsInstances.push(this)
    // Simulate async open
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN
      this.onopen?.(new Event('open'))
    }, 0)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }

  simulateMessage(data: string) {
    this.onmessage?.(new MessageEvent('message', { data }))
  }

  simulateError() {
    this.onerror?.(new Event('error'))
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }
}

function lastWs(): MockWebSocket {
  return wsInstances[wsInstances.length - 1]!
}

const envMock = vi.hoisted(() => ({
  isClient: true,
}))
vi.mock('~/utils/env', () => envMock)

describe('useNfcWebSocket', () => {
  let originalWebSocket: typeof WebSocket
  let useNfcWebSocket: typeof import('~/composables/useNfcWebSocket').useNfcWebSocket

  beforeEach(async () => {
    wsInstances = []
    originalWebSocket = globalThis.WebSocket
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.useFakeTimers()

    vi.resetModules()
    const mod = await import('~/composables/useNfcWebSocket')
    useNfcWebSocket = mod.useNfcWebSocket
  })

  afterEach(() => {
    vi.stubGlobal('WebSocket', originalWebSocket)
    vi.useRealTimers()
  })

  it('should start disconnected', () => {
    const { isConnected, error, readers, bridgeVersion } = useNfcWebSocket()
    expect(isConnected.value).toBe(false)
    expect(error.value).toBeNull()
    expect(readers.value).toEqual([])
    expect(bridgeVersion.value).toBeNull()
  })

  it('should use default URL', () => {
    const nfc = useNfcWebSocket()
    nfc.connect()
    expect(lastWs().url).toBe('ws://127.0.0.1:9876')
  })

  it('should use custom URL', () => {
    const nfc = useNfcWebSocket('ws://custom:1234')
    nfc.connect()
    expect(lastWs().url).toBe('ws://custom:1234')
  })

  it('should connect and set isConnected', async () => {
    const { isConnected, connect } = useNfcWebSocket()
    connect()
    await vi.advanceTimersByTimeAsync(10)
    expect(isConnected.value).toBe(true)
  })

  it('should reset error on connect', async () => {
    const nfc = useNfcWebSocket()
    nfc.connect()
    await vi.advanceTimersByTimeAsync(10)

    // Trigger error
    lastWs().simulateError()
    expect(nfc.error.value).toBeTruthy()

    // Disconnect then reconnect
    nfc.disconnect()
    nfc.connect()
    // error is cleared at start of connect()
    expect(nfc.error.value).toBeNull()
  })

  it('should prevent duplicate connections (OPEN state)', async () => {
    const nfc = useNfcWebSocket()
    nfc.connect()
    await vi.advanceTimersByTimeAsync(10)
    expect(wsInstances).toHaveLength(1)

    nfc.connect()
    expect(wsInstances).toHaveLength(1)
  })

  it('should prevent duplicate connections (CONNECTING state)', () => {
    const nfc = useNfcWebSocket()
    nfc.connect()
    expect(wsInstances).toHaveLength(1)

    nfc.connect()
    expect(wsInstances).toHaveLength(1)
  })

  it('should disconnect and clear state', async () => {
    const { isConnected, connect, disconnect } = useNfcWebSocket()
    connect()
    await vi.advanceTimersByTimeAsync(10)
    expect(isConnected.value).toBe(true)

    disconnect()
    expect(isConnected.value).toBe(false)
  })

  it('disconnect is safe when no ws exists', () => {
    const nfc = useNfcWebSocket()
    nfc.disconnect()
    expect(nfc.isConnected.value).toBe(false)
  })

  // --- Message handling ---

  describe('onmessage: nfc_read', () => {
    it('dispatches to onRead callbacks', async () => {
      const cb = vi.fn()
      const nfc = useNfcWebSocket()
      nfc.onRead(cb)
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)

      // ブリッジが source を名乗ってきても無視して 'bridge' を立てることまで見る
      lastWs().simulateMessage(JSON.stringify({ type: 'nfc_read', employee_id: 'EMP001', source: 'cores3' }))
      // **ブリッジ経路は必ず source: 'bridge'。** 打刻を打つ側かどうかがこれで決まる
      expect(cb).toHaveBeenCalledWith({ type: 'nfc_read', employee_id: 'EMP001', source: 'bridge' })
    })
  })

  describe('onmessage: nfc_license_read', () => {
    it('dispatches to licenseRead callbacks and readCallbacks with driver_license substring', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const licenseCb = vi.fn()
      const readCb = vi.fn()
      const nfc = useNfcWebSocket()
      nfc.onLicenseRead(licenseCb)
      nfc.onRead(readCb)
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)

      // card_id with 26+ chars, card_type=driver_license -> substring(10,26)
      const cardId = '0123456789ABCDEFGHIJKLMNOP' // length=26
      lastWs().simulateMessage(JSON.stringify({
        type: 'nfc_license_read',
        card_id: cardId,
        card_type: 'driver_license',
        atr: 'XX',
      }))

      expect(licenseCb).toHaveBeenCalledWith(expect.objectContaining({ type: 'nfc_license_read', card_id: cardId }))
      expect(readCb).toHaveBeenCalledWith({ type: 'nfc_read', employee_id: 'ABCDEFGHIJKLMNOP', source: 'bridge' })
      consoleSpy.mockRestore()
    })

    it('uses full card_id for non-driver_license cards', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const readCb = vi.fn()
      const nfc = useNfcWebSocket()
      nfc.onRead(readCb)
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)

      lastWs().simulateMessage(JSON.stringify({
        type: 'nfc_license_read',
        card_id: 'SHORT',
        card_type: 'other',
        atr: 'XX',
      }))

      expect(readCb).toHaveBeenCalledWith({ type: 'nfc_read', employee_id: 'SHORT', source: 'bridge' })
      consoleSpy.mockRestore()
    })

    it('uses full card_id for driver_license with short card_id (<26)', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const readCb = vi.fn()
      const nfc = useNfcWebSocket()
      nfc.onRead(readCb)
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)

      lastWs().simulateMessage(JSON.stringify({
        type: 'nfc_license_read',
        card_id: '0123456789',
        card_type: 'driver_license',
        atr: 'XX',
      }))

      expect(readCb).toHaveBeenCalledWith({ type: 'nfc_read', employee_id: '0123456789', source: 'bridge' })
      consoleSpy.mockRestore()
    })
  })

  describe('onmessage: nfc_debug', () => {
    it('logs debug message', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const nfc = useNfcWebSocket()
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)

      lastWs().simulateMessage(JSON.stringify({ type: 'nfc_debug', message: 'test debug' }))
      expect(consoleSpy).toHaveBeenCalledWith('[NFC]', 'test debug')
      consoleSpy.mockRestore()
    })
  })

  describe('onmessage: nfc_error', () => {
    it('dispatches to onError callbacks', async () => {
      const errCb = vi.fn()
      const nfc = useNfcWebSocket()
      nfc.onError(errCb)
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)

      lastWs().simulateMessage(JSON.stringify({ type: 'nfc_error', error: 'some_error' }))
      expect(errCb).toHaveBeenCalledWith({ type: 'nfc_error', error: 'some_error' })
    })

    it('clears readers on no_readers error', async () => {
      const nfc = useNfcWebSocket()
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)

      // First set readers via status
      lastWs().simulateMessage(JSON.stringify({ type: 'status', readers: ['Reader1'], connected: true }))
      expect(nfc.readers.value).toEqual(['Reader1'])

      // Then receive no_readers error
      lastWs().simulateMessage(JSON.stringify({ type: 'nfc_error', error: 'no_readers' }))
      expect(nfc.readers.value).toEqual([])
    })
  })

  describe('onmessage: status', () => {
    it('sets readers and bridgeVersion', async () => {
      const nfc = useNfcWebSocket()
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)

      lastWs().simulateMessage(JSON.stringify({
        type: 'status',
        readers: ['ACR122U'],
        connected: true,
        version: '1.2.3',
      }))

      expect(nfc.readers.value).toEqual(['ACR122U'])
      expect(nfc.bridgeVersion.value).toBe('1.2.3')
    })

    it('sets readers to empty and version to null when missing', async () => {
      const nfc = useNfcWebSocket()
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)

      lastWs().simulateMessage(JSON.stringify({ type: 'status', connected: true }))

      expect(nfc.readers.value).toEqual([])
      expect(nfc.bridgeVersion.value).toBeNull()
    })
  })

  describe('onmessage: non-JSON', () => {
    it('ignores non-JSON messages without error', async () => {
      const nfc = useNfcWebSocket()
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)

      lastWs().simulateMessage('not json at all')
      expect(nfc.isConnected.value).toBe(true)
    })
  })

  // --- Error handling ---

  describe('onerror', () => {
    it('sets error message', async () => {
      const nfc = useNfcWebSocket()
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)

      lastWs().simulateError()
      expect(nfc.error.value).toBe('NFC ブリッジとの接続でエラーが発生しました')
    })
  })

  // --- WebSocket constructor failure ---

  describe('WebSocket constructor throws', () => {
    it('sets error and schedules reconnect', async () => {
      let callCount = 0
      const ThrowOnceWs = function (url: string) {
        callCount++
        if (callCount === 1) throw new Error('connection refused')
        return new MockWebSocket(url)
      } as any
      ThrowOnceWs.CONNECTING = 0
      ThrowOnceWs.OPEN = 1
      ThrowOnceWs.CLOSING = 2
      ThrowOnceWs.CLOSED = 3

      vi.stubGlobal('WebSocket', ThrowOnceWs)

      const nfc = useNfcWebSocket()
      nfc.connect()

      expect(nfc.error.value).toBe('WebSocket 接続に失敗しました')

      // Should schedule reconnect
      await vi.advanceTimersByTimeAsync(3000)
      await vi.advanceTimersByTimeAsync(10)
      expect(nfc.isConnected.value).toBe(true)
    })
  })

  // --- Reconnect logic ---

  describe('reconnect', () => {
    it('reconnects on unintentional close', async () => {
      const nfc = useNfcWebSocket()
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)
      expect(nfc.isConnected.value).toBe(true)

      lastWs().simulateClose()
      expect(nfc.isConnected.value).toBe(false)
      expect(nfc.bridgeVersion.value).toBeNull()

      await vi.advanceTimersByTimeAsync(3000)
      await vi.advanceTimersByTimeAsync(10)
      expect(nfc.isConnected.value).toBe(true)
      expect(wsInstances).toHaveLength(2)
    })

    it('does not reconnect on intentional close (disconnect)', async () => {
      const nfc = useNfcWebSocket()
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)

      nfc.disconnect()
      await vi.advanceTimersByTimeAsync(5000)
      expect(wsInstances).toHaveLength(1)
    })

    it('stops reconnecting after MAX_RECONNECT_ATTEMPTS (10)', async () => {
      let count = 0
      // Plain object mock: only fires onclose, never onopen
      // (MockWebSocket auto-fires onopen which resets reconnectAttempts)
      const AlwaysFailWs = function (url: string) {
        count++
        const ws: any = {
          readyState: 0,
          url,
          onopen: null,
          onclose: null,
          onmessage: null,
          onerror: null,
          close() {
            this.readyState = 3
            this.onclose?.(new CloseEvent('close'))
          },
        }
        setTimeout(() => {
          ws.readyState = 3
          ws.onclose?.(new CloseEvent('close'))
        }, 1)
        return ws
      } as any
      AlwaysFailWs.CONNECTING = 0
      AlwaysFailWs.OPEN = 1
      AlwaysFailWs.CLOSING = 2
      AlwaysFailWs.CLOSED = 3

      vi.stubGlobal('WebSocket', AlwaysFailWs)

      const nfc = useNfcWebSocket()
      nfc.connect()

      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(3001)
      }

      await vi.advanceTimersByTimeAsync(3001)
      expect(nfc.error.value).toBe('NFC ブリッジに接続できません。rust-nfc-bridge が起動しているか確認してください')
    })

    it('resets reconnect attempts on successful connect', async () => {
      const nfc = useNfcWebSocket()
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)

      lastWs().simulateClose()
      await vi.advanceTimersByTimeAsync(3000)
      await vi.advanceTimersByTimeAsync(10)

      expect(nfc.isConnected.value).toBe(true)

      lastWs().simulateClose()
      await vi.advanceTimersByTimeAsync(3000)
      await vi.advanceTimersByTimeAsync(10)
      expect(nfc.isConnected.value).toBe(true)
    })
  })

  // --- Callback unregister ---

  describe('callback unregister', () => {
    it('onRead unregister removes callback', async () => {
      const cb = vi.fn()
      const nfc = useNfcWebSocket()
      const unsub = nfc.onRead(cb)
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)

      unsub()

      lastWs().simulateMessage(JSON.stringify({ type: 'nfc_read', employee_id: 'X' }))
      expect(cb).not.toHaveBeenCalled()
    })

    it('onRead unsubscribe called twice is safe (idx < 0)', () => {
      const cb = vi.fn()
      const nfc = useNfcWebSocket()
      const unsub = nfc.onRead(cb)
      unsub()
      unsub() // second call — idx is -1, splice should not run
    })

    it('onLicenseRead unregister removes callback', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const cb = vi.fn()
      const nfc = useNfcWebSocket()
      const unsub = nfc.onLicenseRead(cb)
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)

      unsub()

      lastWs().simulateMessage(JSON.stringify({
        type: 'nfc_license_read', card_id: 'X', card_type: 'other', atr: 'X',
      }))
      expect(cb).not.toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('onError unregister removes callback', async () => {
      const cb = vi.fn()
      const nfc = useNfcWebSocket()
      const unsub = nfc.onError(cb)
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)

      unsub()

      lastWs().simulateMessage(JSON.stringify({ type: 'nfc_error', error: 'test' }))
      expect(cb).not.toHaveBeenCalled()
    })

    it('onError unsubscribe called twice is safe (idx < 0)', () => {
      const cb = vi.fn()
      const nfc = useNfcWebSocket()
      const unsub = nfc.onError(cb)
      unsub()
      unsub() // second call — idx is -1
    })
  })

  // --- bridge-restarted event ---

  describe('bridge-restarted event', () => {
    it('reconnects on bridge-restarted event with nfc bridge', async () => {
      const nfc = useNfcWebSocket()
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)
      nfc.disconnect()

      window.dispatchEvent(new CustomEvent('bridge-restarted', { detail: { bridge: 'nfc' } }))

      await vi.advanceTimersByTimeAsync(10)
      expect(nfc.isConnected.value).toBe(true)
    })

    it('ignores bridge-restarted event for non-nfc bridge', async () => {
      const nfc = useNfcWebSocket()

      window.dispatchEvent(new CustomEvent('bridge-restarted', { detail: { bridge: 'serial' } }))

      await vi.advanceTimersByTimeAsync(10)
      expect(nfc.isConnected.value).toBe(false)
      expect(wsInstances).toHaveLength(0)
    })
  })

  // --- onUnmounted cleanup ---

  describe('onUnmounted', () => {
    it('disconnects and removes event listener on unmount', async () => {
      const removeListenerSpy = vi.spyOn(window, 'removeEventListener')

      const [nfc, app] = withSetup(() => useNfcWebSocket())
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)
      expect(nfc.isConnected.value).toBe(true)

      app.unmount()
      expect(nfc.isConnected.value).toBe(false)
      expect(removeListenerSpy).toHaveBeenCalledWith('bridge-restarted', expect.any(Function))
      removeListenerSpy.mockRestore()
    })
  })

  // --- SSR (isClient=false) ---

  describe('SSR (isClient=false)', () => {
    it('no event listener is registered when isClient=false', async () => {
      envMock.isClient = false
      vi.resetModules()
      const addSpy = vi.spyOn(window, 'addEventListener')

      const mod = await import('~/composables/useNfcWebSocket')
      const nfc = mod.useNfcWebSocket()

      const bridgeCalls = addSpy.mock.calls.filter(([name]) => name === 'bridge-restarted')
      expect(bridgeCalls).toHaveLength(0)

      addSpy.mockRestore()
      envMock.isClient = true
    })

    it('onUnmounted skips removeEventListener when isClient=false', async () => {
      envMock.isClient = false
      vi.resetModules()
      const mod = await import('~/composables/useNfcWebSocket')
      const removeSpy = vi.spyOn(window, 'removeEventListener')

      const [, app] = withSetup(() => mod.useNfcWebSocket())
      app.unmount()

      const bridgeCalls = removeSpy.mock.calls.filter(([name]) => name === 'bridge-restarted')
      expect(bridgeCalls).toHaveLength(0)

      removeSpy.mockRestore()
      envMock.isClient = true
    })
  })

  // --- onLicenseRead callback ---

  describe('onLicenseRead', () => {
    it('registers and fires license read callback', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const licenseCb = vi.fn()
      const nfc = useNfcWebSocket()
      nfc.onLicenseRead(licenseCb)
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)

      const msg = {
        type: 'nfc_license_read',
        card_id: '0123456789ABCDEFGHIJKLMNOP',
        card_type: 'driver_license',
        atr: 'XX',
        expiry_date: '2030-01-01',
      }
      lastWs().simulateMessage(JSON.stringify(msg))

      expect(licenseCb).toHaveBeenCalledWith(expect.objectContaining({
        type: 'nfc_license_read',
        card_id: '0123456789ABCDEFGHIJKLMNOP',
      }))
      consoleSpy.mockRestore()
    })

    it('unsubscribe removes the license read callback', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const licenseCb = vi.fn()
      const nfc = useNfcWebSocket()
      const unsub = nfc.onLicenseRead(licenseCb)
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)

      unsub()

      lastWs().simulateMessage(JSON.stringify({
        type: 'nfc_license_read',
        card_id: 'ABCD',
        card_type: 'other',
        atr: 'XX',
      }))

      expect(licenseCb).not.toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('unsubscribe called twice is safe (idx < 0)', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const licenseCb = vi.fn()
      const nfc = useNfcWebSocket()
      const unsub = nfc.onLicenseRead(licenseCb)
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)

      unsub()
      unsub() // second call — idx will be -1, splice should not be called

      lastWs().simulateMessage(JSON.stringify({
        type: 'nfc_license_read',
        card_id: 'X',
        card_type: 'other',
        atr: 'XX',
      }))

      expect(licenseCb).not.toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('multiple licenseRead callbacks all fire', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const cb1 = vi.fn()
      const cb2 = vi.fn()
      const nfc = useNfcWebSocket()
      nfc.onLicenseRead(cb1)
      nfc.onLicenseRead(cb2)
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)

      lastWs().simulateMessage(JSON.stringify({
        type: 'nfc_license_read',
        card_id: 'TESTCARD',
        card_type: 'other',
        atr: 'XX',
      }))

      expect(cb1).toHaveBeenCalled()
      expect(cb2).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })

  // --- bridge-restarted bridgeRestartHandler directly ---

  describe('bridge-restarted handler (import.meta.client branch)', () => {
    it('dispatching bridge-restarted with nfc resets reconnectAttempts and connects', async () => {
      const countBefore = wsInstances.length
      const nfc = useNfcWebSocket()
      // Do not call connect initially — ws is null
      expect(nfc.isConnected.value).toBe(false)

      window.dispatchEvent(new CustomEvent('bridge-restarted', { detail: { bridge: 'nfc' } }))

      await vi.advanceTimersByTimeAsync(10)
      expect(nfc.isConnected.value).toBe(true)
      // At least one new WebSocket created by this instance
      expect(wsInstances.length).toBeGreaterThan(countBefore)
    })

    it('bridge-restarted with null detail is ignored', async () => {
      const nfc = useNfcWebSocket()

      window.dispatchEvent(new CustomEvent('bridge-restarted', { detail: null }))

      await vi.advanceTimersByTimeAsync(10)
      expect(nfc.isConnected.value).toBe(false)
      expect(wsInstances).toHaveLength(0)
    })
  })

  // --- Multiple callbacks ---

  describe('multiple callbacks', () => {
    it('dispatches to all registered onRead callbacks', async () => {
      const cb1 = vi.fn()
      const cb2 = vi.fn()
      const nfc = useNfcWebSocket()
      nfc.onRead(cb1)
      nfc.onRead(cb2)
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)

      lastWs().simulateMessage(JSON.stringify({ type: 'nfc_read', employee_id: 'E1' }))
      expect(cb1).toHaveBeenCalled()
      expect(cb2).toHaveBeenCalled()
    })

    it('dispatches to all registered onError callbacks', async () => {
      const cb1 = vi.fn()
      const cb2 = vi.fn()
      const nfc = useNfcWebSocket()
      nfc.onError(cb1)
      nfc.onError(cb2)
      nfc.connect()
      await vi.advanceTimersByTimeAsync(10)

      lastWs().simulateMessage(JSON.stringify({ type: 'nfc_error', error: 'err' }))
      expect(cb1).toHaveBeenCalled()
      expect(cb2).toHaveBeenCalled()
    })
  })
})
