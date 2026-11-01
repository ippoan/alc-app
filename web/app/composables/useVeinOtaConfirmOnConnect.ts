/**
 * Vein がつながったら、書き込んだ版の確定 (`OTA CONFIRM`) を送る (Refs ippoan/alc-app-s3#352)。
 *
 * 画面からの書き込み (`useSerialOta` の `run`) は、再起動を待ってから確定を送る。その途中で画面を
 * 読み込み直すと確定を誰も送らず、機体は 10 分後に前の版へ戻る (2026-11-02、運行管理者席の Vein Base で
 * `OTA 後 10分 OTA CONFIRM が来ないため前の image に戻します (reason=serial_unconfirmed)`)。
 *
 * つながって名乗り (`DEVICE timecard … FLAVOR=…`) に答えた機体は、今の版で動いて画面と話せている —
 * 戻しの見張りが守りたい「話せない版」ではない。だからつながるたびに確定を送る。確定済み・書き込みの
 * 後でない機体では何も起きない (機体側で冪等)。FLAVOR を名乗る版は必ず `OTA CONFIRM` を解釈する。
 * 書き込みが走っている間 (`isSerialOtaRunning`) は送らない (`run` が自分で確かめて送る)。
 * 失敗は警告を 1 行出して次の接続に回す。
 */
import { isSerialOtaRunning } from '~/composables/useSerialOta'
import { requestWhenFree } from '~/utils/serial-request-when-free'

/** `OTA CONFIRM` → `OTA CONFIRMED` の応答待ち */
const CONFIRM_TIMEOUT_MS = 10_000
/** 署名などで「既に応答待ち」だったときの呼び直しの間隔と、諦めるまで */
const BUSY_RETRY_INTERVAL_MS = 2_000
const BUSY_RETRY_TOTAL_MS = 60_000

let started = false

export function useVeinOtaConfirmOnConnect() {
  const vein = useVeinSerial()

  /** 確定を 1 回送る。送れたら true */
  async function confirm(): Promise<boolean> {
    if (!vein.isConnected.value || !vein.deviceInfo.value?.flavor || isSerialOtaRunning()) return false
    try {
      const line = await requestWhenFree(
        () => vein.request('OTA CONFIRM', 'OTA CONFIRMED', CONFIRM_TIMEOUT_MS, 'OTA ERR'),
        { intervalMs: BUSY_RETRY_INTERVAL_MS, deadline: Date.now() + BUSY_RETRY_TOTAL_MS, isCancelled: isSerialOtaRunning },
      )
      console.info(`[SERIAL_OTA] 接続時の確定 ${line.trim()} ver=${vein.deviceInfo.value?.ver ?? '-'}`)
      return true
    }
    catch (e) {
      console.warn('[SERIAL_OTA] 接続時の確定を送れませんでした (次の接続で送り直す):', e)
      return false
    }
  }

  /** 起動から 1 回だけ配線する (画面をまたいで 1 本) */
  function start(): void {
    if (started || !import.meta.client) return
    started = true
    watch(vein.isConnected, (connected) => {
      if (connected) void confirm()
    }, { immediate: true })
  }

  return { start, confirm }
}
