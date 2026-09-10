/**
 * WebSerial ポートの調停 (シングルトン)。
 *
 * 同じ VID/PID の別機種が同居する PC で「誰がどのポートを開くか」を 1 か所に集める。
 * CoreS3 (BLE ゲートウェイ / NFC) も警告デバイス (Atom VoiceS3R) も Espressif の
 * native USB (0x303A:0x1001) なので、USB 記述子では見分けられない。開いてから
 * `STATUS` を撃ち、返ってきた行を利用側に見せて「これは自分の機種だ」と名乗り出た
 * ところへ渡す。
 *
 * 探索者が複数居ると 8 秒のプローブ窓でポートを奪い合う (実機で再現)。だから探索は
 * この 1 本に集約し、利用側は `register` で述語とハンドラを預けるだけにする
 * (Refs ippoan/alc-app#182)。
 *
 * プロトコルの解釈は arbiter に持たせない。`claim` / `reject` を利用側から渡すので、
 * 機種が増えても arbiter は変わらない。
 *
 * 名乗り出なかったポートを永久除外にはしない — 60 秒おいて再訪する。一度
 * 「警告デバイスではない」と判定しただけで CoreS3 のポートに二度と触れなくなると、
 * 後から CoreS3 の利用側を足したときに動かなくなるため。
 *
 * ポートの列挙と許可は useSerialDeviceManager に任せる (navigator.serial を自前で
 * 叩かない)。
 *
 * 診断ログ (`[SERIAL]`、Refs ippoan/alc-app#197): scan の開始 / セッションを閉じた理由 /
 * 60 秒再訪は常時。候補ごとの claim・見送り・open 失敗は本番のノイズになるので
 * `localStorage.alc_debug_serial=1` の端末だけ。
 */

import { isWebSerialSupported } from '~/utils/webserial'
import { onPortConnected } from '~/composables/useSerialDeviceManager'

/**
 * BLE ゲートウェイの既知 VID:PID (CH340, CP210x, Espressif, FTDI FT232R)。
 *
 * 0x303A 以外の機種を見分けるための表。useFc1200Serial が候補からの除外に使う
 * (0x303A の調停はこのファイルの ARBITRATED_VID 側で行う)。
 */
export const BLE_GW_DEVICES = [
  { vid: 0x1A86 },            // CH340/CH552
  { vid: 0x10C4 },            // CP210x
  { vid: 0x303A },            // Espressif native USB
  { vid: 0x0403, pid: 0x6001 }, // FTDI FT232R (ATOM Lite)
]

/** 調停の対象にする VID。CoreS3 も VoiceS3R もこれで、記述子では見分けられない */
const ARBITRATED_VID = 0x303A

const SERIAL_OPTIONS: SerialOptions = {
  baudRate: 115200,
  dataBits: 8,
  parity: 'none' as ParityType,
  stopBits: 1,
  flowControl: 'none' as FlowControlType,
}

/** 見つからなければこの間隔で探し直す */
const RESCAN_INTERVAL = 10000
/**
 * `navigator.serial` の `connect` イベントを受けてから探索するまでの待ち時間。
 *
 * 挿した直後は CDC が準備中で `open` が失敗しうるので、10 秒周期より詰めつつも
 * 即座ではなく 1 秒だけ待つ。失敗しても既存の 10 秒周期に戻るだけなので固定値で足りる
 * (Refs ippoan/alc-app#221)。
 */
const CONNECT_SCAN_DELAY = 1000
const PROBE_SEND_INTERVAL = 1000
const PROBE_MAX_SENDS = 8
/**
 * これだけ待って誰も名乗り出なければ諦める。
 *
 * 3 秒では実機で「接続にならない」が出た。ポートを open した瞬間にデバイスが
 * リセットされると、その窓に応答が間に合わないため。8 秒あれば 5 秒ごとに無条件で
 * 出る警告デバイスの `EVT ALARM` バナーも拾える。
 */
const PROBE_TIMEOUT = 8000
/** 誰も名乗り出なかったポートを再訪するまでの間隔 (永久除外はしない) */
const PASS_OVER_COOLDOWN = 60000
/** これが '1' の端末だけ候補ごとの `[SERIAL]` ログを出す */
const DEBUG_KEY = 'alc_debug_serial'

/** page load からの経過 ms (診断ログ用。再接続に何秒かかったかを読むため) */
export function msSinceLoad(): number {
  return Math.round(performance.now())
}

function log(message: string): void {
  console.log(`[SERIAL] ${message} (+${msSinceLoad()}ms)`)
}

/** 候補ごとの行。`localStorage.alc_debug_serial=1` のときだけ出す */
function debug(message: string): void {
  if (localStorage.getItem(DEBUG_KEY) === '1') log(message)
}

/**
 * ポートを使う側。プロトコルの解釈はすべてこちら側の知識。
 *
 * `claim` / `reject` にはプローブ中に集まった行が**古い順に全部**渡る。判定は行の
 * 到着ごとにやり直されるので、実装は「この配列のどれかが自分の機種の応答か」を
 * 答えればよい。
 */
export interface SerialClaimant {
  /** 「これは自分の機種だ」なら true。最初に true を返した利用側がポートを取る */
  claim(lines: string[]): boolean
  /**
   * 「自分の機種ではない」と確定できるなら true。名乗り出ていない利用側が全員
   * これを返した時点でプローブを打ち切り、ポートを手放す。
   */
  reject(lines: string[]): boolean
  /** ポートを受け取る。`lines` はプローブ中に集まった行 (claim の判断に使ったもの) */
  onOpen(
    port: SerialPort,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    lines: string[],
  ): void
  /** 以後の受信行。arbiter は加工しない (JSON も EVT も生のまま) */
  onLine(line: string): void
  /** ポートを失った / 返した。利用側の state を畳む */
  onClose(): void
}

interface Owner {
  name: string
  claimant: SerialClaimant
}

interface PortSession {
  port: SerialPort
  reader: ReadableStreamDefaultReader<Uint8Array>
  writer: WritableStreamDefaultWriter<Uint8Array>
  /** プローブ中に集まった行。採用後の行は onLine へ流すのでここには積まない */
  lines: string[]
  buffer: string
  active: boolean
  owner: Owner | null
}

// シングルトン: 探索は PC ごとに 1 本。奪い合いを消すのがこの層の目的
const claimants = new Map<string, SerialClaimant>()
/** 利用側の名前 → 預けたポート */
const held = new Map<string, PortSession>()
/** arbiter が握っているポート (プローブ中のものも含む) */
const sessions = new Set<PortSession>()
/** 誰も名乗り出なかったポートと、その時刻 */
const passedOver = new Map<SerialPort, number>()
let scanning = false
let scanTimer: ReturnType<typeof setTimeout> | null = null
/** scan() 実行中に connect が来た → 終わったら CONNECT_SCAN_DELAY で次を予約する */
let rescanRequested = false
/** onPortConnected の購読は register() の初回だけ張る (module 単位で 1 本) */
let connectSubscribed = false

/**
 * `request()` が待っている応答 (session ごとに高々 1 件)。
 *
 * CoreS3 の自動端末登録 (#213) や後続の VoiceS3R 認証など、「1 行送って応答 1 つを
 * 待つ」型のやり取りに使う。既存の行配送 (`owner.claimant.onLine`) はそのまま動かし
 * 続け、これはそれに割り込んで見るだけ (二重配送だが、対象外の行は利用側で無視される)。
 */
interface PendingRequest {
  matchPrefix: string
  /** これで始まる行が来たら失敗として reject する (`ERR <送った行の先頭トークン>`) */
  errPrefix: string
  resolve: (line: string) => void
  reject: (err: Error) => void
}
const pendingRequests = new Map<PortSession, PendingRequest>()

/** いま arbiter が握っているポートか (他の探索者がこれを掴まないための口) */
export function isArbitratedPort(port: SerialPort): boolean {
  for (const s of sessions) {
    if (s.port === port) return true
  }
  return false
}

/** 行を 1 本書く。失敗を例外ではなく false で返す */
export async function writeLine(
  w: WritableStreamDefaultWriter<Uint8Array>,
  line: string,
): Promise<boolean> {
  try {
    await w.write(new TextEncoder().encode(line + '\n'))
    return true
  }
  catch {
    return false
  }
}

/**
 * ポートを閉じる。ESP32-S3 の USB-Serial-JTAG は「DTR=0 かつ RTS=1」で chip reset が
 * かかる (自動書き込み回路の模倣) ため、close の直前に DTR と RTS を落とす。
 * S3 にはこれを無効化するレジスタが無く、firmware 側では直せない。
 *
 * **順序が本体** — RTS を先に落とさないと「DTR=0 かつ RTS=1」の瞬間ができて reset する。
 * 1 回の `setSignals` に両方渡しても駄目で、OS/Chrome は DTR → RTS の順に個別に落とす
 * (Windows は `EscapeCommFunction(CLRDTR)` → `CLRRTS`) ため、DTR が落ちた時点で RTS が
 * まだ 1 のまま reset 条件を踏む。だから 2 回に分け、RTS → DTR の順で落とす
 * (Refs ippoan/alc-app#199)。
 *
 * 各 `setSignals` は個別に try/catch する。setSignals 非対応のポート (古い Chrome /
 * 一部ドライバ) で 1 つ目が throw しても、2 つ目と close は続ける。
 */
async function closePortQuietly(port: SerialPort): Promise<void> {
  try { await port.setSignals({ requestToSend: false }) } catch { /* 非対応でも次と close は続ける */ }
  try { await port.setSignals({ dataTerminalReady: false }) } catch { /* 非対応でも close は続ける */ }
  await port.close()
}

export function useSerialArbiter() {
  const { ports, refreshPorts, requestNewPort } = useSerialDeviceManager()

  const isSupported = isWebSerialSupported()

  // --- 探索の予約 ---

  function scheduleScan(delay: number): void {
    if (!isSupported) return
    if (scanTimer) clearTimeout(scanTimer)
    scanTimer = setTimeout(() => {
      scanTimer = null
      void scan()
    }, delay)
  }

  /**
   * `navigator.serial` の `connect` を受けたときの処理 (Refs ippoan/alc-app#221)。
   *
   * 見送り印を消す (挿し直した機種が直前に見送られたポートと同じかもしれないため —
   * `isRevisitable` の判定 `:397-404` と同じ引き方)。スキャン中に来たら取りこぼさず
   * 次の周期を早める (`rescanRequested`)、スキャン中でなければ `CONNECT_SCAN_DELAY` で
   * 即予約する。
   */
  function handlePortConnected(port: SerialPort): void {
    passedOver.delete(toRaw(port))
    if (scanning) {
      rescanRequested = true
      return
    }
    scheduleScan(CONNECT_SCAN_DELAY)
  }

  /** まだポートを預かっていない利用側 */
  function pending(): Array<[string, SerialClaimant]> {
    return [...claimants].filter(([name]) => !held.has(name))
  }

  // --- ストリーム ---

  async function closeSession(s: PortSession, reason: string): Promise<void> {
    // 待っている request() があれば、応答が来ないまま宙に浮かせず reject する
    // (reject 自体が pendingRequests から自分を消すので、ここでの delete は不要)
    const pendingRequest = pendingRequests.get(s)
    if (pendingRequest) pendingRequest.reject(new Error(`request: port closed (${reason})`))
    // 受信ループの finally が二重に release を呼ばないよう、先に持ち主を落とす
    const owner = s.owner
    s.owner = null
    s.active = false
    sessions.delete(s)
    log(`close ${owner ? `port of ${owner.name}` : 'probed port'}: ${reason}`)
    try { s.writer.releaseLock() } catch {}
    try { await s.reader.cancel() } catch {}
    try { s.reader.releaseLock() } catch {}
    try { await closePortQuietly(s.port) } catch {}
    if (owner) owner.claimant.onClose()
  }

  /** 開いたポートの受信ループ。プローブ中も採用後も同じループが回る */
  async function pump(s: PortSession, onLine: (line: string) => void): Promise<void> {
    const decoder = new TextDecoder()
    try {
      while (s.active) {
        const { value, done } = await s.reader.read()
        if (done) break
        if (!value) continue

        s.buffer += decoder.decode(value, { stream: true })

        let newlineIdx: number
        while ((newlineIdx = s.buffer.indexOf('\n')) !== -1) {
          const line = s.buffer.substring(0, newlineIdx).trim()
          s.buffer = s.buffer.substring(newlineIdx + 1)
          if (line) onLine(line)
        }
      }
    }
    catch {
      // close / 抜線による read の中断。後始末は下で行う
    }
    finally {
      s.active = false
      s.buffer = ''
      // 預けたあとに終わった = 抜線・クラッシュ → 返させて掴み直しへ
      if (s.owner) await release(s.owner.name)
    }
  }

  // --- 機種判定 ---

  function pickClaimant(lines: string[]): Owner | null {
    for (const [name, claimant] of pending()) {
      if (claimant.claim(lines)) return { name, claimant }
    }
    return null
  }

  function allRejected(lines: string[]): boolean {
    return pending().every(([, claimant]) => claimant.reject(lines))
  }

  function probe(s: PortSession): Promise<Owner | null> {
    return new Promise<Owner | null>((resolve) => {
      let settled = false
      let sends = 0
      let sendTimer: ReturnType<typeof setInterval> | null = null

      function stopSends(): void {
        if (sendTimer) {
          clearInterval(sendTimer)
          sendTimer = null
        }
      }

      function finish(owner: Owner | null): void {
        if (settled) return
        settled = true
        stopSends()
        clearTimeout(timeout)
        resolve(owner)
      }

      const timeout = setTimeout(() => finish(null), PROBE_TIMEOUT)

      void pump(s, (line) => {
        // 採用後は利用側へ生のまま流す
        if (s.owner) {
          // request() が待っていれば先に判定する (行の配送そのものは変えない。
          // resolve/reject 自体が pendingRequests から自分を消すので delete は不要)
          const pendingRequest = pendingRequests.get(s)
          if (pendingRequest) {
            if (line.startsWith(pendingRequest.matchPrefix)) pendingRequest.resolve(line)
            else if (line.startsWith(pendingRequest.errPrefix)) pendingRequest.reject(new Error(line))
          }
          s.owner.claimant.onLine(line)
          return
        }
        s.lines.push(line)
        // 判定は済んだが引き渡し前 — 同じチャンクの残りは lines に積むだけ
        if (settled) return

        const owner = pickClaimant(s.lines)
        if (owner) {
          finish(owner)
          return
        }
        if (allRejected(s.lines)) finish(null)
      })

      function sendStatus(): void {
        sends += 1
        void writeLine(s.writer, 'STATUS').then((ok) => {
          if (!ok) finish(null)
        })
        if (sends >= PROBE_MAX_SENDS) stopSends()
      }

      sendStatus()
      sendTimer = setInterval(sendStatus, PROBE_SEND_INTERVAL)
    })
  }

  /** 候補ポートを開いて機種を判定し、名乗り出た利用側へ預ける */
  async function tryPort(candidate: SerialPort): Promise<void> {
    try {
      await candidate.open(SERIAL_OPTIONS)
    }
    catch {
      // InvalidStateError = 他の探索者が使用中 → 印を残さず次の候補へ
      debug('open failed (in use by another explorer?) -> next candidate')
      return
    }

    if (!candidate.readable || !candidate.writable) {
      debug('no readable/writable stream -> close')
      try { await closePortQuietly(candidate) } catch {}
      return
    }

    const s: PortSession = {
      port: candidate,
      reader: candidate.readable.getReader(),
      writer: candidate.writable.getWriter(),
      lines: [],
      buffer: '',
      active: true,
      owner: null,
    }
    sessions.add(s)

    const owner = await probe(s)

    if (owner) {
      debug(`claimed by ${owner.name} (probe lines=${s.lines.length})`)
      s.owner = owner
      held.set(owner.name, s)
      owner.claimant.onOpen(s.port, s.reader, s.writer, s.lines)
      return
    }

    // 応答はあったが誰も名乗り出なかった → 60 秒おいて再訪する (永久除外にはしない)。
    // 無応答 (行が 1 つも来なかった) は印を残さない: open のリセットで返事が遅れた
    // だけかもしれないため
    if (s.lines.length > 0) {
      passedOver.set(candidate, Date.now())
      debug(`passed over (nobody claimed ${s.lines.length} lines) -> revisit in ${PASS_OVER_COOLDOWN / 1000}s`)
      await closeSession(s, 'passed over')
      return
    }
    debug('no response within probe window -> retry next scan')
    await closeSession(s, 'no response')
  }

  // --- 探索 ---

  function isRevisitable(port: SerialPort): boolean {
    const passedAt = passedOver.get(port)
    if (passedAt === undefined) return true
    if (Date.now() - passedAt < PASS_OVER_COOLDOWN) return false
    passedOver.delete(port)
    log('revisiting a passed-over port (cooldown elapsed)')
    return true
  }

  async function scan(): Promise<void> {
    if (scanning || pending().length === 0) return
    scanning = true
    try {
      await refreshPorts()
      const candidates = ports.value.filter(entry => entry.info.usbVendorId === ARBITRATED_VID).length
      log(`scan start: candidates=${candidates} pending=${pending().map(([name]) => name).join(',')}`)
      for (const entry of ports.value) {
        if (entry.info.usbVendorId !== ARBITRATED_VID) continue
        // ports は ref 越しなのでプロキシが刺さる。他の探索者
        // (useFc1200Serial) が navigator.serial から得るのは生のポートなので、
        // isArbitratedPort / passedOver の同一性が崩れないよう剥がしておく
        const candidate = toRaw(entry.port) as SerialPort
        if (isArbitratedPort(candidate)) continue
        if (!isRevisitable(candidate)) continue
        await tryPort(candidate)
        if (pending().length === 0) {
          rescanRequested = false
          return
        }
      }
    }
    finally {
      scanning = false
    }
    scheduleScan(rescanRequested ? CONNECT_SCAN_DELAY : RESCAN_INTERVAL)
    rescanRequested = false
  }

  // --- 公開 API ---

  /**
   * 利用側を登録する。新顔なら見送り印を捨てて即スキャンする — 10 秒周期を待つと、
   * 直前に見送られたばかりのポートがその利用側のものだったときに取りこぼす。
   */
  function register(name: string, claimant: SerialClaimant): void {
    if (!connectSubscribed) {
      connectSubscribed = true
      onPortConnected(handlePortConnected)
    }
    const isNew = !claimants.has(name)
    claimants.set(name, claimant)
    if (!isNew) return
    passedOver.clear()
    scheduleScan(0)
  }

  /** 登録を解く。預けていたポートは返してもらう (再スキャンはしない) */
  async function unregister(name: string): Promise<void> {
    claimants.delete(name)
    const s = held.get(name)
    if (s) {
      held.delete(name)
      await closeSession(s, `unregister(${name})`)
    }
    if (claimants.size === 0 && scanTimer) {
      clearTimeout(scanTimer)
      scanTimer = null
    }
  }

  /** 預かったポートを返す (抜線・書き込み失敗など) → 掴み直しへ */
  async function release(name: string): Promise<void> {
    const s = held.get(name)
    if (!s) return
    held.delete(name)
    await closeSession(s, `release(${name})`)
    scheduleScan(RESCAN_INTERVAL)
  }

  /**
   * 1 行送って、応答 1 つを待つ (CoreS3 の自動端末登録 #213 / 後続の VoiceS3R 認証で使用)。
   *
   * `line` を書き、その後に届く行のうち `matchPrefix` で始まる最初の行で resolve する。
   * `ERR <送った行の先頭トークン>` で始まる行が先に来たら、それを reject する (firmware が
   * コマンドを認識しつつ失敗を返したとき用)。先頭トークンだけを見るのは、`AUTH TICKET`
   * (`ERR AUTH TICKET: …`、送信行をまるごと echo) と `AUTH SIGN <nonce>`
   * (`ERR AUTH: no key` / `ERR AUTH: bad nonce`、nonce を echo しない) の両方を拾うため
   * (Refs ippoan/alc-app#214)。同時に待てる request は 1 本なので、他コマンドの ERR を
   * 誤って拾うことは無い。`timeoutMs` 経過しても届かなければ reject する。
   *
   * **同時に 1 件しか待てない。** 1 件目が待っている間に 2 件目を呼ぶと、2 件目は
   * 書かずに即 reject する (1 件目の完了 or タイムアウトまで待ってから呼び直すこと)。
   * `matchPrefix`/`errPrefix` のどちらにも当てはまらない行は横取りせず、判定だけして
   * そのまま `onLine` へ流す。**待っている間も `writeLine` 自体は塞がない**
   * (`useCoreS3Serial.write` の `HB` heartbeat 等、無関係な書き込みは通る)。
   */
  function request(name: string, line: string, matchPrefix: string, timeoutMs: number): Promise<string> {
    const held_ = held.get(name)
    if (!held_) return Promise.reject(new Error(`request(${name}): ポートを預かっていません`))
    if (pendingRequests.has(held_)) return Promise.reject(new Error(`request(${name}): 既に応答待ちです`))
    // ↑ の narrowing はネストした function 宣言 (下の doResolve/doReject) の中までは
    // 効かない (TS が閉包越しに const の絞り込みを保持しない) ので、常に非 undefined な
    // 別の const に積み直す
    const s: PortSession = held_

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        doReject(new Error(`request(${name}): timeout waiting for "${matchPrefix}"`))
      }, timeoutMs)

      // resolve/reject は必ずこの 2 つ経由で呼ぶ。Promise は 2 度目以降の settle が
      // 無害な no-op になる (ネイティブの仕様) ので、「まだ待っているか」を呼び出し側で
      // 確かめる防御コードを書かずに済む — 二重の delete/timer 解除も安全に重ねられる。
      function doResolve(l: string): void {
        clearTimeout(timer)
        pendingRequests.delete(s)
        resolve(l)
      }
      function doReject(e: Error): void {
        clearTimeout(timer)
        pendingRequests.delete(s)
        reject(e)
      }

      pendingRequests.set(s, { matchPrefix, errPrefix: `ERR ${line.split(' ')[0]}`, resolve: doResolve, reject: doReject })

      void writeLine(s.writer, line).then((ok) => {
        if (!ok) doReject(new Error(`request(${name}): write failed`))
      })
    })
  }

  return {
    isSupported,
    isArbitratedPort,
    register,
    unregister,
    release,
    request,
    /** `delay` ミリ秒後に探索を始める。以後は見つかるまで 10 秒ごと */
    start: scheduleScan,
    /** WebSerial の初回許可 (ユーザー操作が要る) */
    requestPort: requestNewPort,
  }
}
