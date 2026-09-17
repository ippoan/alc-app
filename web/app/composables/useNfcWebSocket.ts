import type { NfcWebSocketEvent, NfcReadEvent, NfcLicenseReadEvent, NfcErrorEvent } from '~/types'
import { isClient } from '~/utils/env'

const DEFAULT_URL = 'ws://127.0.0.1:9876'
const RECONNECT_DELAY_MS = 3000
const MAX_RECONNECT_ATTEMPTS = 10

export function useNfcWebSocket(url: string = DEFAULT_URL) {
  const isConnected = ref(false)
  const error = ref<string | null>(null)
  const readers = ref<string[]>([])
  const bridgeVersion = ref<string | null>(null)

  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempts = 0
  let intentionalClose = false

  const readCallbacks: Array<(event: NfcReadEvent) => void> = []
  const licenseReadCallbacks: Array<(event: NfcLicenseReadEvent) => void> = []
  const errorCallbacks: Array<(event: NfcErrorEvent) => void> = []

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    error.value = null
    intentionalClose = false

    try {
      ws = new WebSocket(url)
    }
    catch {
      error.value = 'WebSocket 接続に失敗しました'
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      isConnected.value = true
      error.value = null
      reconnectAttempts = 0
    }

    ws.onmessage = (event: MessageEvent) => {
      try {
        const data: NfcWebSocketEvent = JSON.parse(event.data)

        switch (data.type) {
          case 'nfc_read':
            // **source はここで立てる。** ブリッジから来た JSON に名乗らせない
            readCallbacks.forEach(cb => cb({ ...data, source: 'bridge' }))
            break
          case 'nfc_license_read':
            console.log('[NFC] License read:', data)
            // Fire license-specific callbacks first so expiry data is available
            licenseReadCallbacks.forEach(cb => cb(data))
            // 運転免許証: EF 2F01 hex から交付年月日+有効期限 (chars 10-25) を employee_id に使用
            // その他: card_id をそのまま使用
            {
              const employeeId = data.card_type === 'driver_license' && data.card_id.length >= 26
                ? data.card_id.substring(10, 26)
                : data.card_id
              readCallbacks.forEach(cb => cb({ type: 'nfc_read', employee_id: employeeId, source: 'bridge' }))
            }
            break
          case 'nfc_debug':
            console.log('[NFC]', data.message)
            break
          case 'nfc_error':
            if (data.error === 'no_readers') {
              readers.value = []
            }
            errorCallbacks.forEach(cb => cb(data))
            break
          case 'status':
            readers.value = data.readers ?? []
            bridgeVersion.value = data.version ?? null
            break
        }
      }
      catch {
        // Non-JSON messages are ignored
      }
    }

    ws.onclose = () => {
      isConnected.value = false
      bridgeVersion.value = null
      ws = null
      if (!intentionalClose) {
        scheduleReconnect()
      }
    }

    ws.onerror = () => {
      error.value = 'NFC ブリッジとの接続でエラーが発生しました'
    }
  }

  function disconnect() {
    intentionalClose = true
    clearReconnectTimer()
    if (ws) {
      ws.close()
      ws = null
    }
    isConnected.value = false
  }

  function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      error.value = 'NFC ブリッジに接続できません。rust-nfc-bridge が起動しているか確認してください'
      return
    }
    clearReconnectTimer()
    reconnectTimer = setTimeout(() => {
      reconnectAttempts++
      connect()
    }, RECONNECT_DELAY_MS)
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function onRead(callback: (event: NfcReadEvent) => void) {
    readCallbacks.push(callback)
    return () => {
      const idx = readCallbacks.indexOf(callback)
      if (idx >= 0) readCallbacks.splice(idx, 1)
    }
  }

  function onLicenseRead(callback: (event: NfcLicenseReadEvent) => void) {
    licenseReadCallbacks.push(callback)
    return () => {
      const idx = licenseReadCallbacks.indexOf(callback)
      if (idx >= 0) licenseReadCallbacks.splice(idx, 1)
    }
  }

  function onError(callback: (event: NfcErrorEvent) => void) {
    errorCallbacks.push(callback)
    return () => {
      const idx = errorCallbacks.indexOf(callback)
      if (idx >= 0) errorCallbacks.splice(idx, 1)
    }
  }

  // Android ブリッジ再起動時の自動再接続
  const bridgeRestartHandler = (e: Event) => {
    const detail = (e as CustomEvent).detail
    if (detail?.bridge === 'nfc') {
      reconnectAttempts = 0
      connect()
    }
  }
  if (isClient) {
    window.addEventListener('bridge-restarted', bridgeRestartHandler)
  }

  onUnmounted(() => {
    disconnect()
    if (isClient) {
      window.removeEventListener('bridge-restarted', bridgeRestartHandler)
    }
  })

  return {
    isConnected: readonly(isConnected),
    error: readonly(error),
    readers: readonly(readers),
    bridgeVersion: readonly(bridgeVersion),
    connect,
    disconnect,
    onRead,
    onLicenseRead,
    onError,
  }
}
