// Windows GW (alc-gw) の疎通確認 (#124)。GW はローカル API
// (http://127.0.0.1:11984、CORS + Private Network Access 許可済み — alc-gw
// main.go の debug mux) と WS ブリッジ 3 本 (9876/9877/9878) を持つ。
// https ページから http://127.0.0.1 / ws://127.0.0.1 へのアクセスは
// loopback 例外で mixed content にならない (NFC ブリッジで実績あり)。

const GW_API_BASE = 'http://127.0.0.1:11984'
const NFC_WS_URL = 'ws://127.0.0.1:9876'
const BLE_WS_URL = 'ws://127.0.0.1:9877'
const FC1200_WS_URL = 'ws://127.0.0.1:9878'
const HUB_FETCH_TIMEOUT = 3000
const WS_PROBE_TIMEOUT = 3000

export interface GwBridgeProbe {
  ok: boolean
  detail: string | null
}

export function useGwStatus() {
  const checking = ref(false)
  // null = 未チェック / false = GW 未検出 (カード折りたたみ) / true = 稼働中
  const gwDetected = ref<boolean | null>(null)
  const coreS3Devices = ref<string[]>([])
  const nfcBridge = ref<GwBridgeProbe | null>(null)
  const bleBridge = ref<GwBridgeProbe | null>(null)
  const fc1200Bridge = ref<GwBridgeProbe | null>(null)
  const injecting = ref(false)
  const injectResult = ref<'success' | 'failure' | null>(null)

  /** GW 常駐アプリの到達性確認。到達不能なら null、稼働中なら CoreS3 デバイス名一覧 */
  async function fetchHubStatus(): Promise<string[] | null> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), HUB_FETCH_TIMEOUT)
    try {
      const res = await fetch(`${GW_API_BASE}/api/hub/status`, { signal: ctrl.signal })
      if (!res.ok) return null
      const data = await res.json() as { devices?: string[] }
      return data.devices ?? []
    }
    catch {
      return null
    }
    finally {
      clearTimeout(timer)
    }
  }

  /**
   * 使い捨て WebSocket でブリッジの疎通を確認する (useNfcWebSocket 等の
   * シングルトン状態を汚さない)。reduce が結果を返すまで受信メッセージを
   * 流し込み、タイムアウト / エラー / 切断で NG とする。
   */
  function probeBridge(
    url: string,
    reduce: (msg: Record<string, unknown>) => GwBridgeProbe | null,
  ): Promise<GwBridgeProbe> {
    return new Promise((resolve) => {
      let ws: WebSocket
      try {
        ws = new WebSocket(url)
      }
      catch {
        resolve({ ok: false, detail: null })
        return
      }
      let done = false
      const finish = (result: GwBridgeProbe) => {
        if (done) return
        done = true
        clearTimeout(timer)
        try { ws.close() } catch { /* closing 中でも結果は確定済み */ }
        resolve(result)
      }
      const timer = setTimeout(() => finish({ ok: false, detail: null }), WS_PROBE_TIMEOUT)
      ws.onmessage = (ev: MessageEvent) => {
        try {
          const result = reduce(JSON.parse(ev.data) as Record<string, unknown>)
          if (result) finish(result)
        }
        catch { /* 不正 JSON は無視して次を待つ */ }
      }
      ws.onerror = () => finish({ ok: false, detail: null })
      ws.onclose = () => finish({ ok: false, detail: null })
    })
  }

  /** NFC ブリッジ (9876): 接続直後の {type:"status",readers,version} を待つ */
  function probeNfcBridge(): Promise<GwBridgeProbe> {
    return probeBridge(NFC_WS_URL, (msg) => {
      if (msg.type !== 'status') return null
      const readers = Array.isArray(msg.readers) ? msg.readers as string[] : []
      const parts = [
        readers.length > 0 ? `readers: ${readers.join(', ')}` : 'リーダー 0 件',
        typeof msg.version === 'string' && msg.version ? `v${msg.version}` : null,
      ]
      return { ok: true, detail: parts.filter(Boolean).join(' / ') }
    })
  }

  /** 体温血圧ブリッジ (9877): ready で version、heartbeat の thermo/bp で確定 */
  function probeBleBridge(): Promise<GwBridgeProbe> {
    let version: string | null = null
    return probeBridge(BLE_WS_URL, (msg) => {
      if (msg.type === 'ready' && typeof msg.version === 'string') {
        version = msg.version
        return null // 接続直後は ready → heartbeat の順で届くので heartbeat も待つ
      }
      if (msg.type !== 'heartbeat') return null
      const parts = [
        `体温計 ${msg.thermo ? '○' : '×'} / 血圧計 ${msg.bp ? '○' : '×'}`,
        version ? `v${version}` : null,
      ]
      return { ok: true, detail: parts.filter(Boolean).join(' / ') }
    })
  }

  /** FC-1200 ブリッジ (9878): 接続直後の {type:"connected"} を待つ */
  function probeFc1200Bridge(): Promise<GwBridgeProbe> {
    return probeBridge(FC1200_WS_URL, (msg) => {
      return msg.type === 'connected' ? { ok: true, detail: null } : null
    })
  }

  /** GW 到達性 → 稼働中なら WS ブリッジ 3 本を並行確認 */
  async function checkAll(): Promise<void> {
    if (checking.value) return
    checking.value = true
    injectResult.value = null
    try {
      const devices = await fetchHubStatus()
      if (devices === null) {
        gwDetected.value = false
        coreS3Devices.value = []
        nfcBridge.value = null
        bleBridge.value = null
        fc1200Bridge.value = null
        return
      }
      gwDetected.value = true
      coreS3Devices.value = devices
      const [nfc, ble, fc] = await Promise.all([
        probeNfcBridge(),
        probeBleBridge(),
        probeFc1200Bridge(),
      ])
      nfcBridge.value = nfc
      bleBridge.value = ble
      fc1200Bridge.value = fc
    }
    finally {
      checking.value = false
    }
  }

  /** テスト注入: temperature を流して点呼フローまで届くかの E2E をワンタップ確認 */
  async function injectTemperature(value = 36.5): Promise<void> {
    if (injecting.value) return
    injecting.value = true
    injectResult.value = null
    try {
      const res = await fetch(`${GW_API_BASE}/api/hub/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          src: 'cores3',
          type: 'measurement',
          kind: 'temperature',
          payload: { type: 'temperature', value, unit: 'celsius' },
        }),
      })
      injectResult.value = res.ok ? 'success' : 'failure'
    }
    catch {
      injectResult.value = 'failure'
    }
    finally {
      injecting.value = false
    }
  }

  return {
    checking: readonly(checking),
    gwDetected: readonly(gwDetected),
    coreS3Devices: readonly(coreS3Devices),
    nfcBridge: readonly(nfcBridge),
    bleBridge: readonly(bleBridge),
    fc1200Bridge: readonly(fc1200Bridge),
    injecting: readonly(injecting),
    injectResult: readonly(injectResult),
    checkAll,
    injectTemperature,
  }
}
