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
import { findDeviceLine } from '~/utils/device-line'
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

/** `VEIN SAY` は読み取り中でもすぐ鳴るので capture より短くてよい */
const SAY_TIMEOUT_MS = 5000

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

/** 接続の世代。切断・再接続をまたいで、古い問い合わせが呼び直しを続けないための印 */
let connectionEpoch = 0

/** `OMRON STATUS` の応答上限と、「既に応答待ち」(鍵の署名 `AUTH SIGN` と重なる) の呼び直し */
const OMRON_STATUS_TIMEOUT_MS = 3000
const OMRON_STATUS_RETRY_MS = 300
const OMRON_STATUS_RETRY_LIMIT = 40
const OMRON_STATUS_PREFIX = 'OMRON BP='

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
    onOpen(_port, _reader, _writer, lines) {
      // 利用側が配られた行の cb から読めるように、配る前に入れる (useCoreS3Serial と同じ)
      deviceInfo.value = findDeviceLine(lines)
      isConnected.value = true
      // プローブ中に来ていた行も配る (useAtomS3Serial と同じ)
      for (const line of lines) lineDispatch.dispatchLine(line)
      for (const notify of [...waiters]) notify()
      // 鍵の署名は isConnected の watch から先に枠を取るので、こちらは空くまで待つ
      void queryOmronBp()
    },

    onLine: lineDispatch.dispatchLine,

    onClose() {
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
   * 預かったポートで 1 行送って応答 1 つを待つ (鍵の署名 `AUTH SIGN` が使う、Refs ippoan/alc-app#436)。
   * 同時に 1 件しか待てないのは capture/say と同じ。ファームの書き込み中 (錠) は送らずに reject する
   */
  function request(line: string, matchPrefix: string, timeoutMs: number): Promise<string> {
    if (otaLocked) return Promise.reject(new Error(OTA_LOCKED_MESSAGE))
    return arbiter.request(CLAIMANT_NAME, line, matchPrefix, timeoutMs)
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
    request,
    omronBp: readonly(omronBp),
    noteOmronBp,
    ota: { begin: otaBegin, end: otaEnd, request: otaRequest },
    onClose,
    onEvent: lineDispatch.onEvent,
    onFingerPlaced,
    onJson: lineDispatch.onJson,
  }
}
