/**
 * Vein Station (指静脈読み取り端末、`atoms3-timecard` の `vein` build = Atom VoiceS3R +
 * `--features vein`) との USB シリアル接続。useSerialArbiter の利用側
 * (Refs ippoan/vein-match#20)。
 *
 * 端末は `DEVICE timecard …` と名乗る (alc-app-s3 `crates/hub-core/src/protocol.rs` の
 * `HostKind::Timecard`)。機種識別を USB 記述子では行えない理由・`DEVICE` プローブの
 * 仕組みは useAtomS3Serial / useSerialArbiter の doc と同じ (Refs ippoan/alc-app#182, #353)。
 * ここは預かったポートの使い方 (`VEIN CAPTURE` / `VEIN SAY <x>`) と、端末が自分から出す
 * `EVT` / JSON 行の配布 (`onEvent` / `onJson`、免許証と FC-1200。Refs ippoan/alc-app#436) を持つ。
 *
 * 正本: alc-app-s3 `docs/console-protocol.md` (ippoan/alc-app-s3#274)。
 *   `VEIN CAPTURE` → 成功 `VEIN CHARA <hex>` (1 行)。失敗 `ERR VEIN <reason>`。
 *     指を待つので応答まで最大 15 秒強
 *   `VEIN SAY <PLACE|AGAIN|ENROLLED|FAILED>` → `OK VEIN SAY <x>`。スピーカーが
 *     使えない機は `ERR VEIN NO_SPEAKER`
 *   `vein` を入れていない端末はどちらも `ERR VEIN: unsupported`
 *
 * 照合をモジュール自身に任せる口 (M-b、Refs ippoan/alc-app#436。指静脈を使うすべての画面が使う):
 *   `VEIN ENROLL <id>` → 置き直しのたび `EVT VEIN PLACE <2|3>` → 成功 `VEIN RECORD <id> <offset> <hex>` を
 *     何行か → `VEIN RECORD <id> END <総バイト数>`。置き直しの照合が外れたら `ERR VEIN RETAKE`。最長 1 分弱
 *   `VEIN IDENTIFY` → `VEIN IDENTIFIED <id>` / `VEIN NOMATCH`
 *   `VEIN SYNC WRITE <id> <offset> <hex>` (192 バイトまで) → `VEIN SYNC WRITE <id> <次の offset>`、
 *     `VEIN SYNC WRITE <id> END` → `VEIN SYNC WRITTEN <id> <バイト数>`
 *   `VEIN SYNC CLEAR <id>` → `VEIN SYNC CLEARED <id>`
 *
 * `useSerialArbiter.request()` は同時に 1 件しか待てない — capture の応答を待っている
 * 間に say を送らない (呼び出し側の責務、register.vue の手順が順に呼ぶだけで満たす)。
 *
 * ファームの書き込み中だけ、機体へのほかの送信を止める錠が在る (`ota.begin()` / `ota.end()` /
 * `ota.request()`。useCoreS3Serial・useAlarmDevice の `ota` と同じ形、Refs ippoan/alc-app#436)。
 * 錠の間は `request` (鍵の署名)・`capture`・`say` を `OTA_LOCKED_MESSAGE` で断る。
 * **使うのは `useSerialOta` だけ**。
 */

import type { SerialClaimant } from '~/composables/useSerialArbiter'
import { OTA_LOCKED_MESSAGE } from '~/composables/useCoreS3Serial'
import { TIMECARD_DEVICE_KIND } from '~/composables/useSerialArbiter'
import { requestWhenFree } from '~/utils/serial-request-when-free'
import { createLineDispatch } from '~/utils/serial-line-dispatch'
import { devTiming } from '~/utils/dev-timing'
import { findDeviceLine } from '~/utils/device-line'
import { appendDiag } from '~/utils/serialDiagLog'
import type { DeviceLine } from '~/utils/device-line'

/**
 * arbiter に登録する名前。`DEVICE timecard` の kind と一致させる — 語彙の正本は arbiter 側
 * (`TIMECARD_DEVICE_KIND`)
 */
const CLAIMANT_NAME = TIMECARD_DEVICE_KIND

/** connect() が claim を待つ上限 (useAtomS3Serial / useCoreS3Serial と同じ値・同じ意味) */
const CLAIM_TIMEOUT = 3000

/** `VEIN CAPTURE` の応答上限。ファームは 1 回の指待ちで最大 15 秒強かかるので余裕を足す */
const CAPTURE_TIMEOUT_MS = 20000

/**
 * `VEIN IDENTIFY` の応答上限。モジュールが撮り直しを求めると (`EVT VEIN AGAIN`) 次の指を最長 15 秒
 * 待ち直し、撮り直しは最大 2 回なので、指待ちが 3 回ぶん (45 秒) かかりうる。それに余裕を足す。
 * capture と同じ 20 秒だと、撮り直しが 1 回入るだけで画面が先に打ち切っていた (Refs ippoan/alc-app#436)
 */
const IDENTIFY_TIMEOUT_MS = 55_000

/** `VEIN SAY` は読み取り中でもすぐ鳴るので capture より短くてよい */
const SAY_TIMEOUT_MS = 5000

/** `VEIN ENROLL` は 3 回置く (1 回あたり指待ち 15 秒強) ので、最長 1 分弱に余裕を足す */
const ENROLL_TIMEOUT_MS = 90_000

/** `VEIN SYNC WRITE` の 1 行・`VEIN SYNC CLEAR` の応答上限 */
const SYNC_STEP_TIMEOUT_MS = 5000

/** `VEIN SYNC WRITE <id> END` はフラッシュに書くので長め */
const SYNC_END_TIMEOUT_MS = 15_000

/** `VEIN SYNC WRITE` の 1 行に載せるバイト数の上限 (ファームの console の 1 行 512 バイトに収める) */
export const VEIN_SYNC_CHUNK_BYTES = 192

/**
 * ほかの要求 (鍵の署名・同期の 1 行) の応答待ちで弾かれたときの呼び直し。同期の 1 行は数十 ms で
 * 返るので短い間隔で足りる。照合 (最長 20 秒) の後ろに並んでも諦めない回数にする
 */
const BUSY_RETRY = { intervalMs: 200, maxRetries: 150 }

/** `VEIN RECORD` 行が壊れていた (offset の飛び・総バイト数の食い違い・16 進でない) */
export const VEIN_RECORD_BROKEN = 'RECORD_BROKEN'

// シングルトン: 1 台の PC につながる Vein Station は 1 台
const isConnected = ref(false)

/**
 * 繋がっている機体の名乗り (`DEVICE timecard VER=… FLAVOR=…` の欄)。未接続は null。
 * FLAVOR で「機体が自分で打刻を送るか」を決める (`deviceSendsPunch`、Refs ippoan/alc-app#436)。
 * useCoreS3Serial の `deviceInfo` と同じ形
 */
const deviceInfo = ref<DeviceLine | null>(null)

/**
 * 機体の設定で「血圧計を使う」(`OMRON BP=1`) か。つながったとき `OMRON STATUS` で聞く。
 * 未取得 (未接続・応答なし・旧ファーム) は null。端末登録の無い PC では、サーバの設定
 * (`devices.bp_enabled`) も `bp_bond` の行も当てにできないので、画面はこれで血圧を出すか決める
 * (Refs ippoan/alc-app#436)。OFF→ON の直後は機体を再起動するまで BLE が血圧計を拾わないが、
 * ここは設定の値なので 1 になる。
 */
const omronBp = ref<boolean | null>(null)

/** 掴んでいるポート (機体の再起動 {@link restart} に使う)。未接続は null */
let openPort: SerialPort | null = null

/** 接続の世代。切断・再接続をまたいで、古い問い合わせが呼び直しを続けないための印 */
let connectionEpoch = 0

/** `OMRON STATUS` の応答上限と、「既に応答待ち」(鍵の署名 `AUTH SIGN` と重なる) の呼び直し */
const OMRON_STATUS_TIMEOUT_MS = 3000
const OMRON_STATUS_RETRY_MS = 300
const OMRON_STATUS_RETRY_LIMIT = 40
const OMRON_STATUS_PREFIX = 'OMRON BP='
/** `OMRON BP ON|OFF` の応答 (`OK OMRON BP=<0|1>`) と `PAIR` の応答 (`OK PAIR`) */
const OMRON_SET_PREFIX = 'OK OMRON BP='
const PAIR_REPLY = 'OK PAIR'

/**
 * ファームの書き込み中の錠。機体は `OTA SERIAL` の後、イメージを受け切るまで受けたバイトを
 * 全部イメージとして読む — その間に `AUTH SIGN`・`VEIN CAPTURE`・`VEIN SAY` を 1 行でも送ると
 * イメージに混ざって検証で落ちる。掛かっている間に通るのは `ota.request` だけ
 */
let otaLocked = false

/** claim を待っている connect() */
const waiters = new Set<() => void>()

/** ポートを失った / 返したときに呼ぶ利用側 (useDeviceToken が JWT キャッシュを捨てる、Refs ippoan/alc-app#436) */
const closeHandlers = new Set<() => void>()

/**
 * Port A の NFC ユニット (`EVT NFC_LICENSE …` / `EVT TIMECARD …`) と RS232 の FC-1200
 * (`EVT FC1200 …` / `{"type":"alcohol",…}`) の行を配る。CoreS3 と同じ語彙・同じ配り方
 * (Refs ippoan/alc-app#436)
 */
const lineDispatch = createLineDispatch('VEIN')

/**
 * `VEIN ENROLL` の応答待ちの間だけ入る、生の行の受け口。`VEIN RECORD` の行はコマンドの応答なので
 * `lineDispatch` には配られない — END まで arbiter の枠を握ったまま、途中の行をここで集める
 */
let rawLineTap: ((line: string) => void) | null = null

/** 16 進の文字列をバイト列に。16 進でなければ null */
function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9A-Fa-f]*$/.test(hex)) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/** バイト列を大文字の 16 進に */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').toUpperCase()
}

/**
 * 集めた `VEIN RECORD <id> <offset> <hex>` の塊を 1 つのバイト列にする。offset が 0 から隙間なく
 * 続き、合計が END の総バイト数と一致するときだけ返す (ファーム doc: ホストは END を見てから確かめて使う)
 */
function assembleRecord(chunks: Array<{ offset: number; bytes: Uint8Array }>, total: number): Uint8Array {
  const record = new Uint8Array(total)
  let next = 0
  for (const chunk of [...chunks].sort((a, b) => a.offset - b.offset)) {
    if (chunk.offset !== next || next + chunk.bytes.length > total) throw new Error(VEIN_RECORD_BROKEN)
    record.set(chunk.bytes, next)
    next += chunk.bytes.length
  }
  if (next !== total || total === 0) throw new Error(VEIN_RECORD_BROKEN)
  return record
}

/**
 * `ERR VEIN <reason>` / `ERR VEIN: unsupported` から reason だけを取り出す。
 * `useSerialArbiter.request()` の reject は `ERR VEIN ...` 以降を丸ごと Error.message に
 * するので (`errPrefix` からの slice)、先頭の `ERR VEIN` とその後ろの `:`/空白を落とす。
 * `ERR VEIN` を含まない message (timeout 等) はそのまま返す。
 */
function extractVeinErrReason(message: string): string {
  const at = message.indexOf('ERR VEIN')
  if (at === -1) return message
  return message.slice(at + 'ERR VEIN'.length).replace(/^[:\s]+/, '')
}

/** 血圧の遅れの切り分け用 (開発用の端末だけ出る)。本文は EVT 行のみ・JSON は type だけ */
const TIMING_JSON_TYPES = ['found', 'connected', 'disconnected', 'blood_pressure']
function tapTiming(line: string): void {
  if (line.startsWith('EVT OMRON') || line.startsWith('EVT BP')) devTiming('vein.evt', { line })
  else if (line.startsWith('{')) {
    const type = TIMING_JSON_TYPES.find(t => line.includes(`"type":"${t}"`))
    if (type) devTiming('vein.json', { type })
  }
}

export function useVeinSerial() {
  // ポートの探索と調停は arbiter に任せる (navigator.serial を自前で叩かない)
  const arbiter = useSerialArbiter()
  const isSupported = arbiter.isSupported

  // --- arbiter に預けるハンドラ ---
  //
  // capture/say の応答は arbiter.request() が照合して返す。arbiter は照合した後も同じ行を
  // onLine へ流すが、応答 (`VEIN CHARA` / `OK VEIN` / `ERR VEIN` / `AUTH`) は `EVT ` でも
  // `{` でも始まらないので、dispatchLine の接頭辞で落ちて二重には配られない。

  const claimant: SerialClaimant = {
    onOpen(port, _reader, _writer, lines) {
      openPort = port
      // 利用側が配られた行の cb から読めるように、配る前に入れる (useCoreS3Serial と同じ)
      deviceInfo.value = findDeviceLine(lines)
      isConnected.value = true
      // プローブ中に来ていた行も配る (useAtomS3Serial と同じ)
      for (const line of lines) {
        tapTiming(line)
        lineDispatch.dispatchLine(line)
      }
      for (const notify of [...waiters]) notify()
      // 鍵の署名は isConnected の watch から先に枠を取るので、こちらは空くまで待つ
      void queryOmronBp()
    },

    onLine(line) {
      rawLineTap?.(line)
      tapTiming(line)
      lineDispatch.dispatchLine(line)
    },

    onClose() {
      openPort = null
      connectionEpoch++
      omronBp.value = null
      deviceInfo.value = null
      isConnected.value = false
      for (const cb of [...closeHandlers]) cb()
    },
  }

  /** 機体に `OMRON STATUS` を聞いて {@link omronBp} に入れる。聞けなければ null のまま */
  async function queryOmronBp(): Promise<void> {
    const epoch = ++connectionEpoch
    try {
      const reply = await requestWhenFree(
        () => request('OMRON STATUS', OMRON_STATUS_PREFIX, OMRON_STATUS_TIMEOUT_MS),
        { intervalMs: OMRON_STATUS_RETRY_MS, maxRetries: OMRON_STATUS_RETRY_LIMIT, isCancelled: () => epoch !== connectionEpoch },
      )
      const value = reply.slice(OMRON_STATUS_PREFIX.length).trim()
      if (value === '1' || value === '0') omronBp.value = value === '1'
    }
    catch {
      // 旧ファーム・時間切れ・抜線: 分からないまま (null)。画面は従来の判定に任せる
    }
  }

  /**
   * 機体に「血圧計 (Omron) を拾うか」を書く (`OMRON BP ON|OFF`、NVS に保存)。
   * **反映は機体の再起動の後** ({@link restart})。応答の値が頼んだ値と違えば Error
   */
  async function setOmronBp(enabled: boolean): Promise<void> {
    const reply = await requestWhenFree(
      () => request(enabled ? 'OMRON BP ON' : 'OMRON BP OFF', OMRON_SET_PREFIX, OMRON_STATUS_TIMEOUT_MS),
      { intervalMs: OMRON_STATUS_RETRY_MS, maxRetries: OMRON_STATUS_RETRY_LIMIT },
    )
    if (reply.slice(OMRON_SET_PREFIX.length).trim() !== (enabled ? '1' : '0')) {
      throw new Error('血圧計の設定を書けませんでした')
    }
    omronBp.value = enabled
  }

  /**
   * 血圧計のペアリングの受付を開く (`PAIR`)。**機体の BLE のボンドを全部消してから**受け付ける。
   * 受付の後に血圧計をペアリング待ち (`-P-` 点滅) にすると、機体がつなぎに行く
   */
  async function startPairing(): Promise<void> {
    await requestWhenFree(
      () => request('PAIR', PAIR_REPLY, OMRON_STATUS_TIMEOUT_MS),
      { intervalMs: OMRON_STATUS_RETRY_MS, maxRetries: OMRON_STATUS_RETRY_LIMIT },
    )
  }

  /**
   * 機体を再起動する。ESP32-S3 の USB-Serial-JTAG は「DTR=0 かつ RTS=1」で chip reset が
   * かかる (useSerialArbiter の closePortQuietly が避けている条件を、ここではわざと踏む)。
   * RTS を先に上げてから DTR を落とす。再起動で接続はいったん切れ、arbiter が掴み直す
   */
  async function restart(): Promise<void> {
    const port = openPort
    if (!port) throw new Error('Vein Station がつながっていません')
    await port.setSignals({ requestToSend: true })
    await port.setSignals({ dataTerminalReady: false })
  }

  /** 端末設定で `OMRON BP ON/OFF` が通ったときに、機体の設定の値を合わせる */
  function noteOmronBp(enabled: boolean): void {
    omronBp.value = enabled
  }

  /** ポートを失った / 返した (useCoreS3Serial / useAtomS3Serial の onClose と同じ形) */
  function onClose(cb: () => void): void {
    closeHandlers.add(cb)
  }

  /** 呼ぶ前に connect() が接続済みを弾いているので、ここは必ず未接続から始まる */
  function waitForClaim(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const onClaim = (): void => {
        clearTimeout(timer)
        waiters.delete(onClaim)
        resolve(true)
      }
      const timer = setTimeout(() => {
        waiters.delete(onClaim)
        resolve(false)
      }, CLAIM_TIMEOUT)
      waiters.add(onClaim)
    })
  }

  /**
   * arbiter に自分を登録して claim を待つ。`delay` ミリ秒後に最初のスキャン。
   * 待ちが切れても登録は残るので、以後 10 秒ごとの再スキャンで拾われる。
   */
  async function connect(delay = 0): Promise<boolean> {
    if (!isSupported) return false
    if (isConnected.value) return true
    arbiter.register(CLAIMANT_NAME, claimant)
    arbiter.start(delay)
    return await waitForClaim()
  }

  /** 登録を解いてポートを返す (探索も止まる) */
  async function disconnect(): Promise<void> {
    await arbiter.unregister(CLAIMANT_NAME)
  }

  /**
   * 指を読ませて特徴量の hex を 1 回取得する。
   *
   * 成功: `VEIN CHARA <hex>` から hex 部分を返す。
   * 失敗: `ERR VEIN <reason>` (または `ERR VEIN: unsupported`) の reason を message にした
   * Error を投げる (`NO_MODULE` / `TIMEOUT` / `NO_FINGER` / `READ_FAIL` / `RC=<hex2桁>` /
   * `unsupported`)。arbiter.request() 自体がタイムアウトしたときはそのメッセージのまま
   * (`ERR VEIN` を含まないので {@link extractVeinErrReason} が素通しする)。
   *
   * `arbiter.request()` の reject は必ず `Error` (Refs useSerialArbiter.request の doc:
   * 未預かり/多重応答待ち/timeout/write失敗/ERR いずれも `new Error(...)`) なので、
   * ここでは `instanceof` を確かめずに `Error` として扱う (到達しない分岐を作らない)。
   */
  async function capture(): Promise<string> {
    if (otaLocked) throw new Error(OTA_LOCKED_MESSAGE)
    let line: string
    try {
      line = await arbiter.request(CLAIMANT_NAME, 'VEIN CAPTURE', 'VEIN CHARA', CAPTURE_TIMEOUT_MS)
    } catch (e) {
      throw new Error(extractVeinErrReason((e as Error).message))
    }
    return line.slice('VEIN CHARA '.length)
  }

  /**
   * 端末のスピーカーで案内を鳴らす。
   *
   * `ERR VEIN NO_SPEAKER` (スピーカーが使えない機) は**失敗にしない** — 音声が無くても
   * 登録の手順は続ける (親の決定)。それ以外の失敗 (`unsupported` 等) はそのまま投げる。
   */
  async function say(x: 'PLACE' | 'AGAIN' | 'ENROLLED' | 'FAILED'): Promise<void> {
    if (otaLocked) throw new Error(OTA_LOCKED_MESSAGE)
    try {
      await arbiter.request(CLAIMANT_NAME, `VEIN SAY ${x}`, 'OK VEIN SAY', SAY_TIMEOUT_MS)
    } catch (e) {
      if (extractVeinErrReason((e as Error).message) === 'NO_SPEAKER') return
      throw e
    }
  }

  /**
   * 錠を確かめ、ほかの要求の応答待ちで弾かれたら空くまで呼び直して送る。`ERR VEIN <reason>` は
   * reason だけの Error にする (capture と同じ)
   */
  async function veinRequest(line: string, matchPrefix: string | readonly string[], timeoutMs: number): Promise<string> {
    try {
      return await requestWhenFree(() => {
        // 待つ間に錠が掛かることがあるので、送るたびに確かめる
        if (otaLocked) return Promise.reject(new Error(OTA_LOCKED_MESSAGE))
        return arbiter.request(CLAIMANT_NAME, line, matchPrefix, timeoutMs)
      }, BUSY_RETRY)
    }
    catch (e) {
      throw new Error(extractVeinErrReason((e as Error).message))
    }
  }

  /**
   * モジュールの `id` (10〜100) に指静脈を登録し、記録全体 (READ_ENROLL の中身) を返す。
   * 置き直しの案内のたびに `onPlace(n, total)` を呼ぶ。ファームは `EVT VEIN PLACE <n> <合計>` を出す
   * (撮影 4 + 確認 2 なら合計 6)。合計を名乗らない古いファームの `EVT VEIN PLACE <n>` では total は undefined。
   *
   * 失敗は reason の Error: `RETAKE` (置き直しの照合が外れた。モジュールからは消してある) /
   * `TIMEOUT` 等の `ERR VEIN <reason>` / 行が壊れていた {@link VEIN_RECORD_BROKEN}。
   * END まで arbiter の枠を握るので、その間ほかの say / capture は「既に応答待ち」で弾かれる
   */
  async function enroll(id: number, onPlace?: (n: number, total?: number) => void): Promise<Uint8Array> {
    const prefix = `VEIN RECORD ${id} `
    const endPrefix = `${prefix}END `
    const chunks: Array<{ offset: number; bytes: Uint8Array }> = []
    let broken = false
    rawLineTap = (line) => {
      // 行は途中に連結されて届くことがあるので、行の中から探す (arbiter の照合と同じ)
      const at = line.indexOf(prefix)
      if (at < 0 || line.includes(endPrefix)) return
      const [offset, hex] = line.slice(at + prefix.length).split(' ')
      const bytes = hexToBytes(hex ?? '')
      if (!/^\d+$/.test(offset!) || !bytes) broken = true
      else chunks.push({ offset: Number(offset), bytes })
    }
    const offPlace = lineDispatch.onEvent((name, args) => {
      if (name !== 'VEIN' || args[0] !== 'PLACE' || (args.length !== 2 && args.length !== 3)) return
      if (!args.slice(1).every(a => /^\d+$/.test(a))) return
      onPlace?.(Number(args[1]), args[2] === undefined ? undefined : Number(args[2]))
    })
    let end: string
    try {
      end = await veinRequest(`VEIN ENROLL ${id}`, endPrefix, ENROLL_TIMEOUT_MS)
    }
    finally {
      rawLineTap = null
      offPlace()
    }
    const total = Number(end.slice(endPrefix.length).trim())
    if (broken || !Number.isInteger(total)) throw new Error(VEIN_RECORD_BROKEN)
    return assembleRecord(chunks, total)
  }

  /**
   * モジュール自身の 1:N 照合。当たればモジュールの ID、不一致は null。失敗は reason の Error。
   * モジュールが撮り直しを求めるたび (`EVT VEIN AGAIN <理由>`、端末は「もう一度置いてください」を鳴らす)
   * `onAgain()` を呼ぶ。理由 (`11` = 静脈が写らない / `09` = 同じ指でない) はコンソールと診断ログ
   * (`alc_serial_diag`) に残す — 毎回撮り直しになるときの切り分け用。理由の無い行 (ippoan/alc-app-s3#316
   * の版) も合図として受ける。古いファームはこの行を出さない (待ち時間だけ延びる)
   */
  /** 照合の間、モジュールの撮り直しの合図 (`EVT VEIN AGAIN <理由>`) を拾う。戻り値で外す */
  function watchAgain(onAgain?: () => void): () => void {
    return lineDispatch.onEvent((name, args) => {
      if (name !== 'VEIN' || args[0] !== 'AGAIN' || args.length > 2) return
      const msg = `[vein] 照合でモジュールが撮り直しを求めた (理由 ${args[1] ?? '-'})`
      console.info(msg)
      appendDiag(msg)
      onAgain?.()
    })
  }

  async function identify(onAgain?: () => void): Promise<number | null> {
    const offAgain = watchAgain(onAgain)
    let line: string
    try {
      line = await veinRequest('VEIN IDENTIFY', ['VEIN IDENTIFIED ', 'VEIN NOMATCH'], IDENTIFY_TIMEOUT_MS)
    }
    finally {
      offAgain()
    }
    if (line.startsWith('VEIN NOMATCH')) return null
    const id = Number(line.slice('VEIN IDENTIFIED '.length).trim())
    if (!Number.isInteger(id)) throw new Error('IDENTIFY の応答が読めません')
    return id
  }

  /**
   * モジュールの `id` (10〜100) と 1:1 で照合する (`VEIN VERIFY <id>`)。本人が免許証・社員番号で
   * 先に決まっているときに使う。当たれば true、不一致は false。撮り直しの合図のたびに `onAgain`
   */
  async function verify(id: number, onAgain?: () => void): Promise<boolean> {
    const offAgain = watchAgain(onAgain)
    try {
      const line = await veinRequest(`VEIN VERIFY ${id}`, [`VEIN VERIFIED ${id}`, 'VEIN NOMATCH'], IDENTIFY_TIMEOUT_MS)
      return line.startsWith('VEIN VERIFIED')
    }
    finally {
      offAgain()
    }
  }

  /**
   * サーバーの記録 `record` をモジュールの `id` (10〜100) へ書く。192 バイトずつ送って応答を待ち、
   * 最後に END でフラッシュへ書かせる。失敗は reason の Error (`WRITE_SEQ` 等)
   */
  async function syncWrite(id: number, record: Uint8Array): Promise<void> {
    for (let offset = 0; offset < record.length; offset += VEIN_SYNC_CHUNK_BYTES) {
      const chunk = record.subarray(offset, offset + VEIN_SYNC_CHUNK_BYTES)
      const ackPrefix = `VEIN SYNC WRITE ${id} `
      const ack = await veinRequest(`${ackPrefix}${offset} ${bytesToHex(chunk)}`, ackPrefix, SYNC_STEP_TIMEOUT_MS)
      if (Number(ack.slice(ackPrefix.length).trim()) !== offset + chunk.length) throw new Error('WRITE_SEQ')
    }
    await veinRequest(`VEIN SYNC WRITE ${id} END`, `VEIN SYNC WRITTEN ${id} `, SYNC_END_TIMEOUT_MS)
  }

  /** モジュールの `id` (10〜100) の登録を消す。失敗は reason の Error */
  async function syncClear(id: number): Promise<void> {
    await veinRequest(`VEIN SYNC CLEAR ${id}`, `VEIN SYNC CLEARED ${id}`, SYNC_STEP_TIMEOUT_MS)
  }

  /**
   * モジュールの登録人数と上限 (`VEIN SYNC INFO`、ファームは ippoan/alc-app-s3#328 から)。
   * 端末の一覧の画面と、対応表との食い違いの見分けに使う
   */
  async function syncInfo(): Promise<{ users: number; max: number }> {
    const line = await veinRequest('VEIN SYNC INFO', 'VEIN SYNC INFO ', SYNC_STEP_TIMEOUT_MS)
    const m = /USERS=(\d+) MAX=(\d+)/.exec(line)
    if (!m) throw new Error('SYNC INFO の応答が読めません')
    return { users: Number(m[1]), max: Number(m[2]) }
  }

  /**
   * 預かったポートで 1 行送って応答 1 つを待つ (鍵の署名 `AUTH SIGN` が使う、Refs ippoan/alc-app#436)。
   * 同時に 1 件しか待てないのは capture/say と同じ。ファームの書き込み中 (錠) は送らずに reject する。
   * `errPrefix` は失敗行の接頭辞 (省略時は arbiter の既定 = 行の先頭トークンの `ERR <先頭トークン>`)
   */
  function request(line: string, matchPrefix: string, timeoutMs: number, errPrefix?: string): Promise<string> {
    if (otaLocked) return Promise.reject(new Error(OTA_LOCKED_MESSAGE))
    return arbiter.request(CLAIMANT_NAME, line, matchPrefix, timeoutMs, errPrefix)
  }

  // --- ファームの書き込みだけが使う口 (Refs ippoan/alc-app-s3#279, ippoan/alc-app#436) ---

  /** 錠を掛ける。以後 `otaEnd()` まで、機体へ届くのは `otaRequest` だけ */
  function otaBegin(): void {
    otaLocked = true
  }

  /** 錠を解く (掛かっていなくても害は無い。Vein Station には始め直す heartbeat が無い) */
  function otaEnd(): void {
    otaLocked = false
  }

  /**
   * 錠に関係なく、行またはバイト列を送って応答 1 つを待つ (`useCoreS3Serial().ota.request` と同じ形)。
   * station も vein も `DEVICE timecard` でこの claimant が握るので、`useSerialOta` はここ経由で
   * ポートを使う (2 本目の claimant を立てない)
   */
  function otaRequest(line: string, matchPrefix: string, timeoutMs: number, errPrefix?: string): Promise<string>
  function otaRequest(bytes: Uint8Array, matchPrefix: string, timeoutMs: number, errPrefix: string): Promise<string>
  function otaRequest(payload: string | Uint8Array, matchPrefix: string, timeoutMs: number, errPrefix?: string): Promise<string> {
    // 実装側の引数は union なので、arbiter のどちらの overload にも当てはまるよう
    // バイト列 overload (errPrefix 必須) の形に寄せて渡す
    return arbiter.request(CLAIMANT_NAME, payload as Uint8Array, matchPrefix, timeoutMs, errPrefix as string)
  }

  /**
   * 指が置かれた合図 (`EVT VEIN FINGER`) を受け取る。返り値を呼ぶと解除できる。
   * ファームが「無い → 有る」のときだけ 1 行出す。非対応のファームは `EVT VEIN FINGER UNSUPPORTED`
   * と名乗るので、引数が `FINGER` 1 つだけのときに限って cb を呼ぶ (Refs ippoan/alc-app#436)
   */
  function onFingerPlaced(cb: () => void): () => void {
    return lineDispatch.onEvent((name, args) => {
      if (name === 'VEIN' && args.length === 1 && args[0] === 'FINGER') cb()
    })
  }

  return {
    isSupported,
    isConnected: readonly(isConnected),
    deviceInfo: readonly(deviceInfo),
    connect,
    disconnect,
    capture,
    say,
    enroll,
    identify,
    verify,
    syncWrite,
    syncClear,
    syncInfo,
    request,
    omronBp: readonly(omronBp),
    noteOmronBp,
    setOmronBp,
    startPairing,
    restart,
    ota: { begin: otaBegin, end: otaEnd, request: otaRequest },
    onClose,
    onEvent: lineDispatch.onEvent,
    onFingerPlaced,
    onJson: lineDispatch.onJson,
  }
}
