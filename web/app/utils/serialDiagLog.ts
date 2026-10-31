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
/**
 * 機体の行 (`dev ` で始まる行) の送り待ち。useDiagUpload が 1 分ごとに signaling の
 * `/device-log` へ送って空にする (Cloudflare のログに 7 日残る)。置き場と違って同じ本文も
 * まとめない — 「`THERMO_CONN try` が続いて `RX` が来ない」を数えられるように
 */
const OUTBOX_KEY = 'alc_serial_diag_outbox'
/** 送り待ちの上限。送れない間 (オフライン等) は古い行から捨てる */
const OUTBOX_MAX = 500
/** 送り待ちに入れる行の接頭辞 (機体の行。arbiter の `[SERIAL]` 等は入れない) */
const OUTBOX_PREFIX = 'dev '
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
    if (body.startsWith(OUTBOX_PREFIX)) saveOutbox([...loadOutbox(), `${now} ${body}`])
  }
  catch {
    // 容量超過など。診断が本処理を止めないよう黙って捨てる
  }
}

/** 画面の診断の行 (`app ` 接頭辞) の 1 行の最大文字数。機体の行より長い (エラーの文言が入る) */
const MAX_APP_LINE_LENGTH = 300

/**
 * 画面 (PWA) の診断の行を送り待ちにだけ足す (置き場には入れない。Refs ippoan/alc-app#558)。
 * 鍵の取得・指静脈・警告デバイスの失敗を、端末の前に居なくても後から追うため。`app ` を頭に付け、
 * 改行は空白に、300 文字で切る。何を入れるかは utils/appConsoleCapture が決める
 */
export function appendAppLog(msg: string): void {
  try {
    const now = timestamp(new Date())
    const body = `app ${msg.replace(/[\r\n]/g, ' ')}`.slice(0, MAX_APP_LINE_LENGTH)
    saveOutbox([...loadOutbox(), `${now} ${body}`])
  }
  catch {
    // 容量超過など。診断が本処理を止めないよう黙って捨てる
  }
}

function loadOutbox(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === 'string') : []
  }
  catch {
    return []
  }
}

function saveOutbox(lines: string[]): void {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(lines.slice(-OUTBOX_MAX)))
}

/** 送り待ちを古い順に取り出して空にする */
export function takeDiagOutbox(): string[] {
  try {
    const lines = loadOutbox()
    if (lines.length > 0) localStorage.removeItem(OUTBOX_KEY)
    return lines
  }
  catch {
    return []
  }
}

/** 送れなかった行を送り待ちの頭へ戻す (取り出した後に足された行より前へ) */
export function returnDiagOutbox(lines: string[]): void {
  try {
    saveOutbox([...lines, ...loadOutbox()])
  }
  catch {
    // 戻せなければ捨てる (診断が本処理を止めない)
  }
}
