/**
 * キオスクが、USB で繋がっている CoreS3 の版・機種・端末の id をサーバへ報告する
 * (Refs ippoan/alc-app#403)。
 *
 * 管理者の画面 (`GET /api/firmware/devices`) は、この報告を一覧にして 1 台ずつ更新の合図を
 * 出す。報告が無い機体は一覧に現れないので、繋がったときと 5 分ごとに `idle` を送り続ける。
 *
 * **ここは機体に何も書き込まない。** 機体へ送るのは `AUTH STATUS` の 1 行だけ
 * (応答 `AUTH PAIRED <tenant> <id>` / `AUTH UNPAIRED`。alc-app-s3 の
 * `hub-drivers/src/console.rs`)。版・機種は接続時の名乗り (`useCoreS3Serial().deviceInfo`) を読む。
 *
 * # 順番の決まり
 *
 * **端末の token を取り終えてから `AUTH STATUS` を聞く。** token の取得は CoreS3 への署名の
 * 要求 (`AUTH SIGNBP` / `AUTH SIGN`) を伴うことがあり、CoreS3 への `request` は同時に 1 本しか
 * 待てない (2 本目は即 reject)。こちらが先に聞くと、署名の要求を reject させて端末の token の
 * 取得を壊しうる。
 */

import type { FirmwarePhase, FirmwareReport } from '~/utils/api'
import { reportFirmware } from '~/utils/api'

/** `idle` を送り直す周期 */
export const FIRMWARE_REPORT_INTERVAL_MS = 5 * 60 * 1000

/** `AUTH STATUS` の応答待ち */
const AUTH_STATUS_TIMEOUT_MS = 3000
/** 端末の id の字種 (cf-alc-recorder が受ける `device_id` と同じ) */
const DEVICE_ID_PATTERN = /^[\w-]{1,64}$/

/** 更新の遷移ごとに報告へ足す欄 (後続の書き込みの処理が使う) */
export type FirmwareReportExtra = Pick<FirmwareReport, 'pct' | 'reason' | 'target_version'>

// シングルトン: 1 台の PC につながる CoreS3 は 1 台
const deviceId = ref<string | null>(null)
let timer: ReturnType<typeof setInterval> | null = null
/** CoreS3 の onOpen / onClose は解除の口を持たないので、登録は起動から 1 回だけ */
let hooked = false

/** `AUTH PAIRED <tenant> <id>` の id。未登録 (`AUTH UNPAIRED`)・形違い・字種違いは null */
export function parseAuthStatusLine(line: string): string | null {
  const parts = line.trim().split(' ')
  if (parts.length !== 4 || parts[0] !== 'AUTH' || parts[1] !== 'PAIRED') return null
  return DEVICE_ID_PATTERN.test(parts[3]!) ? parts[3]! : null
}

export function useFirmwareReport() {
  const coreS3 = useCoreS3Serial()
  const { getDeviceJwt } = useDeviceToken()

  /**
   * 機体に端末の id を聞く。timeout・reject (ほかの要求と当たった / ポートを失った) は
   * null — 次の周期で取り直す
   */
  async function askDeviceId(): Promise<string | null> {
    try {
      return parseAuthStatusLine(await coreS3.request('AUTH STATUS', 'AUTH ', AUTH_STATUS_TIMEOUT_MS))
    }
    catch {
      return null
    }
  }

  /**
   * 報告を 1 回送る。未接続・端末として登録されていないブラウザ・id が取れない機体では何もしない。
   * 失敗は握る (画面には出さない。次の周期でまた送る) — 例外を外へ出さない
   */
  async function report(phase: FirmwarePhase, extra: FirmwareReportExtra = {}): Promise<void> {
    if (!coreS3.isConnected.value) return
    try {
      // 順番の決まり (冒頭 doc): token が先、AUTH STATUS が後
      if (!await getDeviceJwt()) return
      // 聞いて取れなかった回は、持っている id を上書きしない (並んで走った別の回が先に取っていることがある)
      const id = deviceId.value ?? await askDeviceId()
      if (id === null) return
      deviceId.value = id
      const info = coreS3.deviceInfo.value
      await reportFirmware({
        device_id: id,
        kind: 'cores3',
        ...(info?.board ? { board: info.board } : {}),
        ...(info?.flavor ? { flavor: info.flavor } : {}),
        ...(info?.ver ? { version: info.ver } : {}),
        phase,
        ...extra,
      })
    }
    catch (e) {
      console.warn('[firmware] 報告を送れませんでした:', e)
    }
  }

  /** 繋がったときと 5 分ごとに `idle` を送り始める。二重に呼んでも 1 回分だけ動く */
  function start(): void {
    if (timer) return
    timer = setInterval(() => { void report('idle') }, FIRMWARE_REPORT_INTERVAL_MS)
    if (hooked) {
      // 止めてから始め直した: 登録は残っているので、いま繋がっている分だけ送る
      void report('idle')
      return
    }
    hooked = true
    // 登録した時点で既に繋がっていれば、その場で 1 回呼ばれる。stop() の後は送らない
    coreS3.onOpen(() => { if (timer) void report('idle') })
    // 別の機体に差し替えられたときに古い id で報告しない
    coreS3.onClose(() => { deviceId.value = null })
  }

  /** 周期の送信を止める */
  function stop(): void {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  return {
    deviceId: readonly(deviceId),
    start,
    stop,
    report,
  }
}
