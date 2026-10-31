/**
 * 画面 (PWA) のコンソールの診断の行を、送り待ち (utils/serialDiagLog の `app ` 行) へ写す
 * (Refs ippoan/alc-app#558)。useDiagUpload が 1 分ごとに signaling の `/device-log` へ送り、
 * Cloudflare のログに 7 日残る。
 *
 * 運行管理者席の「読み込み直した後のログインが不安定」のように、端末の前でコンソールを開いて
 * 貼ってもらわないと分からない失敗を、後から追うため。写すのは**下のタグで始まる行だけ**
 * (鍵の取得・指静脈・警告デバイス・ポートの調停・読み込み直し)。どれも token・nonce・署名・
 * 測定値を出さない作り。念のため UUID (乗務員の id など) は `<uuid>` に伏せる。
 * コンソールへの出力そのものは変えない (元の関数を必ず呼ぶ)。
 */
import { appendAppLog } from '~/utils/serialDiagLog'

/** 写す行のタグ (最初の引数がこれで始まる行だけ) */
export const APP_LOG_TAGS = [
  '[RELOAD-DETECT]',
  '[useManagerDeviceToken]',
  '[useDeviceToken]',
  '[useManagerAuth]',
  '[vein]',
  '[ALARM-DEV]',
  '[SERIAL]',
] as const

const LEVELS = ['log', 'info', 'warn', 'error'] as const
type Level = typeof LEVELS[number]
type ConsoleLike = Record<Level, (...args: unknown[]) => void>

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
/** オブジェクトを文字にするときの上限 */
const MAX_OBJECT_LENGTH = 200

/** 引数 1 つを文字に (Error は名前と文言だけ。stack は出さない) */
function describe(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`
  try {
    return String(JSON.stringify(arg)).slice(0, MAX_OBJECT_LENGTH)
  }
  catch {
    return String(arg)
  }
}

/** 写す行なら 1 行の文字に、写さない行なら null */
export function appLogLine(level: Level, args: unknown[]): string | null {
  const first = args[0]
  if (typeof first !== 'string' || !APP_LOG_TAGS.some(tag => first.startsWith(tag))) return null
  return `${level} ${args.map(describe).join(' ')}`.replace(UUID, '<uuid>')
}

const installed = new WeakSet<object>()

/** コンソールの 4 つの関数を包む。同じコンソールへの 2 回目は何もしない */
export function installAppConsoleCapture(target: ConsoleLike = console as unknown as ConsoleLike): void {
  if (installed.has(target)) return
  installed.add(target)
  for (const level of LEVELS) {
    const original = target[level]
    target[level] = (...args: unknown[]) => {
      original.apply(target, args)
      const line = appLogLine(level, args)
      if (line) appendAppLog(line)
    }
  }
}
