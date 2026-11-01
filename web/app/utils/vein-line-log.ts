/**
 * Vein Station から USB で届いた行を、受けた時刻付きで手元に溜める (Refs ippoan/alc-app-s3#352)。
 *
 * Vein Station は回線を持たないので、CoreS3 のように `get_device_log` で読めない。キオスクが受けた行
 * (ファームの `I (…) NimBLE: …` などのログも含む全部) をここに溜め、`useVeinLogUpload` が recorder の
 * `POST /device-log` へ上げる。ファームのリングと違い、Vein Station が再起動しても前の行が残る。
 *
 * 溜めるのは画面の中 (メモリ) だけで、localStorage には書かない (行数が多く、残す必要も無い)。
 */

/** 溜める行数の上限。超えたら古い方から捨てる */
export const VEIN_LINE_LOG_MAX_LINES = 4000

/** 上げる本文の上限 (文字数)。recorder の `DEVICE_LOG_MAX_TEXT` より小さくする */
export const VEIN_LINE_LOG_MAX_TEXT = 350_000

const lines: string[] = []
const listeners = new Set<(line: string) => void>()

/** `HH:MM:SS.mmm` (端末の時計の現地時刻) */
function stamp(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}.${p(now.getMilliseconds(), 3)}`
}

/** 1 行を溜め、購読者に渡す */
export function recordVeinLine(line: string, now: Date = new Date()): void {
  lines.push(`${stamp(now)} ${line}`)
  if (lines.length > VEIN_LINE_LOG_MAX_LINES) lines.splice(0, lines.length - VEIN_LINE_LOG_MAX_LINES)
  for (const cb of listeners) cb(line)
}

/** 行が溜まるたびに呼ぶ口を足す。戻り値で外す */
export function onVeinLine(cb: (line: string) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** 溜めた行を 1 つの本文にする。上限を超える分は古い方を落とす */
export function snapshotVeinLines(): string {
  let text = lines.join('\n')
  if (text.length > VEIN_LINE_LOG_MAX_TEXT) {
    text = text.slice(text.length - VEIN_LINE_LOG_MAX_TEXT)
    const nl = text.indexOf('\n')
    if (nl >= 0) text = text.slice(nl + 1)
  }
  return text
}

/** 溜めた行を捨てる (テスト用) */
export function clearVeinLines(): void {
  lines.length = 0
}
