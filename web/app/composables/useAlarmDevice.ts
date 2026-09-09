/**
 * 据置警告デバイス (Atom VoiceS3R / USB CDC) との接続と heartbeat 送信。
 *
 * ブラウザは「鳴れ」と命令しない。3 秒ごとにキオスクの正常/異常を 1 行送るだけで、
 * デバイスは heartbeat が途切れたら自分の判断で鳴る。タブを閉じた・クラッシュした・
 * PC がフリーズした、のいずれも「無音」という同じ形で拾えるようにするため。
 *
 * プロトコル (firmware と同文。行指向 \n / ASCII / 115200 8N1):
 *   host → dev  `HB OK` / `HB NG <reason>`  … 3 秒ごと。デバイスは返信しない
 *   host → dev  `STATUS`                    … 機種判定のためのプローブ
 *   dev  → host `STATUS alarm state=<idle|alarming|muted> cause=<none|silence|ng:<reason>|call> hb_age_ms=<n|-> VER=<ver>`
 *   dev  → host `EVT ALARM state=<...> cause=<...>` … 状態遷移のたび + 5 秒ごと無条件
 * 末尾トークン ` call=1`/` call=0` は任意。今回は付けない (= call=0)。
 *
 * 機種識別を USB 記述子では行えない: CoreS3 の BLE ゲートウェイも VoiceS3R も
 * VID 0x303A / PID 0x1001 で同一。`STATUS` への応答の先頭 2 トークンで見分ける。
 */

/** デバイスが報告する鳴動状態 */
export interface AlarmDeviceState {
  state: 'idle' | 'alarming' | 'muted'
  cause: string
}

/** キオスク側の健全性。警告デバイスへ送る heartbeat の中身になる */
export interface KioskHealth {
  /**
   * FC-1200 が「同一ページ内の WebSerial」で繋がっているか。
   * null = このページは FC-1200 を使っていない (→ OK 扱い)。
   *
   * `useGwStatus.fc1200Bridge` (GW 常駐アプリへの probe) とは対象が違う。
   * あちらは別プロセスのブリッジの生死、こちらは同一ページ内の WebSerial 接続状態。
   */
  fc1200: boolean | null
}

/** 測定を担う component だけが書き込む。composable 内で書くと last-writer-wins で誤 NG が出る */
export function useKioskHealth() {
  return useState<KioskHealth>('kiosk-health', () => ({ fc1200: null }))
}

const ALARM_DEVICE_VID = 0x303A

const SERIAL_OPTIONS: SerialOptions = {
  baudRate: 115200,
  dataBits: 8,
  parity: 'none' as ParityType,
  stopBits: 1,
  flowControl: 'none' as FlowControlType,
}

/** mount 直後は BLE ゲートウェイに先にポートを選ばせる */
const INITIAL_SCAN_DELAY = 5000
/** 見つからなければこの間隔で探し直す */
const RESCAN_INTERVAL = 10000
const HEARTBEAT_INTERVAL = 3000
const PROBE_SEND_INTERVAL = 1000
const PROBE_MAX_SENDS = 3
/** これだけ待って何も来なければ「無応答」— 除外はしない */
const PROBE_TIMEOUT = 3000

/** 機種判定の結果。null = 無応答 */
type Verdict = 'alarm' | 'other' | null

// シングルトン: キオスク画面と設定画面で共有
const isConnected = ref(false)
const deviceState = ref<AlarmDeviceState | null>(null)

let port: SerialPort | null = null
let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
let lineBuffer = ''
let readLoopActive = false
let scanning = false
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let scanTimer: ReturnType<typeof setTimeout> | null = null

/** 別機種 (CoreS3 等) と確定したポート — 以後スキャンしない */
const excludedPorts = new Set<SerialPort>()

export function useAlarmDevice() {
  // ポートの列挙と許可は既存のマネージャに任せる (navigator.serial を自前で叩かない)
  const { ports, refreshPorts, requestNewPort } = useSerialDeviceManager()
  const health = useKioskHealth()

  const isSupported = typeof navigator !== 'undefined' && 'serial' in navigator

  // --- 行の解釈 ---

  function classify(line: string): 'alarm' | 'other' | 'unknown' {
    if (line.startsWith('STATUS alarm') || line.startsWith('EVT ALARM')) return 'alarm'
    // `STATUS LAN=...` (CoreS3) / `PONG` / JSON — 警告デバイスではないと確定できる行
    if (line.startsWith('STATUS ') || line.startsWith('PONG') || line.startsWith('{')) return 'other'
    // `EVT BOOT ...` 等は無視 (判定材料にしない)
    return 'unknown'
  }

  /** `state=` / `cause=` を拾って deviceState に畳む */
  function applyLine(line: string): void {
    let state: AlarmDeviceState['state'] | null = null
    let cause = 'none'
    for (const token of line.split(' ')) {
      if (token.startsWith('state=')) state = token.slice(6) as AlarmDeviceState['state']
      else if (token.startsWith('cause=')) cause = token.slice(6)
    }
    if (state) deviceState.value = { state, cause }
  }

  // --- ストリーム ---

  async function release(
    p: SerialPort | null,
    r: ReadableStreamDefaultReader<Uint8Array> | null,
    w: WritableStreamDefaultWriter<Uint8Array> | null,
  ): Promise<void> {
    if (w) {
      try { w.releaseLock() } catch {}
    }
    if (r) {
      try { await r.cancel() } catch {}
      try { r.releaseLock() } catch {}
    }
    if (p) {
      try { await p.close() } catch {}
    }
  }

  async function writeLine(w: WritableStreamDefaultWriter<Uint8Array>, line: string): Promise<boolean> {
    try {
      await w.write(new TextEncoder().encode(line + '\n'))
      return true
    }
    catch {
      return false
    }
  }

  /** 開いたポートの受信ループ。プローブ中も接続確立後も同じループが回る */
  async function pump(
    r: ReadableStreamDefaultReader<Uint8Array>,
    onLine: (line: string) => void,
  ): Promise<void> {
    const decoder = new TextDecoder()
    try {
      while (readLoopActive) {
        const { value, done } = await r.read()
        if (done) break
        if (!value) continue

        lineBuffer += decoder.decode(value, { stream: true })

        let newlineIdx: number
        while ((newlineIdx = lineBuffer.indexOf('\n')) !== -1) {
          const line = lineBuffer.substring(0, newlineIdx).trim()
          lineBuffer = lineBuffer.substring(newlineIdx + 1)
          if (line) onLine(line)
        }
      }
    }
    catch {
      // close / 抜線による read の中断。後始末は下で行う
    }
    finally {
      readLoopActive = false
      lineBuffer = ''
      // 確立済みだったのに終わった = 抜線・クラッシュ → 掴み直しへ
      if (isConnected.value) await handleLost()
    }
  }

  // --- 機種判定 ---

  function probe(
    r: ReadableStreamDefaultReader<Uint8Array>,
    w: WritableStreamDefaultWriter<Uint8Array>,
  ): Promise<Verdict> {
    return new Promise<Verdict>((resolve) => {
      let settled = false
      let sends = 0
      let sendTimer: ReturnType<typeof setInterval> | null = null

      function stopSends(): void {
        if (sendTimer) {
          clearInterval(sendTimer)
          sendTimer = null
        }
      }

      function finish(verdict: Verdict): void {
        if (settled) return
        settled = true
        stopSends()
        clearTimeout(timeout)
        resolve(verdict)
      }

      const timeout = setTimeout(() => finish(null), PROBE_TIMEOUT)

      readLoopActive = true
      void pump(r, (line) => {
        const kind = classify(line)
        if (kind === 'alarm') {
          applyLine(line)
          finish('alarm')
        }
        else if (kind === 'other') {
          finish('other')
        }
      })

      function sendStatus(): void {
        sends += 1
        void writeLine(w, 'STATUS').then((ok) => {
          if (!ok) finish(null)
        })
        if (sends >= PROBE_MAX_SENDS) stopSends()
      }

      sendStatus()
      sendTimer = setInterval(sendStatus, PROBE_SEND_INTERVAL)
    })
  }

  /** 候補ポートを開いて機種を判定し、警告デバイスなら接続を確立する */
  async function tryPort(candidate: SerialPort): Promise<boolean> {
    try {
      await candidate.open(SERIAL_OPTIONS)
    }
    catch {
      // InvalidStateError = 他の composable が使用中 → 除外せず次の候補へ
      return false
    }

    if (!candidate.readable || !candidate.writable) {
      await release(candidate, null, null)
      return false
    }

    const r = candidate.readable.getReader()
    const w = candidate.writable.getWriter()

    const verdict = await probe(r, w)

    if (verdict === 'alarm') {
      port = candidate
      reader = r
      writer = w
      isConnected.value = true
      startHeartbeat(w)
      return true
    }

    if (verdict === 'other') {
      // CoreS3 等と確定 — 二度と触らない
      excludedPorts.add(candidate)
    }
    // 無応答 (null) は除外しない: open のリセットで返事が遅れただけかもしれない
    readLoopActive = false
    await release(candidate, r, w)
    return false
  }

  // --- 探索 ---

  function scheduleScan(delay: number): void {
    if (scanTimer) clearTimeout(scanTimer)
    scanTimer = setTimeout(() => {
      scanTimer = null
      void scan()
    }, delay)
  }

  async function scan(): Promise<void> {
    if (isConnected.value || scanning) return
    scanning = true
    try {
      await refreshPorts()
      for (const entry of ports.value) {
        if (entry.info.usbVendorId !== ALARM_DEVICE_VID) continue
        const candidate = entry.port as SerialPort
        if (excludedPorts.has(candidate)) continue
        if (await tryPort(candidate)) return
      }
    }
    finally {
      scanning = false
    }
    scheduleScan(RESCAN_INTERVAL)
  }

  // --- heartbeat ---

  function startHeartbeat(w: WritableStreamDefaultWriter<Uint8Array>): void {
    stopHeartbeat()
    void sendHeartbeat(w)
    heartbeatTimer = setInterval(() => { void sendHeartbeat(w) }, HEARTBEAT_INTERVAL)
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  async function sendHeartbeat(w: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
    const ok = await writeLine(w, health.value.fc1200 === false ? 'HB NG fc1200' : 'HB OK')
    if (!ok) await handleLost()
  }

  /** 確立済みの接続が失われた (write 失敗 / 受信ループ終了) → 後始末して再スキャンへ */
  async function handleLost(): Promise<void> {
    await cleanup()
    scheduleScan(RESCAN_INTERVAL)
  }

  async function cleanup(): Promise<void> {
    // 受信ループの finally が二重に handleLost を呼ばないよう、先に落とす
    isConnected.value = false
    deviceState.value = null
    readLoopActive = false
    stopHeartbeat()
    await release(port, reader, writer)
    port = null
    reader = null
    writer = null
    lineBuffer = ''
  }

  // --- 公開 API ---

  /** mount から 5 秒待って探索を始める。以後 10 秒ごとに再スキャン */
  function connect(): void {
    if (!isSupported) return
    scheduleScan(INITIAL_SCAN_DELAY)
  }

  /** WebSerial の初回許可 (ユーザー操作が要る) → 許可されたら探索を始める */
  async function requestPort(): Promise<void> {
    const granted = await requestNewPort()
    if (granted) connect()
  }

  async function disconnect(): Promise<void> {
    if (scanTimer) {
      clearTimeout(scanTimer)
      scanTimer = null
    }
    await cleanup()
  }

  return {
    isSupported,
    isConnected: readonly(isConnected),
    deviceState: readonly(deviceState),
    connect,
    disconnect,
    requestPort,
  }
}
