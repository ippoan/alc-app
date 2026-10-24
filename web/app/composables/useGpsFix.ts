/**
 * Unit GPS の最新の位置 (Refs ippoan/alc-app#514)。
 *
 * GPS 版の Vein Base は USB シリアルへ `EVT GPS FIX lat=… lon=… …` / `EVT GPS NOFIX sats=… utc=…` を
 * FIX/NOFIX が変わったときと 30 秒ごとに出す。GPS を挿していない機体は `EVT GPS` 行を出さない。
 * ここは最新の 1 行を覚え、点呼を始めるときの `location` に渡す。表記は CSV 出力と record_hash に
 * そのまま入るので、機体の行から `EVT GPS ` を外しただけの形から変えない。
 */

/** この秒数より古い位置は使わない (30 秒ごとの送信が途切れた = GPS が外れた) */
const STALE_MS = 120_000

const FIX_PREFIX = 'EVT GPS FIX '
const NOFIX_PREFIX = 'EVT GPS NOFIX'

let latest: { value: string, receivedAt: number } | null = null

/** `EVT GPS FIX ` / `EVT GPS NOFIX` の行なら保持して true。それ以外は false */
export function onGpsLine(line: string): boolean {
  if (!line.startsWith(FIX_PREFIX) && !line.startsWith(NOFIX_PREFIX)) return false
  latest = { value: line.slice('EVT GPS '.length), receivedAt: Date.now() }
  return true
}

/** 点呼の記録に載せる位置。一度も受けていなければ undefined、古ければ `NOFIX stale` */
export function currentLocation(now: number = Date.now()): string | undefined {
  if (latest === null) return undefined
  return now - latest.receivedAt > STALE_MS ? 'NOFIX stale' : latest.value
}

/** テスト用: 保持を捨てる */
export function resetGpsFix(): void {
  latest = null
}
