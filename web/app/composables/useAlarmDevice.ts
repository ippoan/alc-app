/**
 * 据置警告デバイス (Atom VoiceS3R / USB CDC) との接続と heartbeat 送信。
 *
 * つなぐ先は**運行管理者の PC**。見張る対象は「運行管理者ダッシュボードが開いていて、
 * 乗務員からの着信を受けられる状態か」であって、乗務員側キオスクの生死ではない。
 *
 * ブラウザは「鳴れ」と命令しない。3 秒ごとに状態を 1 行送るだけで、デバイスは
 * heartbeat が途切れたら自分の判断で鳴る。管理者がタブを閉じた・別タブへ移った・
 * PC がフリーズした、のいずれも「無音」という同じ形で拾えるようにするため。
 * ダッシュボード側は unmount で disconnect() するだけでよい。
 *
 * プロトコル (firmware と同文。行指向 \n / ASCII / 115200 8N1):
 *   host → dev  `HB OK` / `HB NG <reason>`  … 3 秒ごと。デバイスは返信しない
 *   host → dev  `DEVICE`                    … 機種判定のためのプローブ (arbiter が撃つ)
 *   host → dev  `STATUS`                    … 接続直後に 1 回だけ (下記)
 *   dev  → host `DEVICE alarm VER=<ver>`    … プローブへの応答 (名乗り、arbiter が判定)
 *   dev  → host `STATUS alarm state=<idle|alarming|muted> cause=<none|silence|ng:<reason>|call> hb_age_ms=<n|-> VER=<ver>`
 *   dev  → host `EVT ALARM state=<...> cause=<...>` … 状態遷移のたび + 5 秒ごと無条件
 *   dev  → host `EVT NFC_LOGIN card_id=<16 進> card_kind=<felica_idm|nfca_uid>` … 社員証の IC カードを読んだ
 *   dev  → host `EVT NFC_LICENSE issue=<8 桁> expiry=<8 桁>`                    … 運転免許証を読んだ
 * 末尾トークン ` call=1` / ` call=0` は任意 (無ければ 0)。` grace=<秒>` も任意 (下記)。
 *
 * `DEVICE` は名乗り専用で状態を持たない。接続直後の初期状態 (`state=`/`cause=`) は
 * `EVT ALARM` の次の周期送信 (5 秒ごと) を待たず `STATUS` を 1 回撃って取る
 * (onOpen、Refs ippoan/alc-app#353)。以後の状態は `EVT ALARM` のプッシュで追う。
 *
 * 送る中身は useActiveRooms から組み立てる:
 *   room 一覧の購読 (WebSocket) が 15 秒以上切れている → `HB NG signaling` (着信を受けられない)
 *   それ以外                                          → `HB OK`
 *   着信として数える部屋が在る (useActiveRooms の callingRooms。判定はあちら 1 か所)
 *                                                     → 末尾に ` call=1` (着信中)
 *
 * 意図した reload (chunk 読み込み失敗の自動復旧 / アプリ内の reload / 利用者の F5) では
 * シリアルが閉じて heartbeat が途絶するが、鳴らさずに再接続を待ってほしい。reload の
 * 直前に ` grace=45` 付きの heartbeat を 1 行送ると firmware はその 1 回だけ沈黙の猶予を
 * 広げる (Refs ippoan/alc-app-s3#192)。呼び口は notifyIntentionalReload()。
 *
 * 機種識別を USB 記述子では行えない: CoreS3 の BLE ゲートウェイも VoiceS3R も
 * VID 0x303A / PID 0x1001 で同一。ポートの探索・open・`DEVICE` プローブ・
 * `DEVICE <kind>` の判定は useSerialArbiter が 1 本で行う (Refs ippoan/alc-app#182,
 * #353)。ここは預かったポートの使い方だけを持つ。
 *
 * 本体のボタンの押下は専用の行を持たない。鳴っている間 (alarming) に押すと firmware が
 * muted に移して `EVT ALARM state=muted cause=<押した瞬間の理由>` を即出すので、
 * **着信で鳴っていた (`alarming`/`call`) → 黙った (`muted`/`call`)** の遷移を押下として数える
 * (`buttonPressCount`。alarming → muted を作るのは本体のボタンだけ、Refs ippoan/alc-app#387)。
 * 5 秒ごとの再送・`STATUS` の応答・接続直後の最初の行・ほかの遷移では数えない。
 *
 * NFC を持つ機体は、カードを読むと上の 2 種類の行を出す (機体は打刻しない)。ここは行を検査して
 * **「読んだカード」の合図** (`cardRead` = 連番 + 社員の照会に送る id) を出すだけで、照会も登録も
 * しない (読むのは IT点呼 の受け画面、Refs ippoan/alc-app#387)。途中で切れた行・知らない種類の
 * カードは捨てる。接続時にプローブ中の行として渡された分 (= 繋ぐ前のタッチ) は合図にしない。
 * 同じカードの連続の読み取りを抑えるのは機体の役目で、ここは届いた行の数だけ合図を出す。
 * **カードの id はログに出さない。**
 *
 * 画面からの更新 (Refs ippoan/alc-app#425): 機体の名乗り (`DEVICE alarm VER=… FLAVOR=…`) の欄を
 * `deviceInfo` に持ち、書き込みだけが使う口 `ota` (錠) を出す。機体は `OTA SERIAL` の後、受けた
 * バイトを全部イメージとして読むので、錠の間は heartbeat も `STATUS` も grace も通常の `request`
 * (席の署名) も送らない。通るのは `ota.request` と `ota.rest` だけ。**使うのは `useSerialOta` だけ**
 *
 * 診断ログ (`[ALARM-DEV]`) は運行者端末の DevTools で読む用に出しっぱなし (Refs #197)。
 */

import type { SerialClaimant } from '~/composables/useSerialArbiter'
import { msSinceLoad, writeLine } from '~/composables/useSerialArbiter'
import { evtArg, OTA_LOCKED_MESSAGE } from '~/composables/useCoreS3Serial'
import { findDeviceLine } from '~/utils/device-line'
import type { DeviceLine } from '~/utils/device-line'
import { licenseNfcId } from '~/utils/license'

/** デバイスが報告する鳴動状態 */
export interface AlarmDeviceState {
  state: 'idle' | 'alarming' | 'muted'
  cause: string
}

/**
 * 機体が読んだカード 1 枚ぶんの合図。`seq` は読むたびに増える連番 (同じカードでも増える)、
 * `lookupId` は社員の照会 (`lookupEmployeeByCard`) に送る id
 */
export interface AlarmCardRead {
  seq: number
  lookupId: string
}

/**
 * arbiter に登録する名前。`DEVICE alarm` の kind (auth-worker の `DEVICE_KINDS` の
 * key に揃えた語彙、Refs ippoan/alc-app#353) と一致させる — arbiter は `DEVICE <kind>`
 * の kind をそのままこの名前として引く
 */
const CLAIMANT_NAME = 'alarm'

/** mount 直後は BLE ゲートウェイに先にポートを選ばせる (同居しない PC では 0 を渡す) */
const INITIAL_SCAN_DELAY = 5000

/**
 * heartbeat の送信間隔。CoreS3 (useCoreS3Serial) も同じ間隔で `HB OK` を送るので
 * ここを唯一の出どころにする — firmware 側の失効判定は両機とも同じ前提で組んである。
 */
export const HEARTBEAT_INTERVAL = 3000

/**
 * 意図した reload の直前に送る ` grace=<秒>`。firmware はこの 1 回だけ沈黙の猶予を
 * 10 秒からこの秒数に広げる (Refs ippoan/alc-app-s3#192)。旧 firmware は ERR で捨てる (害なし)。
 * CoreS3 (useCoreS3Serial) も同じ値を送るのでここを唯一の出どころにする。
 */
export const RELOAD_GRACE_SEC = 45

/**
 * 画面からの更新の直前に送る ` grace=<秒>` (機体が受ける上限)。書き込みの間は heartbeat を
 * 送れないので、その間だけ沈黙の猶予を広げる。`HB OFF` と違い武装は消えない — 期限が来れば
 * 機体が自分で見張りに戻る (途中でタブを閉じても、鳴らないままにならない)
 */
export const OTA_GRACE_SEC = 120

/**
 * 購読 (WebSocket) が切れてから `HB NG signaling` に切り替えるまでの猶予。
 * WS の 3 秒再接続 (useActiveRooms) で鳴らさないため。沈黙の 10 秒より長いのは、
 * 本当に切れていれば heartbeat 自体が NG で届き続けるため (Refs ippoan/alc-app#198)。
 */
export const NG_GRACE_MS = 15_000

/**
 * reload をまたいで「直前まで握っていた」ことを次の page load に伝える印 (sessionStorage)。
 * onOpen で立て、disconnect() の明示切断で消す。connect() が読んだら消して即スキャンする。
 */
const RECONNECT_MARK_KEY = 'alarm_dev_connected'

// シングルトン: 管理者 PC につながる警告デバイスは 1 台なので状態も 1 つ
const isConnected = ref(false)
const deviceState = ref<AlarmDeviceState | null>(null)
/** 着信で鳴っている間に本体のボタンが押された回数 (増えるだけ。読む側は watch する) */
const buttonPressCount = ref(0)
/** 機体が最後に読んだカード (まだ 1 枚も読んでいなければ null。読む側は watch する) */
const cardRead = ref<AlarmCardRead | null>(null)
/** 繋がっている機体の名乗りの欄 (CoreS3 と同形)。未接続と、名乗りを拾えなかった接続は null */
const deviceInfo = ref<DeviceLine | null>(null)

/**
 * 状態行 (`state=`/`cause=` を積む行) の始まり。行頭とは限らない — シリアルの行は原子的でなく、
 * 直前のログ行が途中で切れて連結されうる (useSerialArbiter の request の照合と同じ理由)
 */
const STATE_LINE = /STATUS alarm|EVT ALARM/

/** カードの行の始まり (状態行と同じく、行頭とは限らない) */
const CARD_LINE = /EVT NFC_(LOGIN|LICENSE)(?= )/
/** `EVT NFC_LOGIN` の `card_kind` として受ける語 */
const CARD_KINDS = ['felica_idm', 'nfca_uid']
/** `EVT NFC_LOGIN` の `card_id` の形 (16 進の 8〜20 桁) */
const CARD_ID = /^[0-9a-f]{8,20}$/i

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
/** 預かっているポートの writer (未接続なら null)。grace の送り先 */
let held: WritableStreamDefaultWriter<Uint8Array> | null = null
/** 購読が切れた時刻 (購読中は null)。NG_GRACE_MS の起点 */
let ngSince: number | null = null
/** 購読の監視を張ったか (アプリ全体で 1 本) */
let ngWatchInstalled = false
/** 直前に送った heartbeat の中身。変化したときだけログに出す */
let lastLine: string | null = null
/**
 * ファームの書き込み中の錠 (Refs ippoan/alc-app#425。CoreS3 の `otaLocked` と同じ役目)。
 * 掛かっている間に機体へ届くのは `ota.request` と `ota.rest` だけ
 */
let otaLocked = false

function log(message: string): void {
  console.log(`[ALARM-DEV] ${message} (+${msSinceLoad()}ms)`)
}

export function useAlarmDevice() {
  // ポートの探索と調停は arbiter に任せる (navigator.serial を自前で叩かない)
  const arbiter = useSerialArbiter()
  // 送る中身の素。購読の開始/停止はダッシュボード側の責務 (ここでは読むだけ)
  const rooms = useActiveRooms()

  const isSupported = arbiter.isSupported

  // --- 行の解釈 ---

  /**
   * `state=` / `cause=` を拾って deviceState に畳む。着信で鳴っていた状態から黙った遷移
   * (= 本体のボタン) のときだけ buttonPressCount を 1 つ進める
   */
  function applyLine(line: string): void {
    let state: AlarmDeviceState['state'] | null = null
    let cause = 'none'
    for (const token of line.split(' ')) {
      if (token.startsWith('state=')) state = token.slice(6) as AlarmDeviceState['state']
      else if (token.startsWith('cause=')) cause = token.slice(6)
    }
    if (!state) return
    const prev = deviceState.value
    deviceState.value = { state, cause }
    if (prev?.state === 'alarming' && prev.cause === 'call' && state === 'muted' && cause === 'call') {
      buttonPressCount.value += 1
      log('button pressed while calling')
    }
  }

  /**
   * 状態行だけを畳む (機種識別ではなく、状態行の振り分けにだけ使う。機種識別は `DEVICE alarm` を
   * 見る arbiter 側、Refs ippoan/alc-app#353)。行の途中に在っても拾い、見つけた位置から後ろだけを読む
   */
  function handleStateLine(line: string): void {
    const at = line.search(STATE_LINE)
    if (at >= 0) applyLine(line.slice(at))
  }

  /**
   * カードの行から、社員の照会に送る id を取り出す。採れない行は null:
   * IC カードは種類が知っている語で id が 16 進の 8〜20 桁のときだけ、免許証は交付日と
   * 有効期限の桁が合うときだけ (種類は行の末尾に在るので、途中で切れた行はここで落ちる)
   */
  function cardLookupId(line: string): string | null {
    const hit = CARD_LINE.exec(line)
    if (!hit) return null
    const args = line.slice(hit.index).split(' ')
    if (hit[1] === 'LICENSE') return licenseNfcId(evtArg(args, 'issue'), evtArg(args, 'expiry'))
    const cardId = evtArg(args, 'card_id')
    return CARD_KINDS.includes(evtArg(args, 'card_kind')) && CARD_ID.test(cardId) ? cardId : null
  }

  /** 接続後に届いた 1 行。状態行を畳み、カードの行なら合図を出す (id はログに出さない) */
  function handleLine(line: string): void {
    handleStateLine(line)
    const lookupId = cardLookupId(line)
    if (!lookupId) return
    cardRead.value = { seq: (cardRead.value?.seq ?? 0) + 1, lookupId }
    log('card read')
  }

  // --- heartbeat ---

  /**
   * 購読が切れた瞬間の時刻を覚える。heartbeat の周期 (3 秒) に丸めず切れた瞬間から
   * 数えるため、送信側ではなく state の変化で取る。component の scope に縛られないよう
   * 独立した effectScope に置く (呼び元の unmount で消えると数え直せなくなる)。
   */
  function installNgWatch(): void {
    if (ngWatchInstalled) return
    ngWatchInstalled = true
    effectScope(true).run(() => {
      watch(rooms.isWatching, (watching) => {
        ngSince = watching ? null : Date.now()
      }, { immediate: true, flush: 'sync' })
    })
  }

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

  /**
   * 今の状態を 1 行に畳む。`HB OK` / `HB NG signaling` に着信中だけ ` call=1` を足す。
   * 購読が切れていても NG_GRACE_MS 経つまでは `HB OK` (復旧すれば即 `HB OK` に戻る)。
   */
  function heartbeatLine(): string {
    const ngFor = ngSince === null ? 0 : Date.now() - ngSince
    const status = ngFor >= NG_GRACE_MS ? 'HB NG signaling' : 'HB OK'
    // 呼び出しに応答していない部屋が在る (遠隔点呼も IT点呼 も鳴らす)
    const calling = rooms.callingRooms.value.length > 0
    const line = calling ? `${status} call=1` : status
    if (line !== lastLine) {
      log(`heartbeat ${lastLine ?? '(start)'} -> ${line}`)
      lastLine = line
    }
    return line
  }

  async function sendHeartbeat(w: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
    const ok = await writeLine(w, heartbeatLine())
    // 書けなくなった = 抜線・クラッシュ → ポートを返して掴み直しへ
    if (!ok) {
      console.warn(`[ALARM-DEV] heartbeat write failed -> release port (+${msSinceLoad()}ms)`)
      await arbiter.release(CLAIMANT_NAME)
    }
  }

  /**
   * 接続中なら今の heartbeat に ` grace=45` を足した 1 行を送る。await しない・失敗は握る
   * (reload の直前なので、ポートを返す後始末は要らない)。送ったら true
   */
  function sendGrace(): boolean {
    // ファームの書き込み中 (錠) は送らない (イメージに混ざる)
    if (!held || otaLocked) return false
    void writeLine(held, `${heartbeatLine()} grace=${RELOAD_GRACE_SEC}`)
    log(`sent grace=${RELOAD_GRACE_SEC}`)
    return true
  }

  // --- arbiter に預けるハンドラ (機種識別は arbiter が `DEVICE alarm` で行う) ---

  const claimant: SerialClaimant = {
    onOpen(_port, _reader, w, lines) {
      held = w
      deviceInfo.value = findDeviceLine(lines)
      isConnected.value = true
      sessionStorage.setItem(RECONNECT_MARK_KEY, '1')
      log(`claimed port (probe lines=${lines.length})`)
      // プローブ中に来ていた行を畳む (`DEVICE ...` の名乗りそのものは状態行に
      // 当てはまらないので無視される)。**状態行だけ** — ここに混ざったカードの行は
      // 繋ぐ前のタッチなので合図にしない
      for (const line of lines) handleStateLine(line)
      // ファームの書き込み中 (錠) は何も送らない。`ota.end()` が heartbeat を始め直す
      if (otaLocked) return
      // `DEVICE` は名乗り専用で状態を持たないため、初期状態 (state=/cause=) を
      // ここで `STATUS` を 1 回撃って取る。応答は通常の onLine 経由で handleLine に届く
      // (次の `EVT ALARM` の定期送信 (5 秒ごと) を待たない、Refs ippoan/alc-app#353)
      void writeLine(w, 'STATUS')
      startHeartbeat(w)
    },

    onLine: handleLine,

    onClose() {
      held = null
      lastLine = null
      isConnected.value = false
      deviceState.value = null
      deviceInfo.value = null
      stopHeartbeat()
      log('port closed')
    },
  }

  // --- 公開 API ---

  /**
   * 探索を始める。`delay` ミリ秒待って最初のスキャン、以後 10 秒ごとに再スキャン。
   * BLE ゲートウェイと同居しない管理者 PC では 0 を渡してすぐ探してよい。
   * reload の直前まで握っていた印 (sessionStorage) があれば delay を待たず即スキャンする。
   */
  function connect(delay = INITIAL_SCAN_DELAY): void {
    if (!isSupported) return
    installNgWatch()
    const resumed = sessionStorage.getItem(RECONNECT_MARK_KEY) === '1'
    sessionStorage.removeItem(RECONNECT_MARK_KEY)
    const scanDelay = resumed ? 0 : delay
    log(`connect(delay=${scanDelay}${resumed ? ', resumed after reload' : ''})`)
    arbiter.register(CLAIMANT_NAME, claimant)
    arbiter.start(scanDelay)
  }

  /**
   * WebSerial の初回許可 (ユーザー操作が要る) → 許可されたら探索を始める。
   * ボタンを押した直後に待たせると「接続にならない」と見えるので 0 で始める。
   */
  async function requestPort(): Promise<void> {
    const granted = await arbiter.requestPort()
    if (granted) connect(0)
  }

  /** 明示的な切断。再接続の印も消す (次の page load で即スキャンしない) */
  async function disconnect(): Promise<void> {
    log('disconnect()')
    sessionStorage.removeItem(RECONNECT_MARK_KEY)
    await arbiter.unregister(CLAIMANT_NAME)
  }

  /**
   * 意図した reload の直前に呼ぶ。握っている警告デバイスと CoreS3 の両方へ
   * ` grace=45` 付きの heartbeat を送り、reload 中の沈黙で鳴らさないよう頼む。
   * 何も握っていなければ何もしない。await しない (reload を止めない)。
   */
  function notifyIntentionalReload(): void {
    sendGrace()
    useCoreS3Serial().sendGrace()
  }

  /**
   * 1 行送って応答 1 つを待つ (#214 の警告デバイス認証で使用)。
   * 実体は arbiter 側 (useSerialArbiter.request) — 警告デバイスが預かっているポートに送る
   * (useCoreS3Serial.request と同型)。ファームの書き込み中 (錠) は送らずに reject する。
   */
  function request(line: string, matchPrefix: string, timeoutMs: number): Promise<string> {
    if (otaLocked) return Promise.reject(new Error(OTA_LOCKED_MESSAGE))
    return arbiter.request(CLAIMANT_NAME, line, matchPrefix, timeoutMs)
  }

  // --- ファームの書き込みだけが使う口 (Refs ippoan/alc-app#425。形は useCoreS3Serial の `ota` と同じ) ---

  /** 錠を掛け、heartbeat を止める。以後 `otaEnd()` まで、機体へ届くのは `otaRequest` と `otaRest` だけ */
  function otaBegin(): void {
    otaLocked = true
    stopHeartbeat()
  }

  /**
   * 錠を解く。繋がっていれば heartbeat を始め直す (grace の無い `HB OK` を即 1 本 + 3 秒ごと。
   * 機体の見張りは通常の 10 秒に戻る)。未接続なら何もしない (次の onOpen が始める)。
   * 掛かっていないときに呼んだら何もしない (走っている heartbeat に触らない)
   */
  function otaEnd(): void {
    if (!otaLocked) return
    otaLocked = false
    if (held) startHeartbeat(held)
  }

  /**
   * 錠に関係なく、行またはバイト列を送って応答 1 つを待つ (`useCoreS3Serial().ota.request` と同じ形)。
   * 失敗側の合図が `ERR <先頭トークン>` の形でないときは `errPrefix` で明示する
   */
  function otaRequest(line: string, matchPrefix: string, timeoutMs: number, errPrefix?: string): Promise<string>
  function otaRequest(bytes: Uint8Array, matchPrefix: string, timeoutMs: number, errPrefix: string): Promise<string>
  function otaRequest(payload: string | Uint8Array, matchPrefix: string, timeoutMs: number, errPrefix?: string): Promise<string> {
    // 実装側の引数は union なので、arbiter のどちらの overload にも当てはまるよう
    // バイト列 overload (errPrefix 必須) の形に寄せて渡す
    return arbiter.request(CLAIMANT_NAME, payload as Uint8Array, matchPrefix, timeoutMs, errPrefix as string)
  }

  /**
   * 書き込みの間、機体の見張りを休ませる: `HB OK grace=120` を 1 行書く (機体は返信しない)。
   * **1 回の更新につき 1 回だけ呼ぶこと** — 猶予は機体側で 1 行ごとに置き換わる。
   * 未接続なら何もしない。書けなくても握る (次の `OTA SERIAL` の応答で分かる)
   */
  async function otaRest(): Promise<void> {
    if (held) await writeLine(held, `HB OK grace=${OTA_GRACE_SEC}`)
  }

  return {
    isSupported,
    isConnected: readonly(isConnected),
    deviceState: readonly(deviceState),
    buttonPressCount: readonly(buttonPressCount),
    cardRead: readonly(cardRead),
    deviceInfo: readonly(deviceInfo),
    connect,
    disconnect,
    requestPort,
    notifyIntentionalReload,
    request,
    ota: { begin: otaBegin, end: otaEnd, request: otaRequest, rest: otaRest },
  }
}
