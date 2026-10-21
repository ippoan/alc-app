/**
 * 開発用の端末 (`isDevDevice('kiosk')`) だけが出す、時刻付きの時間計測ログ (Refs ippoan/alc-app#436)。
 *
 * 血圧計に値が出てから「測定完了」まで 30 秒〜1 分かかる原因 (機体の BLE か、画面の保存・
 * トークンの取り直しか) を実機で切り分けるためのもの。`console.info` と sessionStorage
 * (`alc-dev-timing`、直近 {@link DEV_TIMING_MAX_LINES} 行) の両方に同じ行を残す。
 *
 * - 本番の端末では何もしない (印を 1 回読んで戻る)。利用者向けの画面には何も出さない
 * - **生体データ・トークン・記録の中身を detail に入れない** (長さ・件数・ID・状態だけ)
 */
import { isDevDevice } from '~/utils/token-selection'

export const DEV_TIMING_STORAGE_KEY = 'alc-dev-timing'
export const DEV_TIMING_MAX_LINES = 300

export type DevTimingDetail = Record<string, string | number | boolean>

let lastAt = 0

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

export function devTiming(label: string, detail?: DevTimingDetail): void {
  if (!isDevDevice('kiosk')) return
  const now = new Date()
  const stamp = `${pad(now.getHours(), 2)}:${pad(now.getMinutes(), 2)}:${pad(now.getSeconds(), 2)}.${pad(now.getMilliseconds(), 3)}`
  const delta = lastAt === 0 ? 0 : now.getTime() - lastAt
  lastAt = now.getTime()
  const kv = Object.entries(detail ?? {}).map(([k, v]) => ` ${k}=${v}`).join('')
  const line = `[DEV-TIMING] ${stamp} +${delta}ms ${label}${kv}`
  console.info(line)
  try {
    const stored = JSON.parse(sessionStorage.getItem(DEV_TIMING_STORAGE_KEY) ?? '[]') as string[]
    stored.push(line)
    sessionStorage.setItem(DEV_TIMING_STORAGE_KEY, JSON.stringify(stored.slice(-DEV_TIMING_MAX_LINES)))
  }
  catch {
    // sessionStorage が使えない / 壊れている: console だけに出す
  }
}

/** テスト用: 「前回から」の基準を戻す */
export function resetDevTimingClock(): void {
  lastAt = 0
}
