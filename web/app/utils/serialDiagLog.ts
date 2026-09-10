/**
 * シリアル診断ログの置き場 (localStorage のリング、Refs ippoan/alc-app#223)。
 *
 * arbiter の `[SERIAL]` の行はコンソールにしか出ず、遠隔では読めない。ここへ**常に**
 * 貯めておき (再読み込みをまたいで残る)、CoreS3 の `get_log` の問い合わせ
 * (useCoreS3Serial) とメンテナンス画面から読む。
 *
 * 入れるのは arbiter の診断の行だけ。券・nonce・ERR の行・利用者の情報は入れない。
 *
 * localStorage が使えない (SSR・例外・容量超過) ときは何もしない / 空を返す — 診断の
 * 置き場が本処理 (ポートの調停) を落としてはいけないため、例外は外へ出さない。
 */

const STORAGE_KEY = 'alc_serial_diag'
/** 保持する最大行数。超えたら古い行から捨てる */
const MAX_LINES = 200
/** 1 行の最大文字数 (時刻込み) */
const MAX_LINE_LENGTH = 160

/** `HH:MM:SS.mmm` (PWA のローカル時刻) */
function timestamp(d: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** 貯めた行を古い順に返す */
export function readDiag(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  }
  catch {
    return []
  }
}

/** 1 行貯める (`HH:MM:SS.mmm <msg>`、改行は空白に、160 文字で切る) */
export function appendDiag(msg: string): void {
  try {
    const line = `${timestamp(new Date())} ${msg.replace(/[\r\n]/g, ' ')}`.slice(0, MAX_LINE_LENGTH)
    const lines = [...readDiag(), line].slice(-MAX_LINES)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lines))
  }
  catch {
    // 容量超過など。診断が本処理を止めないよう黙って捨てる
  }
}
