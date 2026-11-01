/**
 * Vein Station から USB で届いた行を、受けた時刻付きで手元に溜める (Refs ippoan/alc-app-s3#352)。
 *
 * Vein Station は回線を持たないので、CoreS3 のように `get_device_log` で読めない。キオスクが受けた行
 * (ファームの `I (…) NimBLE: …` などのログも含む全部) をここに溜め、`useVeinLogUpload` が recorder の
 * `POST /device-log` へ上げる。ファームのリングと違い、Vein Station が再起動しても前の行が残る。
 *
 * 溜めるのは画面の中 (メモリ)。localStorage には書かない (行数が多く、残す必要も無い)。ただし画面を閉じる・
 * 読み込み直す瞬間だけ、まだ送っていない分を同じタブの sessionStorage へ退避し、開き直したら戻す
 * ({@link persistVeinLines} / {@link restoreVeinLines})。送る前に読み込み直すと、撮り直しや照合の行が
 * 消えていた (2026-11-02、運行管理者席)。閉じる瞬間は鍵の署名を待てないので、送らずに退避する。
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

/** 伏せる 16 進の長さ (文字数)。登録の記録・特徴量・生画像の塊はこれより長い。署名や ID より長くとる */
const REDACT_HEX_MIN = 32

/**
 * 溜める写しから生体の中身を伏せる (Refs ippoan/alc-app-s3#352)。登録の記録 (`VEIN RECORD <id> <offset> <hex>`)・
 * 特徴量 (`VEIN CHARA <hex>`)・試験の生画像や記録の読み出しは、{@link REDACT_HEX_MIN} 文字以上の 16 進の塊として
 * 届く。塊を `<hex N B>` (バイト数) に置き換え、行の頭 (種類・ID・offset) は残す。購読者には元の行のまま渡す
 */
export function redactVeinLine(line: string): string {
  return line.replace(new RegExp(`\\b[0-9A-Fa-f]{${REDACT_HEX_MIN},}\\b`, 'g'), hex => `<hex ${Math.floor(hex.length / 2)} B>`)
}

/** 1 行を溜め、購読者に渡す。溜める写しは生体の中身を伏せる ({@link redactVeinLine}) */
export function recordVeinLine(line: string, now: Date = new Date()): void {
  lines.push(`${stamp(now)} ${redactVeinLine(line)}`)
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

/** 退避先 (sessionStorage) の key */
const PERSIST_KEY = 'alc-vein-lines-pending'

/** 溜めた行を sessionStorage へ退避する (画面を閉じる・読み込み直す直前に呼ぶ)。書けなければ黙って諦める */
export function persistVeinLines(): void {
  if (lines.length === 0) return
  try {
    sessionStorage.setItem(PERSIST_KEY, snapshotVeinLines())
  }
  catch {
    // 容量超え・使えない環境 — 失っても照合は止めない
  }
}

/** 退避した行を、今溜めている行の前へ戻して退避先を消す (起動時に 1 回)。戻した行数を返す */
export function restoreVeinLines(): number {
  let text: string | null = null
  try {
    text = sessionStorage.getItem(PERSIST_KEY)
    sessionStorage.removeItem(PERSIST_KEY)
  }
  catch {
    return 0
  }
  if (!text) return 0
  const restored = text.split('\n')
  lines.unshift(...restored)
  if (lines.length > VEIN_LINE_LOG_MAX_LINES) lines.splice(0, lines.length - VEIN_LINE_LOG_MAX_LINES)
  return restored.length
}

/** 溜めた行を捨てる (テスト用) */
export function clearVeinLines(): void {
  lines.length = 0
}
