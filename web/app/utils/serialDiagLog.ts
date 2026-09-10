/**
 * シリアル診断ログの置き場 (localStorage のリング、Refs ippoan/alc-app#223)。
 *
 * arbiter の `[SERIAL]` の行はコンソールにしか出ず、遠隔では読めない。ここへ**常に**
 * 貯めておき (再読み込みをまたいで残る)、CoreS3 の `get_log` の問い合わせ
 * (useCoreS3Serial) とメンテナンス画面から読む。
 *
 * 入れるのは arbiter の診断の行と、CoreS3 の許可リストの `EVT` 行 (`dev ` 接頭辞、
 * Refs ippoan/alc-app#225)。券・nonce・ERR の行・利用者の情報は入れない。
 *
 * 直前と同じ本文が続いたら新しく足さず 1 件にまとめ、回数と最後の時刻を付ける —
 * CoreS3 が落ちているあいだ arbiter は 10 秒ごとに `scan start` を書くので、まとめないと
 * 落ちる直前の行が約 33 分で押し出される。
 *
 * localStorage が使えない (SSR・例外・容量超過) ときは何もしない / 空を返す — 診断の
 * 置き場が本処理 (ポートの調停) を落としてはいけないため、例外は外へ出さない。
 */

const STORAGE_KEY = 'alc_serial_diag'
/** 保持する最大件数。超えたら古い件から捨てる */
const MAX_LINES = 200
/** 1 行の最大文字数 (時刻・まとめた回数の表示込み) */
const MAX_LINE_LENGTH = 160

/** 置き場の 1 件 */
interface DiagEntry {
  /** 最初の時刻 `HH:MM:SS.mmm` */
  t: string
  /** 本文 (改行は空白に、時刻込みで 160 文字に切ったもの) */
  msg: string
  /** 続いた回数 */
  n: number
  /** 最後の時刻 `HH:MM:SS` */
  last: string
}

/** `HH:MM:SS.mmm` (PWA のローカル時刻) */
function timestamp(d: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/**
 * 置き場の中身を古い順に。#223 の古い形 (整形済みの文字列) はそのまま `n = 1` の 1 件として
 * 読む。どちらでもない要素と、読めない置き場は捨てる
 */
function load(): Array<string | DiagEntry> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(e => typeof e === 'string' || typeof e?.msg === 'string')
  }
  catch {
    return []
  }
}

/** `HH:MM:SS.mmm <msg>`、まとめた件は ` (×<n> 最後 HH:MM:SS)` を付ける (本文を削って 160 文字に収める) */
function format(entry: string | DiagEntry): string {
  if (typeof entry === 'string') return entry
  const line = `${entry.t} ${entry.msg}`
  if (entry.n === 1) return line
  const tail = ` (×${entry.n} 最後 ${entry.last})`
  return line.slice(0, MAX_LINE_LENGTH - tail.length) + tail
}

/** 貯めた行を古い順に返す */
export function readDiag(): string[] {
  return load().map(format)
}

/** 1 行貯める (改行は空白に、時刻込みで 160 文字に切る)。直前と同じ本文ならその件にまとめる */
export function appendDiag(msg: string): void {
  try {
    const now = timestamp(new Date())
    const body = msg.replace(/[\r\n]/g, ' ').slice(0, MAX_LINE_LENGTH - now.length - 1)
    const entries = load()
    const prev = entries.at(-1)
    if (typeof prev === 'object' && prev.msg === body) {
      prev.n += 1
      prev.last = now.slice(0, 8)
    }
    else {
      entries.push({ t: now, msg: body, n: 1, last: now.slice(0, 8) })
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_LINES)))
  }
  catch {
    // 容量超過など。診断が本処理を止めないよう黙って捨てる
  }
}
