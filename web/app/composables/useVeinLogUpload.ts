/**
 * Vein Station の行 (`utils/vein-line-log.ts` が溜めたもの) を recorder の `POST /device-log` へ上げる
 * (Refs ippoan/alc-app-s3#352)。保存先は R2 で、運用側が後から読む (Vein Station は `get_device_log` で
 * 読めないため)。
 *
 * 上げるのは次のとき。どれも Vein Station がつながっている間だけ:
 * - 10 分ごと (`periodic`)
 * - 体温計につないだのに値が無かった・失敗した (`EVT THERMO_RX none|err`) — 続きの行も入るよう少し待って
 *   から (`thermo_rx_none`)。続けて起きても {@link VEIN_LOG_MIN_GAP_MS} に 1 回まで
 *
 * 端末の token が取れないとき・送れないときは黙って次の回に回す (点呼の画面を止めない)。
 */
import { onVeinLine, snapshotVeinLines } from '~/utils/vein-line-log'

/** 定期に上げる間隔 */
export const VEIN_LOG_PERIODIC_MS = 10 * 60 * 1000
/** 体温計の値が無かった後、続きの行を待ってから上げるまで */
export const VEIN_LOG_EVENT_DELAY_MS = 15 * 1000
/** 出来事で上げるときの最短の間隔 */
export const VEIN_LOG_MIN_GAP_MS = 2 * 60 * 1000

/** 上げる理由になる行 (体温計につないだが値が無い / 失敗) */
export function isVeinLogTrigger(line: string): boolean {
  return /^EVT THERMO_RX (none|err)\b/.test(line)
}

// シングルトン: 1 台の PC につながる Vein Station は 1 台
let started = false
let periodicTimer: ReturnType<typeof setInterval> | null = null
let eventTimer: ReturnType<typeof setTimeout> | null = null
let lastEventUploadMs = 0

export function useVeinLogUpload() {
  const vein = useVeinSerial()
  const config = useRuntimeConfig()

  /** 溜めた行を 1 回上げる。送れたら true */
  async function upload(reason: string): Promise<boolean> {
    const base = (config.public.recorderUrl as string | undefined)?.replace(/\/$/, '')
    if (!base) return false
    const text = snapshotVeinLines()
    if (!text) return false
    try {
      const token = await useDeviceToken().getDeviceJwt()
      if (!token) return false
      const res = await fetch(`${base}/device-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ source: 'vein-station', reason, text }),
      })
      if (!res.ok) console.warn(`[vein-log] 上げられませんでした status=${res.status} reason=${reason}`)
      return res.ok
    }
    catch (e) {
      console.warn(`[vein-log] 上げられませんでした reason=${reason}`, e)
      return false
    }
  }

  function stopPeriodic(): void {
    if (periodicTimer) clearInterval(periodicTimer)
    periodicTimer = null
  }

  /** 起動から 1 回だけ配線する (画面をまたいで 1 本) */
  function start(): void {
    if (started || !import.meta.client) return
    started = true
    watch(vein.isConnected, (connected) => {
      stopPeriodic()
      if (connected) periodicTimer = setInterval(() => { void upload('periodic') }, VEIN_LOG_PERIODIC_MS)
    }, { immediate: true })
    onVeinLine((line) => {
      if (!isVeinLogTrigger(line) || eventTimer) return
      if (Date.now() - lastEventUploadMs < VEIN_LOG_MIN_GAP_MS) return
      eventTimer = setTimeout(() => {
        eventTimer = null
        lastEventUploadMs = Date.now()
        void upload('thermo_rx_none')
      }, VEIN_LOG_EVENT_DELAY_MS)
    })
  }

  return { start, upload }
}
