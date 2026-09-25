/**
 * WebSerial ポートの調停 (シングルトン)。
 *
 * 同じ VID/PID の別機種が同居する PC で「誰がどのポートを開くか」を 1 か所に集める。
 * CoreS3 (BLE ゲートウェイ / NFC) も警告デバイス (Atom VoiceS3R) も測定台 (Atom S3)
 * も Espressif の native USB (0x303A:0x1001) なので、USB 記述子では見分けられない。
 * 開いてから `DEVICE` を撃ち、返ってきた `DEVICE <kind> ...` の `kind` で
 * 「これは自分の機種だ」と名乗り出たところへポートを渡す。
 *
 * `DEVICE` は機種の名乗り専用のコマンドで、全機種が同じ場所 (`alc_hub_drivers::
 * console::handle_common`) で共通に答える (Refs ippoan/alc-app#353)。`kind` は
 * 各機種で一意 (`cores3` / `alarm` / `bp-station` 等) なので、`kind` が判明した時点で
 * 「これは自分だ」か「これは自分ではない」かのどちらかに確定する — 機種が増えても
 * この 1 本 (arbiter) が `kind` で振り分けるだけで済み、利用側は `register(kind,
 * claimant)` でハンドラを預けるだけになる (Refs ippoan/alc-app#182)。
 *
 * `DEVICE` に答えない配備済みファーム (CoreS3 は本番稼働中) のために、`STATUS` も
 * 撃つ。`DEVICE` を返さない機だけ `legacyClaim` (`SerialClaimant` の任意メソッド) で
 * 旧い名乗り (`STATUS ... BOARD=cores3` 等) を見る後方互換の抜け道を用意している
 * (Refs ippoan/alc-app#353)。全台に `DEVICE`対応 の OTA が行き渡ったら `STATUS` の
 * 送信と `legacyClaim` は撤去できる。
 *
 * 探索者が複数居ると 8 秒のプローブ窓でポートを奪い合う (実機で再現)。だから探索は
 * この 1 本に集約する。
 *
 * 名乗り出なかったポートを永久除外にはしない — 60 秒おいて再訪する。一度
 * 「警告デバイスではない」と判定しただけで CoreS3 のポートに二度と触れなくなると、
 * 後から CoreS3 の利用側を足したときに動かなくなるため。
 *
 * ポートの列挙と許可は useSerialDeviceManager に任せる (navigator.serial を自前で
 * 叩かない)。
 *
 * 診断ログ (`[SERIAL]`、Refs ippoan/alc-app#197): scan の開始 / セッションを閉じた理由 /
 * 60 秒再訪 / connect イベント / close 失敗はコンソールに常時。候補ごとの claim・見送り・
 * open 失敗は本番のノイズになるので、コンソールへは `localStorage.alc_debug_serial=1` の
 * 端末だけ。どちらも診断ログの置き場 (utils/serialDiagLog) へは常に貯め、遠隔からは
 * CoreS3 の `get_log` 経由で読む (Refs ippoan/alc-app#223)。
 */

import { isWebSerialSupported } from '~/utils/webserial'
import { appendDiag } from '~/utils/serialDiagLog'
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

/**
 * 血圧測定台 (ATOM S3) が名乗る kind (`DEVICE bp-station`)。
 *
 * **語彙の正本はここ 1 か所** — `useAtomS3Serial` が arbiter へ登録する名前
 * (`CLAIMANT_NAME`) も、下の {@link arbitratedDeviceKind} が「測定台か否か」を分ける
 * 境目も同じ文字列なので、2 か所に書くと**片方だけ直す事故**になる
 * (Refs ippoan/alc-app#368)。auth-worker の `DEVICE_KINDS` の key に揃えた語彙。
 */
export const BP_STATION_DEVICE_KIND = 'bp-station'

/**
 * Vein Station (指静脈読み取り端末、Atom VoiceS3R の `vein` build) が名乗る kind
 * (`DEVICE timecard`、Refs ippoan/vein-match#20)。alc-app-s3
 * `crates/hub-core/src/protocol.rs` の `HostKind::Timecard` と同じ語彙 — NFC タイムカード
 * 端末と同一の kind で名乗る (指静脈は timecard 端末に `--features vein` を足した build)。
 * `useVeinSerial` が arbiter へ登録する名前もここから引く (2 か所に書く事故を避ける、
 * `BP_STATION_DEVICE_KIND` と同じ理由)。
 */
export const TIMECARD_DEVICE_KIND = 'timecard'

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
 * リセットされると、その窓に応答が間に合わないため。`DEVICE` は
 * `PROBE_SEND_INTERVAL` (1 秒) ごとに `PROBE_MAX_SENDS` (8 回) まで撃ち直すので、
 * 1 回書き損じても後続の送信で拾える余裕を持たせている。
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

function print(message: string): void {
  console.log(`[SERIAL] ${message} (+${msSinceLoad()}ms)`)
}

/** 常時の行。コンソールと診断ログの置き場の両方へ */
function log(message: string): void {
  appendDiag(message)
  print(message)
}

/**
 * 候補ごとの行。置き場へは常に貯め、コンソールへは `localStorage.alc_debug_serial=1`
 * のときだけ出す (Refs ippoan/alc-app#223)
 */
function debug(message: string): void {
  appendDiag(message)
  if (localStorage.getItem(DEBUG_KEY) === '1') print(message)
}

/** 例外の名前だけ (message は環境ごとの文言が入りうるので記録しない) */
function errorName(e: unknown): string {
  return e instanceof Error ? e.name : 'unknown'
}

/**
 * ポートを使う側。機種識別 (`DEVICE <kind>` の kind 一致) は arbiter が行うので、
 * ここは「預かったポートの使い方」だけを持つ。`register(kind, claimant)` の
 * `kind` がそのまま識別子になる。
 */
export interface SerialClaimant {
  /**
   * 後方互換用 (任意)。`DEVICE <kind>` の行が 1 本も無い場合だけ呼ばれる —
   * 配備済みでまだ `DEVICE` に対応していないファームの旧い名乗り
   * (`STATUS ... BOARD=cores3` 等) を見て「これは自分だ」と判定したい機種だけ実装する。
   * `DEVICE` に対応済みの機種は実装不要
   */
  legacyClaim?(lines: string[]): boolean
  /** ポートを受け取る。`lines` はプローブ中に集まった行 (`DEVICE ...` を含む) */
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
 * 名乗りで決着した機種の種別 (Refs ippoan/alc-app#368)。
 *
 * - `'bp-station'` … 血圧測定台の ATOM S3 が名乗った
 * - `'other'` … 名乗ったのは測定台以外 (CoreS3・警告デバイス等)
 *
 * **`null` (未確定) は別の状態**で、この union には入れない ({@link arbitratedDeviceKind})。
 */
export type ArbitratedDeviceKind = 'bp-station' | 'other'

/** `DEVICE bp-station` を名乗ったポートが在ったか */
const sawBpStationKind = ref(false)
/** `bp-station` 以外の機種 (`cores3` 等) を名乗ったポートが在ったか */
const sawOtherDeviceKind = ref(false)

/**
 * **名乗りで決着した機種** — 「この PC は測定台か」を URL ではなく端末の名乗りで
 * 決めるための口 (Refs ippoan/alc-app#368)。
 *
 * # なぜ arbiter が持つのか
 *
 * 端末は自分で名乗っている (`DEVICE bp-station VER=…`)。その名乗りを読んで持ち主を
 * 決めているのは既にここ (`resolveDevice`) だけなのに、`deviceKind()` も
 * `resolveDevice()` も内部関数で**外から機種を知る口が無かった**。だから利用側は
 * `?station=bp` のような URL クエリで人にもう一度書かせていた。ここが発生源。
 *
 * # 3 値であること (真偽 2 値にしない)
 *
 * `null` は**まだ決着していない** (probe 中・候補ポートが 1 つも無い) の意味で、
 * 「測定台ではない」ではない。probe は `PROBE_SEND_INTERVAL` ごとに
 * `PROBE_MAX_SENDS` 回まで撃ち `PROBE_TIMEOUT` で打ち切るので、**起動直後は必ず
 * ここを通る**。真偽 2 値にすると probe する前にキオスク扱いへ倒れ、測定台の鍵を
 * 使うべき画面がキオスクの鍵 (または無認証 fetch) へ落ちる。`useSignedBpBond` の
 * `hasProbedBpBond` や `useBloodPressureSetting` の `BpUiState::checking` と同じ流儀。
 *
 * # 両方繋がっている PC は CoreS3 優先
 *
 * 1 台の PC に CoreS3 と測定台の ATOM S3 が両方挿さっていたら `'other'` (= キオスク)
 * に倒す。`useNfcReader` が直結を CoreS3 優先で束ねているのと同じ向きに揃える
 * (**測定台に CoreS3 は挿さらない**のが前提なので、CoreS3 が居る PC はキオスク)。
 * 一度 `'other'` になったら `'bp-station'` へは戻らない。
 *
 * # 名乗りは claimant の登録と無関係に控える
 *
 * `claimants` に居ない機種 (誰も預からず見送ったポート) の名乗りも控える。測定台の
 * ATOM S3 を実際に預かるのは `useBpStationDeviceToken` が `atom.connect()` を呼んで
 * からで、**その判断材料がこの値**という順序になるため。
 */
const arbitratedDeviceKind = computed<ArbitratedDeviceKind | null>(() =>
  sawOtherDeviceKind.value
    ? 'other'
    : sawBpStationKind.value ? BP_STATION_DEVICE_KIND : null,
)

/**
 * 名乗った機種を控える — {@link arbitratedDeviceKind} の唯一の書き手。
 * `DEVICE <kind>` を読んだ時点と、`legacyClaim` で決着した時点で呼ぶ。
 */
function noteDeviceKind(kind: string): void {
  if (kind === BP_STATION_DEVICE_KIND) sawBpStationKind.value = true
  else sawOtherDeviceKind.value = true
}

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

/**
 * unload の後始末を 1 回だけ走らせるための印。
 * `pagehide` と `beforeunload` は**両方**発火する (app.vue は既に両方張っている)。
 */
let unloadClosed = false

/**
 * ページを閉じる / 読み込み直すときに、arbiter が握っているポートを
 * **`closePortQuietly` と同じ順序 (RTS → DTR) で**閉じる
 * (Refs ippoan/rust-alc-api#644)。
 *
 * # なぜ要るか
 *
 * ESP32-S3 の USB-Serial-JTAG は「DTR=0 かつ RTS=1」で chip reset がかかる
 * (`closePortQuietly` の doc、Refs ippoan/alc-app#199)。**リロード時の close は
 * ブラウザ任せ**でこの順序を守らないため、**ページを読み込み直すたびに CoreS3 が
 * 再起動する** — 実機で画面の点滅を目視、`boot_history` が 8/8 `reset=usb`。
 * 再起動すると WS が切れ、NFC が初期化し直され、時計も引き直される。
 *
 * つまり `#199` の対策は既に在るのに、**一番起きる場面 (リロード) だけ
 * その経路を通っていなかった**。
 *
 * # 何を閉じ、何を閉じないか
 *
 * `sessions` は arbiter が握っているポートだけ = **VID 0x303A (ESP32-S3)**。
 * CoreS3 も警告デバイス (Atom VoiceS3R) も同じ経路で、**どちらも同じ reset 条件を
 * 持つ**ので両方まとめて落として構わない。FC-1200 (アルコール検知器) は
 * `useFc1200Serial` が `!isArbitratedPort(p)` で別に開いており `sessions` に
 * 入らないので触らない。
 *
 * # 待てないことを前提にする
 *
 * `pagehide` は非同期の完了を保証しない。**間に合わなくてもページを壊さない**
 * ことだけを守る (close の失敗は握り潰す — ページはどのみち消える)。
 * 間に合えば `setSignals` が 2 本先に出るので reset の条件を踏まない。
 *
 * # `persisted` (bfcache) では閉じない
 *
 * `pagehide` は**ページが bfcache へ入るときにも発火する** (`event.persisted === true`)。
 * そのときページは**消えず、`pageshow` でそのまま戻ってくる** — module の状態も
 * 生きたままなので、ここで閉じると `sessions` が「開いている」と思ったまま残り、
 * **再スキャンが走らず CoreS3 も VoiceS3R も繋がらない**。
 * 利用者から見ると**「かざしても何も起きない」= NFC が無言で死ぬ**。
 * いま直そうとしている再起動より重い壊れ方なので、その場合は何もしない。
 *
 * **`pageshow` で戻す処理は要らない。** bfcache のときはそもそも閉じず
 * `unloadClosed` も立てないので、戻す状態が無い。`persisted === false` の
 * `pagehide` はページが捨てられる側で、戻ってこない。Chrome のメモリセーバーが
 * タブを破棄した場合は復帰が**完全な再読み込み**になり module 状態も作り直される。
 *
 * `beforeunload` は bfcache へ入るときには発火しないので、引数なしでよい。
 */
export function closeArbitratedPortsForUnload(options?: { persisted?: boolean }): void {
  // **`unloadClosed` を立てる前に返すこと** — 立ててしまうと、bfcache から戻った後の
  // 本当の unload で閉じられなくなる
  if (options?.persisted) return
  if (unloadClosed) return
  unloadClosed = true
  for (const s of sessions) {
    // 受信ループを止める (pump の while が次の read を待たない)
    s.active = false
    // **await しない。** reader が lock を持ったままなので port.close() は
    // 失敗しうるが、**その前の setSignals 2 本が本体**なので構わない
    void closePortQuietly(s.port).catch(() => { /* ページが消えるので何もできない */ })
  }
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
    log('connect event')
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
    try { await closePortQuietly(s.port) }
    catch (e) {
      // 失敗するとポートが管理外に残りうる (掴み直さない症状の有力候補)。直す前にまず記録する
      log(`close failed name=${errorName(e)}`)
    }
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
      if (s.owner) await release(s.owner.name, 'read_end')
    }
  }

  // --- 機種判定 ---

  /**
   * `DEVICE <kind> ...` の `kind` を取り出す。`DEVICE ` を含まない行は null。
   * 行頭とは限らない (直前のログ行が途中で切れて連結されうる。request の照合と同じ理由)
   */
  function deviceKind(line: string): string | null {
    const at = line.indexOf('DEVICE ')
    if (at === -1) return null
    const rest = line.slice(at + 'DEVICE '.length)
    const sp = rest.indexOf(' ')
    return sp === -1 ? rest : rest.slice(0, sp)
  }

  /**
   * `DEVICE <kind>` の kind で持ち主を決める。kind は機種ごとに一意なので、
   * 判明した時点で「これは自分だ (`claim`)」か「これは自分ではない (`reject`)」の
   * どちらかに確定する — 利用側ごとの述語は要らない。
   *
   * `DEVICE` 行が 1 本も無ければ、`legacyClaim` を持つ利用側だけ後方互換で試す
   * (配備済みでまだ `DEVICE` に対応していないファーム向け、Refs ippoan/alc-app#353)。
   */
  function resolveDevice(lines: string[]): { owner: Owner | null } | null {
    for (const line of lines) {
      const kind = deviceKind(line)
      if (kind === null) continue
      // 誰も預からない機種でも控える — 「測定台か」の判断材料は名乗りだけ (#368)
      noteDeviceKind(kind)
      const claimant = claimants.get(kind)
      return { owner: claimant && !held.has(kind) ? { name: kind, claimant } : null }
    }
    for (const [name, claimant] of pending()) {
      if (claimant.legacyClaim?.(lines)) {
        // 旧い名乗りで決着した機は `DEVICE` を持たないので、登録名がそのまま機種
        noteDeviceKind(name)
        return { owner: { name, claimant } }
      }
    }
    return null // まだ判定材料が無い
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
            // 接頭辞は行頭とは限らない: 起動直後は USB CDC が詰まり、直前のログ行が途中で
            // 切れて応答が連結される (`EVT NFC_READY port=0` + `AUTH SIGBP ...`)。
            // 落ちたバイトは復元できないので、行の中から探して見つけた位置から後ろを使う。
            // 先に現れた方を採る (`ERR AUTH ...` は `AUTH ...` を含みうるため)
            const matchAt = line.indexOf(pendingRequest.matchPrefix)
            const errAt = line.indexOf(pendingRequest.errPrefix)
            if (matchAt >= 0 && (errAt < 0 || matchAt < errAt)) pendingRequest.resolve(line.slice(matchAt))
            else if (errAt >= 0) pendingRequest.reject(new Error(line.slice(errAt)))
          }
          s.owner.claimant.onLine(line)
          return
        }
        s.lines.push(line)
        // 判定は済んだが引き渡し前 — 同じチャンクの残りは lines に積むだけ
        if (settled) return

        const resolved = resolveDevice(s.lines)
        if (resolved) finish(resolved.owner)
      })

      // `DEVICE` (正本) と `STATUS` (配備済みファームの後方互換) の両方を撃つ。
      // 全台に DEVICE 対応の OTA が行き渡ったら STATUS 送信は撤去できる
      function sendProbe(): void {
        sends += 1
        void writeLine(s.writer, 'DEVICE').then((ok) => {
          if (!ok) finish(null)
        })
        void writeLine(s.writer, 'STATUS').then((ok) => {
          if (!ok) finish(null)
        })
        if (sends >= PROBE_MAX_SENDS) stopSends()
      }

      sendProbe()
      sendTimer = setInterval(sendProbe, PROBE_SEND_INTERVAL)
    })
  }

  /** 候補ポートを開いて機種を判定し、名乗り出た利用側へ預ける */
  async function tryPort(candidate: SerialPort): Promise<void> {
    try {
      await candidate.open(SERIAL_OPTIONS)
    }
    catch (e) {
      // InvalidStateError = 他の探索者が使用中 → 印を残さず次の候補へ
      debug(`open failed name=${errorName(e)}`)
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

  /**
   * 預かったポートを返す (抜線・書き込み失敗など) → 掴み直しへ。
   * `reason` (`read_end` / `write_failed` 等) は診断ログに残すだけ
   */
  async function release(name: string, reason?: string): Promise<void> {
    const s = held.get(name)
    if (!s) return
    held.delete(name)
    await closeSession(s, reason ? `release(${name}) reason=${reason}` : `release(${name})`)
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
    /**
     * 名乗りで決着した機種。`null` = 未確定 (`arbitratedDeviceKind` の doc を参照)。
     * ポートを預かるかどうかとは無関係に決まるので、利用側を登録していなくても読める
     */
    arbitratedDeviceKind,
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
