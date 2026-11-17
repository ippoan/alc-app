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
 * **ここは機体に何も送らない** (署名の要求は端末の token の取得が持つ)。
 */

import type { FirmwarePhase } from '~/utils/api'
import { reportFirmware } from '~/utils/api'
import { kioskDeviceIdFromJwt } from '~/utils/kiosk-remote'
import type { FirmwareReportExtra } from '~/composables/useFirmwareReport'
import { FIRMWARE_REPORT_INTERVAL_MS } from '~/composables/useFirmwareReport'

// シングルトン: 1 台の PC につながる Vein Station は 1 台
const deviceId = ref<string | null>(null)
let timer: ReturnType<typeof setInterval> | null = null
/** 保留中 (ファームの更新中)。待機の報告 (周期・繋がったとき) を送らない */
let onHold = false
let stopWatch: (() => void) | null = null

export function useVeinFirmwareReport() {
  const vein = useVeinSerial()
  const { getDeviceJwt } = useDeviceToken()

  /**
   * 報告を 1 回送る。未接続・端末の token が取れないブラウザでは何もしない。
   * 失敗は握る (次の周期でまた送る) — 例外を外へ出さない
   */
  async function report(phase: FirmwarePhase, extra: FirmwareReportExtra = {}): Promise<void> {
    if (!vein.isConnected.value) return
    try {
      const id = kioskDeviceIdFromJwt(await getDeviceJwt())
      if (id === null) return
      deviceId.value = id
      const info = vein.deviceInfo.value
      await reportFirmware({
        device_id: id,
        kind: 'timecard',
        ...(info?.board ? { board: info.board } : {}),
        ...(info?.flavor ? { flavor: info.flavor } : {}),
        ...(info?.ver ? { version: info.ver } : {}),
        phase,
        ...extra,
      })
    }
    catch (e) {
      console.warn('[firmware] 指静脈端末の報告を送れませんでした:', e)
    }
  }

  /** 待機の報告。保留中は送らない */
  async function reportIdle(): Promise<void> {
    if (!onHold) await report('idle')
  }

  /** 繋がったときと 5 分ごとに `idle` を送り始める。二重に呼んでも 1 回分だけ動く */
  function start(): void {
    if (timer) return
    timer = setInterval(() => { void reportIdle() }, FIRMWARE_REPORT_INTERVAL_MS)
    // 名乗り (deviceInfo) が揃った時点で送る (繋がった直後は版がまだ無いことがある)
    stopWatch = watch(
      () => vein.isConnected.value && vein.deviceInfo.value !== null,
      (ready) => { if (ready) void reportIdle() },
      { immediate: true },
    )
  }

  /** 周期の送信を止める */
  function stop(): void {
    if (timer) clearInterval(timer)
    timer = null
    stopWatch?.()
    stopWatch = null
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
