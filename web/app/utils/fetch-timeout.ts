/**
 * fetch に上限 (timeout) を載せるための共通ヘルパー (Refs ippoan/alc-app#338)。
 *
 * 素の `fetch` は**応答が返らない限り解決も拒否もしない**。TCP が黒穴になる /
 * プロキシが握ったまま返さない、といった状況では Promise が永久に pending のままになり、
 * 呼び出し側の `try { … } catch { … } finally { isLoading = false }` はどこにも進まない。
 * 本番のキオスクはこれで「顔認証の直後にスピナーのまま二度と進まない」状態になり、
 * エラーも出ないので現場はタブを閉じるまで詰んだ。
 *
 * ⇒ **fetch を呼ぶ側ではなく、ここ 1 箇所で `AbortSignal.timeout()` を載せる。**
 * timeout すれば fetch は `TimeoutError` で reject するので、既存の catch に落ちて
 * 画面にエラーが出る = **無言で止まらない**。
 *
 * **自動再送はここに入れない。** 応答が返らなかっただけでサーバ側は成功していることが
 * あり (実測: セッションは作られていた)、再送すると二重に作ってしまう。
 */

/**
 * 既定の上限。`api.ts` は通常点呼・遠隔点呼・管理画面が全部通る**共有経路**なので、
 * 今まで通っていた遅い経路を落とさないよう十分に長く取る。
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000

/** 顔写真・音声・録画のアップロードは本文が重いので別枠でさらに長く。 */
export const UPLOAD_FETCH_TIMEOUT_MS = 120_000

/**
 * auth-worker への HTTP (device JWT の mint) の上限。
 * CoreS3 への `AUTH SIGNBP` / `AUTH SIGN` が既に 10 秒で切り上げているのに、
 * その前後の HTTP には上限が無い、という非対称を解消する値。
 */
export const AUTH_WORKER_FETCH_TIMEOUT_MS = 10_000

/** timeout したときに画面へ出す文言 (次の行動まで書く)。 */
export const FETCH_TIMEOUT_MESSAGE = '通信が応答しません。もう一度お試しください'

/**
 * `RequestInit` に timeout の `AbortSignal` を載せて返す。
 *
 * **呼び出し側が既に `signal` を渡していれば上書きしない** — 中断の主導権は
 * 渡した側にある (画面遷移でのキャンセル等)。元の `init` は変更しない。
 */
export function withTimeout<T extends RequestInit>(init: T, ms: number = DEFAULT_FETCH_TIMEOUT_MS): T {
  if (init.signal) return init
  return { ...init, signal: AbortSignal.timeout(ms) }
}

/**
 * `AbortSignal.timeout()` が発火したときの失敗を、現場が次の手を打てる文言に置き換える。
 * それ以外の失敗 (HTTP エラー・呼び出し側自身の中断) はそのまま返す。
 */
export function asTimeoutError(e: unknown): unknown {
  if (e instanceof Error && e.name === 'TimeoutError') return new Error(FETCH_TIMEOUT_MESSAGE)
  return e
}

/** timeout 付きの `fetch`。timeout したら `FETCH_TIMEOUT_MESSAGE` で reject する。 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  ms: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, withTimeout(init, ms))
  }
  catch (e) {
    throw asTimeoutError(e)
  }
}
