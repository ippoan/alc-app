/**
 * Vein Station の行 (`utils/vein-line-log.ts` が溜めたもの) を recorder の `POST /device-log` へ上げる
 * (Refs ippoan/alc-app-s3#352)。保存先は R2 で、運用側が後から読む (Vein Station は `get_device_log` で
 * 読めないため)。
 *
 * 上げるのは次のとき。どれも Vein Station がつながっている間だけ:
 * - 10 分ごと (`periodic`)
 * - 出来事 ({@link veinLogTriggerReason}) — 続きの行も入るよう少し待ってから。続けて起きても
 *   {@link VEIN_LOG_MIN_GAP_MS} に 1 回まで (理由は最初の出来事のもの。本文は溜めた行の全部なので、
 *   まとめた分の行も載る):
 *   - 体温計につないだのに値が無かった・失敗した (`EVT THERMO_RX none|err` → `thermo_rx_none`)
 *   - 指静脈が不一致 (`VEIN NOMATCH` → `vein_nomatch`)・指紋互換の層でだけ当たった (`VIA=FP` → `vein_fp`)。
 *     照合が不安定な件を、記録の書き直し (`PC VEIN RECORD`、`vein-module.ts`) と並べて後から追う
 *
 * 送る鍵はキオスクの鍵。この Vein がキオスクの鍵でない (運行管理者席の Vein Base: キオスクとして
 * 断られて「キオスクの鍵は必須」が下りた) ときは運行管理者席の鍵。どちらも取れないとき・送れないときは
 * 黙って次の回に回す (点呼の画面を止めない)。
 */
import { onVeinLine, snapshotVeinLines } from '~/utils/vein-line-log'
import { isKioskDeviceKeyRequired } from '~/utils/token-selection'

/** 定期に上げる間隔 */
export const VEIN_LOG_PERIODIC_MS = 10 * 60 * 1000
/** 出来事 (体温計の値が無い・指静脈の不一致など) の後、続きの行を待ってから上げるまで */
export const VEIN_LOG_EVENT_DELAY_MS = 15 * 1000
/** 出来事で上げるときの最短の間隔 */
export const VEIN_LOG_MIN_GAP_MS = 2 * 60 * 1000

/** 上げる理由になる行なら理由の語、ならなければ null */
export function veinLogTriggerReason(line: string): string | null {
  if (/^EVT THERMO_RX (none|err)\b/.test(line)) return 'thermo_rx_none'
  if (/^VEIN NOMATCH\b/.test(line)) return 'vein_nomatch'
  if (/^VEIN (VERIFIED|IDENTIFIED) \d+ .*\bVIA=FP\b/.test(line)) return 'vein_fp'
  return null
}

/**
 * 送る鍵。キオスクの鍵、取れずこの Vein がキオスクの鍵でないと分かっていれば運行管理者席の鍵。
 * キオスクの Vein Station では運行管理者席の鍵を頼まない (用途違いの署名でポートを塞がない)
 */
async function uploadToken(): Promise<string | null> {
  const kiosk = await useDeviceToken().getDeviceJwt()
  if (kiosk || isKioskDeviceKeyRequired()) return kiosk
  return useManagerDeviceToken().getManagerJwt()
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
      const token = await uploadToken()
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
      const reason = veinLogTriggerReason(line)
      if (!reason || eventTimer) return
      if (Date.now() - lastEventUploadMs < VEIN_LOG_MIN_GAP_MS) return
      eventTimer = setTimeout(() => {
        eventTimer = null
        lastEventUploadMs = Date.now()
        void upload(reason)
      }, VEIN_LOG_EVENT_DELAY_MS)
    })
  }

  return { start, upload }
}
