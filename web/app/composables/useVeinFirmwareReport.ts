/**
 * キオスクが、USB で繋がっている指静脈端末 (Vein Station) の版・更新の状態をサーバへ報告する
 * (Refs ippoan/alc-app-s3#352)。CoreS3 の `useFirmwareReport` の指静脈版。
 *
 * 管理者の画面「端末のファーム」(`GET /api/firmware/devices`) は、この報告を一覧にして 1 台ずつ
 * 更新の合図を出す。報告が無い機体は一覧に現れないので、繋がったときと 5 分ごとに `idle` を送る。
 * ファームの更新中だけは `hold()` でこの待機の報告を保留し、終わったら `release()` で戻す
 * (`release()` 自身は何も送らない — 更新の結果 (done / failed / skipped) を `idle` で上書きしないため)。
 *
 * `useFirmwareReport` との違い:
 * - 端末の id は **端末の token の `sub`** から作る (`kioskDeviceIdFromJwt`。機体に `AUTH STATUS` を
 *   聞かない)。route (`/api/firmware/report`) も `kind: 'timecard'` の id を token から決め直すので、
 *   送る値は宛先の見分け ({@link useVeinFirmwareReport} の `deviceId`) と同じになる
 * - 版と flavor は接続時の名乗り (`useVeinSerial().deviceInfo`)
 *
 * **運行管理者席の Vein Base も報告する** (Refs ippoan/alc-app-s3#352)。席の Vein は「運行管理者席」の用途で
 * 登録され (1 つの鍵は 1 つの用途だけ)、キオスクの鍵は取れない。キオスクの鍵が取れなかったときだけ席の鍵
 * (`useManagerDeviceToken`) で取り、`scope: 'manager-device'` で送る。同じ機体で両方が取れることは無いので、
 * 同じ機体を 2 つの id で報告することは無い。席に VoiceS3R も繋がっていれば席の鍵は VoiceS3R の鍵で、id は
 * その鍵の id になる — 合図の受け (`ManagerSeatRemoteHost`) も同じ getter で自分の id を作るので食い違わない。
 *
 * # 繋がったら周期を待たずに送る (Refs ippoan/alc-app-s3#352、ユーザー指示「更新時に読み込む報告にして」)
 *
 * 画面を読み込んだ直後・Vein が繋がった直後に 1 回送る。5 分の周期はその後の送り直し。
 * - **名乗りが来ていない** (`deviceInfo` が null。読み込み直しても機体が再起動しないと接続時の
 *   名乗りの行が流れないことがある、2026-11-17 本番 8b47) ときは、機体に `DEVICE` を 1 回だけ
 *   問い合わせる (`useSerialOta` の名乗りの確認と同じ行・同じ解析。署名と重なって弾かれたら空くまで
 *   待つ)。それでも取れなければ**版不明のまま**送る (一覧から消えないように)
 * - **token がまだ取れていない**ときは {@link PENDING_RETRY_MS} ごとに取り直し、キオスクの鍵が取れた瞬間
 *   (`hasDeviceJwt`) にもすぐ送る。送れた時点で止める
 *
 * 機体に送るのは、名乗りが無いときの `DEVICE` の 1 行だけ。書き込み (`useSerialOta`) の間は送らない。
 */

import type { FirmwarePhase } from '~/utils/api'
import { reportFirmware } from '~/utils/api'
import { kioskDeviceIdFromJwt } from '~/utils/kiosk-remote'
import type { FirmwareReportExtra } from '~/composables/useFirmwareReport'
import { FIRMWARE_REPORT_INTERVAL_MS } from '~/composables/useFirmwareReport'
import { isSerialOtaRunning } from '~/composables/useSerialOta'
import type { DeviceLine } from '~/utils/device-line'
import { parseDeviceLine } from '~/utils/device-line'
import { requestWhenFree } from '~/utils/serial-request-when-free'

/** 接続時の報告を送れなかった (token がまだ無い) ときに取り直す間隔 */
export const PENDING_RETRY_MS = 15_000
/** `DEVICE` の応答待ち (useSerialOta と同じ) */
const DEVICE_TIMEOUT_MS = 5_000
/** `DEVICE` が署名と重なって弾かれたときの呼び直しの間隔と、待つ上限 */
const DEVICE_RETRY_INTERVAL_MS = 2_000
const DEVICE_RETRY_TOTAL_MS = 30_000

// シングルトン: 1 台の PC につながる Vein Station は 1 台
const deviceId = ref<string | null>(null)
let timer: ReturnType<typeof setInterval> | null = null
/** 保留中 (ファームの更新中)。待機の報告 (周期・繋がったとき) を送らない */
let onHold = false
let stopWatches: Array<() => void> = []
/** 名乗りが流れなかった機体に問い合わせて得た名乗り (切断で捨てる) */
const askedInfo = ref<DeviceLine | null>(null)
/** 接続時の待機の報告をまだ送れていない (token 待ち)。送れたら下ろす */
let pendingIdle = false
let retryTimer: ReturnType<typeof setInterval> | null = null
/** 繋がった時点で名乗りが無かった (後から名乗りが揃ったら、その版で送り直す) */
let infoMissingAtConnect = false
/** 走っている待機の報告 (重ねて送らない) */
let idleInFlight: Promise<void> | null = null

export function useVeinFirmwareReport() {
  const vein = useVeinSerial()
  const { getDeviceJwt, hasDeviceJwt } = useDeviceToken()
  const { getManagerJwt } = useManagerDeviceToken()

  /**
   * 報告を 1 回送る。未接続・端末の token が取れないブラウザでは何もしない。
   * 失敗は握る (次の周期でまた送る) — 例外を外へ出さない
   */
  async function report(phase: FirmwarePhase, extra: FirmwareReportExtra = {}): Promise<void> {
    await send(phase, extra)
  }

  /** {@link report} の中身。送れたら true (token が無い・失敗は false) */
  async function send(phase: FirmwarePhase, extra: FirmwareReportExtra = {}): Promise<boolean> {
    if (!vein.isConnected.value) return false
    try {
      const kioskId = kioskDeviceIdFromJwt(await getDeviceJwt())
      const id = kioskId ?? kioskDeviceIdFromJwt(await getManagerJwt())
      if (id === null) return false
      deviceId.value = id
      const info = vein.deviceInfo.value ?? askedInfo.value
      await reportFirmware({
        device_id: id,
        kind: 'timecard',
        ...(info?.board ? { board: info.board } : {}),
        ...(info?.flavor ? { flavor: info.flavor } : {}),
        ...(info?.ver ? { version: info.ver } : {}),
        phase,
        ...extra,
      }, kioskId ? 'default' : 'manager-device')
      return true
    }
    catch (e) {
      console.warn('[firmware] 指静脈端末の報告を送れませんでした:', e)
      return false
    }
  }

  /** 待機の報告。保留中は送らない。送れなければ、接続中は {@link PENDING_RETRY_MS} ごとに取り直す */
  function reportIdle(): Promise<void> {
    if (onHold) return Promise.resolve()
    idleInFlight ??= sendIdle().finally(() => { idleInFlight = null })
    return idleInFlight
  }

  async function sendIdle(): Promise<void> {
    const sent = await send('idle')
    pendingIdle = !sent && vein.isConnected.value
    if (pendingIdle && !retryTimer) {
      retryTimer = setInterval(() => { void reportIdle() }, PENDING_RETRY_MS)
    }
    else if (!pendingIdle) stopRetry()
  }

  function stopRetry(): void {
    if (retryTimer) clearInterval(retryTimer)
    retryTimer = null
  }

  /**
   * 名乗りが流れていない機体に `DEVICE` を 1 回問い合わせる。書き込み中・取れない (時間切れ・断られた・
   * 30 秒弾かれ続けた) は null — 版不明のまま報告する
   */
  async function askDevice(): Promise<DeviceLine | null> {
    if (isSerialOtaRunning()) return null
    try {
      const line = await requestWhenFree(() => vein.request('DEVICE', 'DEVICE ', DEVICE_TIMEOUT_MS), {
        intervalMs: DEVICE_RETRY_INTERVAL_MS,
        deadline: Date.now() + DEVICE_RETRY_TOTAL_MS,
      })
      return parseDeviceLine(line)
    }
    catch {
      return null
    }
  }

  /** 繋がった直後の 1 回: 名乗りが無ければ問い合わせてから、周期を待たずに送る */
  async function announce(): Promise<void> {
    infoMissingAtConnect = vein.deviceInfo.value === null
    if (infoMissingAtConnect && askedInfo.value === null) {
      const info = await askDevice()
      // 問い合わせている間に切れていたら捨てる (次の接続の機体のものではない)
      if (vein.isConnected.value) askedInfo.value = info
    }
    await reportIdle()
  }

  /** 繋がったとき (画面を読み込んだ直後を含む) と 5 分ごとに `idle` を送り始める。二重に呼んでも 1 回分だけ動く */
  function start(): void {
    if (timer) return
    timer = setInterval(() => { void reportIdle() }, FIRMWARE_REPORT_INTERVAL_MS)
    stopWatches = [
      watch(vein.isConnected, (connected) => {
        if (connected) {
          void announce()
          return
        }
        askedInfo.value = null
        pendingIdle = false
        infoMissingAtConnect = false
        stopRetry()
      }, { immediate: true }),
      // 名乗りが後から揃った (繋がった時点では無かった) ときも、その版ですぐ送り直す
      watch(() => vein.deviceInfo.value, (info) => {
        if (info === null || !infoMissingAtConnect || !vein.isConnected.value) return
        infoMissingAtConnect = false
        void reportIdle()
      }),
      // キオスクの鍵が取れた瞬間に、送れていなかった報告を送る (取り直しの周期を待たない)
      watch(hasDeviceJwt, (has) => {
        if (has && pendingIdle) void reportIdle()
      }),
    ]
  }

  /** 周期の送信を止める */
  function stop(): void {
    if (timer) clearInterval(timer)
    timer = null
    stopRetry()
    for (const unwatch of stopWatches) unwatch()
    stopWatches = []
  }

  /** 待機の報告を保留する (ファームの更新を始めるときに呼ぶ)。`report(phase, extra)` は今までどおり送る */
  function hold(): void {
    onHold = true
  }

  /** 保留を解く。**ここでは `idle` を送らない** (直前の更新の結果を一覧に残す) */
  function release(): void {
    onHold = false
  }

  return {
    /** 最後に報告した端末の id (宛先の見分け用)。まだ送っていなければ null */
    deviceId: readonly(deviceId),
    start,
    stop,
    report,
    hold,
    release,
  }
}
