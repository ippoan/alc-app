/**
 * 診断ログの送り待ち (utils/serialDiagLog の `dev ` 行) を、1 分ごとに signaling の `/device-log` へ送る。
 * signaling はそれを 1 行ずつ Cloudflare のログに出し、7 日残る (端末と時刻で検索して読む)。
 *
 * 体温が PC に届かなかった回 (`EVT THERMO_CONN try` の後に `THERMO_RX` が来ない等) を、
 * 端末の前に居なくても後から追うため。入る行は機体の状態だけで、測定値や利用者の情報は入らない
 * (何を置き場に入れるかは useCoreS3Serial / useVeinSerial が決める)。
 *
 * 端末は自分の鍵の token の `sub` で名乗る (取れなければ `(none)`)。`/device-log` は認証なしの
 * 診断用の口なので、名乗りは参考で、ここから何かを書き換えることはない。
 * 送れなかった行は送り待ちへ戻し、次の周期で送り直す。
 */
import { decodeJwtPayloadFromToken } from '@ippoan/auth-client'
import { returnDiagOutbox, takeDiagOutbox } from '~/utils/serialDiagLog'

/** 送る周期 */
export const DIAG_UPLOAD_INTERVAL_MS = 60_000
/** `/device-log` の 1 回の上限 (signaling が 200 行で切る) */
const MAX_LINES_PER_POST = 200
const TAG = 'pwa-diag'

let started = false

/** 端末の鍵の token の `sub`。鍵が無い・読めなければ `(none)` */
async function deviceIdOf(): Promise<string> {
  try {
    const token = await useDeviceToken().getDeviceJwt()
    const sub = token ? (decodeJwtPayloadFromToken(token) as { sub?: unknown } | null)?.sub : null
    return typeof sub === 'string' ? sub : '(none)'
  }
  catch {
    return '(none)'
  }
}

/** 送り待ちを 1 回送る。送れなかった分は戻す */
export async function flushDiagOutbox(signalingUrl: string): Promise<void> {
  const lines = takeDiagOutbox()
  if (lines.length === 0) return
  const url = `${signalingUrl.replace(/^wss/, 'https').replace(/^ws:/, 'http:').replace(/\/$/, '')}/device-log`
  const deviceId = await deviceIdOf()
  for (let i = 0; i < lines.length; i += MAX_LINES_PER_POST) {
    const chunk = lines.slice(i, i + MAX_LINES_PER_POST)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId, tag: TAG, lines: chunk }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    }
    catch {
      returnDiagOutbox(lines.slice(i))
      return
    }
  }
}

/** 送る周期を始める (app.vue から 1 回。2 回目以降は何もしない) */
export function useDiagUpload(): void {
  if (started) return
  started = true
  const signalingUrl = String(useRuntimeConfig().public.signalingUrl)
  setInterval(() => { void flushDiagOutbox(signalingUrl) }, DIAG_UPLOAD_INTERVAL_MS)
}
