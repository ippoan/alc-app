/**
 * キオスクが USB でつながった端末をシリアル経由で更新する (シリアル OTA、
 * Refs ippoan/alc-app-s3#279, ippoan/alc-app#403)。
 *
 * 対象は 3 種 ({@link RUNNABLE_TARGETS}):
 *
 * - **Vein Station** (`timecard-station`): Atom VoiceS3R の `atoms3-timecard` `station` ビルド。
 *   LAN も Wi-Fi も持たず、USB で運行者 PC につながっている。管理者が /device/setup で
 *   「最新にする」を押すと合図が出る。受けは `TenkoKiosk.vue`
 * - **CoreS3** (`cores3`): 統合ハブ。管理者が 1 台を指定して合図を出す。受けは
 *   `FirmwareOtaHost.vue`。画面の前の人が帯 (`CoreS3DeviceFirmwareNotice.vue`) から押しても始まる
 * - **警告デバイス** (`alarm`): 運行管理者 / IT点呼 の席の PC に繋がる Atom VoiceS3R。合図は無く、
 *   画面の前の人が帯 (`AlarmDeviceFirmwareNotice.vue`) から押したときだけ始まる (Refs ippoan/alc-app#425)
 *
 * 合図は、recorder がキオスクの購読 WS (`useTimecardWatch`) に `{"type":"serial_ota","target":…}` を
 * 送るもの。どの入口でも、ここで Pages から版とイメージを取り、Web Serial で動作中の端末の app へ
 * 流し込む。**送受信の手順 ({@link flash}) は 1 つ**で、target で変わるのは「どのポートで話すか」と、
 * CoreS3 と警告デバイスの前後の手当て (下) だけ。
 *
 * # 契約 (端末側は alc-app-s3 の firmware。行は `OTA ` で始まるものだけを見る)
 *
 * 1. `OTA SERIAL <size> <flavor>` → `OTA READY <chunk>` / `OTA ERR <reason>`
 * 2. 生のバイト列を `<chunk>` ずつ。**`OTA ACK <累計>` を受けてから次を送る**
 * 3. 最後のチャンクの後は `complete()` (検証) の結果 `OTA OK` / `OTA ERR verify`。
 *    `OTA OK` の約 500 ms 後に端末は再起動する
 * 4. 再接続後に `DEVICE` → `DEVICE <kind> VER=<ver> FLAVOR=<flavor>`。
 *    FLAVOR が期待どおりなら `OTA CONFIRM` → `OTA CONFIRMED`
 *    (10 分以内に確定しなければ端末は元のスロットへ戻る)
 *
 * # 何を信じるか
 *
 * - **URL と版はメッセージから受け取らない。** 合図は `target` の語 (と CoreS3 の `device_id`)
 *   だけで、URL はこのファイルに無く、`utils/firmware-targets.ts` の表 ({@link FIRMWARE_TARGETS})
 *   から引く。表に無い target は無視する。この composable が実行するのは
 *   {@link RUNNABLE_TARGETS} に在るものだけ
 * - **VER は「更新するか」の判定にだけ使う。確定の条件は FLAVOR だけ。** Pages は CDN の
 *   max-age が 600 秒で、反映直後は manifest とイメージが一時的に食い違うことがあるため
 *   (manifest の版とイメージの中身がずれても、焼いたものが同じ機種のビルドなら確定してよい)
 *
 * # ポート
 *
 * Vein Station は `useVeinSerial` (claimant `timecard`)、CoreS3 は `useCoreS3Serial().ota`、
 * 警告デバイスは `useAlarmDevice().ota` が握っているものを借りる。2 本目の claimant も reader も立てない。
 *
 * # CoreS3 だけの手当て (順番を変えない)
 *
 * CoreS3 のポートには、書き込みと無関係な送信 (ハートビート・`STAGE`・署名の要求・診断の返信) が
 * 常に流れている。機体は `OTA SERIAL` の後、受けたバイトを全部イメージとして読むので、
 * 1 行でも混ざるとイメージが壊れる。
 *
 * 1. **宛先の照合**: 合図の `device_id` が、実行時の自分の機体の id
 *    (`useFirmwareReport().deviceId`) と一致するときだけ進む。無い・不一致・自分の id が未取得
 *    なら何もしない (recorder は合図を全キオスクへ配る — 照合するのはここだけ)
 * 2. 照合で対象外と分かったら、管理者の一覧へ `skipped` を報告するだけ (幕は出さない)
 * 3. 取得の前に待機の報告を保留 (`hold()`)。取得の後、**始める直前に「機体を使用中」を聞き直し**、
 *    使用中なら始めずに預け直す
 * 4. `ota.begin()` (錠) → `HB OFF` → `OTA SERIAL` → チャンク → `OTA OK` →
 *    **再起動を待つ前に `ota.end()`**。錠を掛けたまま再接続すると、端末の token の取り直しの
 *    署名が reject され、以後の報告とキオスクの端末 token が落ちる。**錠の間の報告は await しない**
 *    (報告は token の取得と POST を伴い、機体の 10 秒の無受信に掛かりうる)
 * 5. 再起動後は **`await report('confirming')` を先に** (中で走る署名の要求を待ち切る。報告が
 *    固まっても機体の確定を逃さないよう、30 秒で打ち切って先へ進む) →
 *    `AUTH STATUS` で id を聞き直し、始めたときと違えば `OTA CONFIRM` を送らない (差し替えの検出) →
 *    `DEVICE` → `OTA CONFIRM`。この 3 つは「既に応答待ち」の reject のときだけ間を置いて再試行する
 * 6. 終わりは必ず `running = false` → `ota.end()` → `release()` の順。`release()` は `idle` を
 *    送らない (一覧に結果を残す)。預け直したときだけ、結果の報告が無いので `idle` を 1 回送る
 *
 * # 警告デバイスだけの手当て (順番を変えない、Refs ippoan/alc-app#425)
 *
 * 警告デバイスのポートには、3 秒ごとの heartbeat と席の署名の要求 (`AUTH SIGN`) が流れている。
 * 機体は heartbeat が 10 秒途絶えると鳴る (席の見張り)。宛先の照合と報告は無い
 * (USB で繋がっている 1 台が相手。登録簿の id を持たない機体)。
 *
 * 1. 名乗り → FLAVOR の照合 → 版が同じなら `up_to_date`。イメージの取得 → 始める直前の
 *    「使用中」の聞き直し。**ここまでは幕を出さない** (取得の失敗も `busy`)
 * 2. `ota.begin()` (錠) → **受け口の有無の探り** `OTA CONFIRM`。受け口の在る版は確定待ちが無くても
 *    `OTA CONFIRMED` を返す (冪等。確定待ちが在ればそこで確定するが、直後の `OTA SERIAL` も
 *    スロットを開く前に同じ確定をするので結果は変わらない)。受け口の無い版は `ERR UNSUPPORTED` →
 *    結果 `unsupported` (配布ページからの 1 回の書き直しを案内する)。どちらも来なければ `busy`
 * 3. **見張りを休ませる**: `ota.rest()` (`HB OK grace=120` を 1 行)。**`HB OFF` は使わない** —
 *    武装ごと消え、途中でタブを閉じると次の heartbeat まで鳴らなくなる。grace は 1 回の更新に
 *    1 行だけで、期限が来れば機体が自分で見張りに戻る。ここから幕を出す
 * 4. `OTA SERIAL` → チャンク → `OTA OK` → **再起動を待つ前に `ota.end()`** (錠を掛けたまま
 *    再接続すると、席の署名が reject される)。heartbeat はここで戻る
 * 5. 再起動後の `DEVICE` → `OTA CONFIRM` は、CoreS3 と同じく「既に応答待ち」のときだけ再試行する
 * 6. `ota.end()` は全出口で走る (`finally`)。更新を押すことで見張りを長く止める経路は無い
 *
 * 席の見張り (`useAlarmWatch`) は変えていない: 再起動は「切断」と数えられ、繋がり直せば消える。
 *
 * # 受容している制約 (直さない)
 *
 * - 錠の間 (`HB OFF` 〜 `OTA OK`) に出た `STAGE` / `RESULT` は捨てられる。再起動した場合は
 *   再接続時に直近の STAGE が送り直されるが、再起動しない失敗の経路では、次に段が変わるまで
 *   機体の画面が古い段のまま残りうる (更新は待機中にしか始めない)
 * - `HB OFF` の後にタブを閉じる / リロードすると、機体は 10 秒で `OTA ERR timeout` → 元の版のまま。
 *   沈黙警告は、次にページが開いて `HB OK` を送るまで外れたまま
 * - 未接続の間の `failed` の報告は送れない (報告は未接続で黙って戻る)
 * - 錠の間 (30〜60 秒) に端末の token が取り直しの時期に入ると、その署名の要求が錠で reject され、
 *   60 秒の抑止に入る。その回は再起動後の報告が落ち、一覧は次の 5 分の周期で正しくなる
 *   (更新そのものは成功する)
 * - 始める直前の再確認でも塞ぎ切れない隙が在る: イメージの取得が、カードを読み取った直後の通信より
 *   速く終わると、画面の段が待機のまま再確認を通過して始まる。害は、乗務員の画面が 1〜2 分
 *   「更新中」の幕で覆われること (イメージは壊れない)
 * - 更新の実行は 1 台の PC で 1 本 (`running` は共有)。CoreS3 の更新中に来た Vein Station の合図
 *   (逆も) は黙って捨てられる
 * - 配布ページの URL の表は、auth-worker の `DEVICE_KINDS` (別 repo) と 2 か所に在る
 * - 結果の幕 (5 秒) が出ている間に次の合図が来て、更新が要るかを調べる段で例外になると、
 *   「失敗の幕 + `failed` の報告」になる (画面に出さない判定が「state が idle か」のため)
 */

import { parseDeviceLine } from '~/utils/device-line'
import { FIRMWARE_TARGETS } from '~/utils/firmware-targets'
import type { FirmwareTarget } from '~/utils/firmware-targets'
import type { FirmwarePhase } from '~/utils/api'
import type { FirmwareReportExtra } from '~/composables/useFirmwareReport'

/** CoreS3 の target。ポートと前後の手当て (冒頭 doc) がこの target だけ違う */
const HUB_TARGET = 'cores3'
/** 警告デバイスの target。ポートと前後の手当て (冒頭 doc) がこの target だけ違う */
const ALARM_TARGET = 'alarm'

/**
 * この composable が実行できる target。表 ({@link FIRMWARE_TARGETS}) に載っていても、
 * 話すポートを持たない target は走らせない (Refs ippoan/alc-app#403)
 */
const RUNNABLE_TARGETS: readonly string[] = ['timecard-station', HUB_TARGET, ALARM_TARGET]

/** 実行できる target の表の行。実行できない target (表に無いものを含む) は null */
function runnableTarget(target: string): FirmwareTarget | null {
  return RUNNABLE_TARGETS.includes(target) ? FIRMWARE_TARGETS[target]! : null
}

/** これ未満のイメージは壊れている (Pages の 404 ページ等) とみなして書かない */
export const MIN_IMAGE_BYTES = 256 * 1024

/** manifest / イメージの取得の上限。固まった取得で「更新中」のまま残らないように */
const FETCH_TIMEOUT_MS = 60_000
/** `DEVICE` の応答待ち */
const DEVICE_TIMEOUT_MS = 5_000
/** `OTA SERIAL` → `OTA READY`。端末は esp_ota_begin でイメージ長ぶんを消去するので長めに待つ */
const BEGIN_TIMEOUT_MS = 60_000
/** 1 チャンク → `OTA ACK`。端末側の無受信タイムアウト (10 秒) より長くして、端末の ERR を先に受ける */
const ACK_TIMEOUT_MS = 15_000
/** 最後のチャンク → `OTA OK` (イメージの検証を含む) */
const VERIFY_TIMEOUT_MS = 60_000
/** `OTA OK` → 再接続。ポートの探索は 10 秒ごとに再スキャンする */
const RECONNECT_TIMEOUT_MS = 90_000
/** `OTA CONFIRM` → `OTA CONFIRMED` */
const CONFIRM_TIMEOUT_MS = 10_000
/** `HB OFF` → `OK HB OFF` (CoreS3 だけ) */
const HB_OFF_TIMEOUT_MS = 5_000
/** 受け口の有無の探り (`OTA CONFIRM`) の応答待ち (警告デバイスだけ) */
const PROBE_TIMEOUT_MS = 5_000
/** 再起動後の `AUTH STATUS` の応答待ち (CoreS3 だけ) */
const AUTH_STATUS_TIMEOUT_MS = 3_000
/** 再起動後の `confirming` の報告を待つ上限 (CoreS3 だけ)。機体は確定を 10 分しか待たない */
const CONFIRMING_REPORT_TIMEOUT_MS = 30_000
/** 再起動後の要求が「既に応答待ち」で弾かれたときの再試行の間隔と、合計の上限 (CoreS3 と警告デバイス) */
const BUSY_RETRY_INTERVAL_MS = 2_000
const BUSY_RETRY_TOTAL_MS = 60_000
/** 結果 (done / failed) を画面に出しておく時間 */
export const RESULT_DISPLAY_MS = 5_000

/** 失敗行の接頭辞 (`OTA ERR <reason>`)。`ERR <先頭トークン>` の形ではないので明示する */
const OTA_ERR = 'OTA ERR'
/** 受け口を持たない版の機体が返す行の始まり (`ERR UNSUPPORTED (<機種>)`) */
const ERR_UNSUPPORTED = 'ERR UNSUPPORTED'

/**
 * {@link useSerialOta} の `run()` の結果 (Refs ippoan/alc-app#425)。画面の前の人が押した更新の
 * 結果を帯 (`DeviceFirmwareNotice.vue`) が出し分けるための語で、幕 (`state`) とは別に返す。
 *
 * - `updated` = 書き込み・再起動・確定まで済んだ
 * - `up_to_date` = 機体の版が配布中の版と同じ
 * - `busy` = 機体に書き込みを始められなかった (別の更新が走っている・機体が使用中で預けた・
 *   機体やポートに断られた・配布中の版や機体の名乗りを読めなかった)。機体は元のまま動いている
 * - `skipped` = 対象の機体でない (実行できない target・未接続・id の不一致や未取得・BOARD / FLAVOR が表に無い)
 * - `unsupported` = 機体の版が、画面からの更新の受け口をまだ持たない (警告デバイスだけ)。
 *   機体は元のまま動いている。配布ページから 1 回書き直せば、以後は画面から更新できる
 * - `failed` = 失敗の幕 (「更新できませんでした」) が出た回。**幕が出ないまま終わった失敗は `failed` にしない**
 */
export type SerialOtaResult = 'updated' | 'up_to_date' | 'busy' | 'skipped' | 'unsupported' | 'failed'

/** CoreS3 の更新に要る引数 (Vein Station は渡さない) */
export interface SerialOtaRunOptions {
  /** 合図の `device_id`。実行時の自分の機体の id と一致するときだけ書く */
  deviceId?: string
  /** 「機体を使用中」か。イメージを取った後、始める直前にもう一度聞く */
  isBusy?: () => boolean
}

/** 書き込みに使うポート (`useVeinSerial()` / `useCoreS3Serial().ota` / `useAlarmDevice().ota` のどれか) */
interface OtaPort {
  isConnected: Readonly<Ref<boolean>>
  request: {
    (line: string, matchPrefix: string, timeoutMs: number, errPrefix?: string): Promise<string>
    (bytes: Uint8Array, matchPrefix: string, timeoutMs: number, errPrefix: string): Promise<string>
  }
}

/** 失敗の理由。`word` は管理者の一覧へ報告する短い固定の語 */
class OtaError extends Error {
  constructor(message: string, readonly word: string) {
    super(message)
  }
}

/**
 * 報告に載せる失敗の語。機体が断った (`OTA ERR <語>`) ならその語、こちらで決めた失敗は
 * {@link OtaError} の語、それ以外 (応答の時間切れ・ポートを失った) は `no_response`
 */
function failureWord(e: unknown): string {
  if (e instanceof OtaError) return e.word
  const m = /^OTA ERR (\S{1,64})/.exec((e as Error).message)
  return m ? m[1]! : 'no_response'
}

/**
 * ポートがほかの要求の応答待ちで、こちらの要求を送らずに弾いたか。判定は useSerialArbiter.ts の
 * reject 文言 (`request(<name>): 既に応答待ちです`) の部分一致 (DeviceSettings.vue と同じ)。
 * 文言を変えたらここも合わせること
 */
function isPortBusy(e: unknown): boolean {
  return String(e).includes('既に応答待ちです')
}

export type SerialOtaState =
  | { kind: 'idle' }
  | { kind: 'downloading' }
  | { kind: 'writing', pct: number }
  | { kind: 'rebooting' }
  | { kind: 'confirming' }
  | { kind: 'done', ver: string }
  | { kind: 'failed', reason: string }

// シングルトン: 1 台の PC で同時に走る OTA は 1 本
const state = ref<SerialOtaState>({ kind: 'idle' })
let running = false
let resultTimer: ReturnType<typeof setTimeout> | null = null

export function useSerialOta() {
  const vein = useVeinSerial()
  const coreS3 = useCoreS3Serial()
  const alarmDevice = useAlarmDevice()
  const firmware = useFirmwareReport()
  const hubPort: OtaPort = { isConnected: coreS3.isConnected, request: coreS3.ota.request }
  const alarmPort: OtaPort = { isConnected: alarmDevice.isConnected, request: alarmDevice.ota.request }
  /**
   * 始めてよくなる (待機画面へ戻る・機体が空く) のを待っている合図。呼び出し元 (合図の受け)
   * ごとに持つ — 画面が外れたら一緒に捨てる (管理者が押し直す)
   */
  let queued: { target: string, opts: SerialOtaRunOptions } | null = null

  /** 配布ページから取る。失敗 (HTTP・時間切れ・本文の読み取り) は報告の語 `download` にまとめる */
  async function download<T>(url: string, read: (res: Response) => Promise<T>): Promise<T> {
    try {
      const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await read(res)
    }
    catch (e) {
      throw new OtaError((e as Error).message, 'download')
    }
  }

  /** 接続の有無が `want` になるのを `deadline` (Date.now() の値) まで待つ */
  function waitForConnected(port: OtaPort, want: boolean, deadline: number): Promise<boolean> {
    if (port.isConnected.value === want) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      // 真偽値なので、変わった時点で `want` になっている
      const stop = watch(port.isConnected, () => finish(true), { flush: 'sync' })
      const timer = setTimeout(() => finish(false), deadline - Date.now())
      function finish(ok: boolean): void {
        clearTimeout(timer)
        stop()
        resolve(ok)
      }
    })
  }

  /** `OTA OK` の後、いったん切れてからつながり直すのを待つ */
  async function waitForReconnect(port: OtaPort): Promise<boolean> {
    const deadline = Date.now() + RECONNECT_TIMEOUT_MS
    return await waitForConnected(port, false, deadline) && await waitForConnected(port, true, deadline)
  }

  /**
   * 1 行送って応答を待つ。ポートがほかの要求の応答待ちで弾いたときだけ、間を置いて送り直す
   * (`deadline` まで)。機体が断った・時間切れは送り直さない
   */
  async function requestWhenFree(
    port: OtaPort,
    deadline: number,
    line: string,
    matchPrefix: string,
    timeoutMs: number,
    errPrefix?: string,
  ): Promise<string> {
    for (;;) {
      try {
        return await port.request(line, matchPrefix, timeoutMs, errPrefix)
      }
      catch (e) {
        if (!isPortBusy(e)) throw e
        if (Date.now() + BUSY_RETRY_INTERVAL_MS > deadline) throw new OtaError((e as Error).message, 'busy')
        await new Promise(resolve => setTimeout(resolve, BUSY_RETRY_INTERVAL_MS))
      }
    }
  }

  /** 結果を数秒出してから idle に戻す */
  function settle(next: SerialOtaState): void {
    state.value = next
    if (resultTimer) clearTimeout(resultTimer)
    resultTimer = setTimeout(() => {
      resultTimer = null
      state.value = { kind: 'idle' }
    }, RESULT_DISPLAY_MS)
  }

  /**
   * 機体が「いまは受けられない」と答えた (CoreS3 だけ)。失敗の幕にせず、錠を解いてから
   * 一覧へ `skipped` を出す (報告は端末の token を取りに行くので、錠より後)
   */
  function skipBusy(): SerialOtaResult {
    coreS3.ota.end()
    state.value = { kind: 'idle' }
    void firmware.report('skipped', { reason: 'busy' })
    return 'busy'
  }

  /**
   * `hubId` は CoreS3 のときだけ、書き込みを始める機体の id (合図の `device_id` と照合済み)。
   * Vein Station と警告デバイスは null — 報告も id の確認もしない (錠は警告デバイスにも在る)
   */
  async function flash(
    target: string,
    entry: FirmwareTarget,
    port: OtaPort,
    opts: SerialOtaRunOptions,
    hubId: string | null,
  ): Promise<SerialOtaResult> {
    const hub = hubId !== null
    const alarm = target === ALARM_TARGET
    /** 管理者の一覧へ遷移を出す (CoreS3 だけ)。**await しない** */
    const tell = (phase: FirmwarePhase, extra: FirmwareReportExtra): void => {
      if (hub) void firmware.report(phase, extra)
    }

    // 更新が要るかは画面に出さずに調べる (最新のキオスクで毎回画面が点滅しないように)
    const device = parseDeviceLine(await port.request('DEVICE', 'DEVICE ', DEVICE_TIMEOUT_MS))
    if (entry.boards && (device.board === null || !entry.boards.includes(device.board))) {
      tell('skipped', { reason: 'unsupported' })
      return 'skipped'
    }
    // station 以外 (vein 等) がつながっているキオスクは対象外。
    // 以後の `OTA SERIAL` と再起動後の照合には、機体が名乗った FLAVOR を使う
    const flavor = device.flavor
    if (flavor === null || !Object.hasOwn(entry.flavors, flavor)) {
      tell('skipped', { reason: 'flavor_mismatch' })
      return 'skipped'
    }
    const source = entry.flavors[flavor]!
    const manifest = await download(source.manifestUrl, res => res.json() as Promise<{ version?: unknown }>)
    if (typeof manifest.version !== 'string') throw new Error('manifest has no version')
    if (manifest.version === device.ver) {
      tell('skipped', { reason: 'up_to_date' })
      return 'up_to_date'
    }
    const progress = { target_version: manifest.version }

    // ここから終わりまで、待機の報告 (idle) で一覧の「更新中」を上書きしない
    if (hub) firmware.hold()
    // 警告デバイスは、受け口の有無が分かるまで幕を出さない (下の探り)
    if (!alarm) state.value = { kind: 'downloading' }
    tell('downloading', progress)
    const image = new Uint8Array(await download(source.appUrl, res => res.arrayBuffer()))
    if (image.length < MIN_IMAGE_BYTES) throw new OtaError(`image too small (${image.length} B)`, 'image_too_small')

    // 取っている数秒の間に画面が進んでいたら、始めずに預け直す (空いたときに受けがもう一度走らせる)
    if (opts.isBusy?.()) {
      queued = { target, opts }
      state.value = { kind: 'idle' }
      // 結果の報告が無い経路なので、一覧の「更新中」(downloading) を待機へ戻しておく
      firmware.release()
      tell('idle', {})
      return 'busy'
    }

    if (hub) {
      // ここから `ota.end()` まで、CoreS3 へのほかの送信が止まる
      coreS3.ota.begin()
      try {
        await port.request('HB OFF', 'OK HB OFF', HB_OFF_TIMEOUT_MS)
      }
      catch (e) {
        if (isPortBusy(e)) return skipBusy()
        // `ERR …`・無応答は先へ進む (次の `OTA SERIAL` で分かる)
      }
    }

    if (alarm) {
      // ここから `ota.end()` まで、警告デバイスへのほかの送信 (heartbeat・席の署名) が止まる
      alarmDevice.ota.begin()
      try {
        // 受け口の有無の探り。受け口の在る版は、確定待ちが無くても `OTA CONFIRMED` を返す
        await port.request('OTA CONFIRM', 'OTA CONFIRMED', PROBE_TIMEOUT_MS, ERR_UNSUPPORTED)
      }
      catch (e) {
        if ((e as Error).message.includes(ERR_UNSUPPORTED)) return 'unsupported'
        // 時間切れ・「既に応答待ち」・ポートを失った。幕を出していないので、呼び手 (run) が `busy` にする
        throw e
      }
      // 受け口が在ると分かった。書き込みの間、機体の見張りを休ませる (1 回の更新につき 1 行だけ)
      await alarmDevice.ota.rest()
      state.value = { kind: 'downloading' }
    }

    let ready: string
    try {
      ready = await port.request(`OTA SERIAL ${image.length} ${flavor}`, 'OTA READY', BEGIN_TIMEOUT_MS, OTA_ERR)
    }
    catch (e) {
      // 機体が測定の画面の間・別の OTA 中
      if (hub && (e as Error).message.startsWith(`${OTA_ERR} busy`)) return skipBusy()
      throw e
    }
    state.value = { kind: 'writing', pct: 0 }
    // pct は報告しない (遷移だけ)。幕の % は state で出す
    tell('writing', progress)
    const chunk = Number.parseInt(ready.slice('OTA READY'.length).trim(), 10)
    if (!(chunk > 0)) throw new OtaError(`bad chunk size (${ready})`, 'bad_chunk')

    for (let sent = 0; sent < image.length;) {
      const end = Math.min(sent + chunk, image.length)
      const bytes = image.subarray(sent, end)
      if (end < image.length) {
        // ACK を受けてから次を送る (端末の flash 書き込みを追い越さない)
        const ack = await port.request(bytes, 'OTA ACK', ACK_TIMEOUT_MS, OTA_ERR)
        const acked = Number.parseInt(ack.slice('OTA ACK'.length).trim(), 10)
        if (acked !== end) throw new OtaError(`ack mismatch (${acked} != ${end})`, 'ack_mismatch')
      }
      else {
        // 最後のチャンクは ACK の後に検証の結果が来る。ACK を待って登録し直すと、同じ読み取りに
        // 入った `OTA OK` を取りこぼしうるので、最初から `OTA OK` を待つ
        await port.request(bytes, 'OTA OK', VERIFY_TIMEOUT_MS, OTA_ERR)
      }
      sent = end
      state.value = { kind: 'writing', pct: Math.floor((sent * 100) / image.length) }
    }

    // 再起動を待つ前に錠を解く。掛けたままだと、再接続直後の端末の token の取り直しの署名
    // (警告デバイスは席の署名) が reject される。未接続なら何も送らず、次の接続がハートビートを始める
    if (hub) coreS3.ota.end()
    if (alarm) alarmDevice.ota.end()

    state.value = { kind: 'rebooting' }
    tell('rebooting', progress)
    if (!(await waitForReconnect(port))) throw new OtaError('reconnect timeout', 'reconnect_timeout')

    state.value = { kind: 'confirming' }
    let ask: (line: string, matchPrefix: string, timeoutMs: number, errPrefix?: string) => Promise<string> = port.request
    if (hub) {
      // 機体へ聞く前に待ち切る: 再起動で端末の token は捨てられており、報告の中の取り直しが
      // 機体への署名の要求を走らせる。先に聞くと、こちらの応答待ちが署名を reject させる。
      // 報告 (POST) が固まっても確定を逃さないよう、上限で打ち切って先へ進む
      await Promise.race([
        firmware.report('confirming', progress),
        new Promise(resolve => setTimeout(resolve, CONFIRMING_REPORT_TIMEOUT_MS)),
      ])
      const deadline = Date.now() + BUSY_RETRY_TOTAL_MS
      ask = (...args) => requestWhenFree(port, deadline, ...args)
      // 再起動を待っている間に別の機体へ差し替えられていたら確定しない
      // (`OTA CONFIRM` は冪等で、別の機体に届いても `OTA CONFIRMED` が返る)
      const id = parseAuthStatusLine(await ask('AUTH STATUS', 'AUTH ', AUTH_STATUS_TIMEOUT_MS))
      if (id !== hubId) throw new OtaError('device changed after reboot', 'device_changed')
    }
    else if (alarm) {
      // このポートには席の署名の要求が流れる。「既に応答待ち」のときだけ間を置いて送り直す
      const deadline = Date.now() + BUSY_RETRY_TOTAL_MS
      ask = (...args) => requestWhenFree(port, deadline, ...args)
    }
    const after = parseDeviceLine(await ask('DEVICE', 'DEVICE ', DEVICE_TIMEOUT_MS))
    // 確定の条件は FLAVOR だけ (VER は Pages の食い違いがありうるので見ない)。
    // 確定しなければ端末は 10 分後に元のスロットへ戻る
    if (after.flavor !== flavor) {
      throw new OtaError(`flavor mismatch after reboot (${after.flavor})`, 'flavor_mismatch')
    }
    await ask('OTA CONFIRM', 'OTA CONFIRMED', CONFIRM_TIMEOUT_MS, OTA_ERR)
    tell('done', progress)
    settle({ kind: 'done', ver: after.ver ?? '' })
    return 'updated'
  }

  /**
   * target の端末を更新し、結果を返す。実行できない target ({@link RUNNABLE_TARGETS} に無い)・
   * 端末がつながっていない・別の OTA が走っている、のどれかなら何もしない。
   * CoreS3 は加えて、`opts.deviceId` が実行時の自分の機体の id と一致しなければ何もしない
   * (無い・自分の id がまだ取れていない、も同じ)。警告デバイスに宛先の照合は無い。
   *
   * 戻り値 ({@link SerialOtaResult}) は「何が起きたか」を呼び手へ返すだけで、幕 (`state`)・報告・
   * 預かりの動きは変えない。合図の受け (`enqueue` / `runQueued` の呼び手) は捨ててよい。
   */
  async function run(target: string, opts: SerialOtaRunOptions = {}): Promise<SerialOtaResult> {
    const entry = runnableTarget(target)
    if (!entry) return 'skipped'
    if (running) return 'busy'
    const hub = target === HUB_TARGET
    const port = hub ? hubPort : target === ALARM_TARGET ? alarmPort : vein
    if (!port.isConnected.value) return 'skipped'
    // 宛先の照合 (冒頭 doc)。預けた後に機体が差し替えられた場合も、ここで弾く
    const hubId = hub ? firmware.deviceId.value : null
    if (hub && (hubId === null || opts.deviceId !== hubId)) return 'skipped'
    running = true
    try {
      return await flash(target, entry, port, opts, hubId)
    }
    catch (e) {
      const reason = (e as Error).message
      // 更新が要るかを調べている段階 (idle のまま) で失敗したときは画面に出さない
      if (state.value.kind === 'idle') {
        console.warn(`[SERIAL_OTA] skipped: ${reason}`)
        // 機体には何も書いていない (名乗りや配布中の版を読めなかった)。失敗の幕も出していないので
        // `failed` にしない — 書き直しを案内するほどのことではなく、押し直せば済む
        return 'busy'
      }
      settle({ kind: 'failed', reason })
      if (hub) {
        // 報告は端末の token を取りに行くので、錠を解いてから
        coreS3.ota.end()
        void firmware.report('failed', { reason: failureWord(e) })
      }
      return 'failed'
    }
    finally {
      // この順を変えない。`end()` は錠が掛かっていなければ、`release()` は保留していなければ
      // 何もしないので、無条件に呼ぶ (警告デバイスの錠も、どの出口でもここで必ず解ける)
      running = false
      coreS3.ota.end()
      alarmDevice.ota.end()
      firmware.release()
    }
  }

  /**
   * 合図を受けたが今は実行できない (点呼・打刻の途中) ときに預ける。
   * 実行できない target は預けない。`opts` は {@link runQueued} がそのまま {@link run} へ渡す
   */
  function enqueue(target: string, opts: SerialOtaRunOptions = {}): void {
    if (runnableTarget(target)) queued = { target, opts }
  }

  /** 預けた合図があれば走らせる (待機画面に戻った・機体が空いたときに呼ぶ) */
  async function runQueued(): Promise<void> {
    if (queued === null) return
    const { target, opts } = queued
    queued = null
    // 合図の受けは結果を使わない (幕と報告が伝える)
    await run(target, opts)
  }

  return {
    state: readonly(state),
    run,
    enqueue,
    runQueued,
  }
}
