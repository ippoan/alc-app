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
 *
 * **人にも安易に再送させない。** 本番でハングした回は `POST /api/tenko/sessions/start` が
 * サーバに届いて処理され、応答だけがページに返らなかった。ここで「もう一度お試しください」と
 * 出すと、押すたびに宙ぶらりんの点呼セッションが増える (実測: 1 日で 7 本)。
 * ⇒ **文言は 1 種類で済ませず、副作用の有無 (HTTP method) で出し分ける。**
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

/**
 * 副作用が無く、そのまま押し直してよい HTTP method。
 * method 未指定の fetch は GET なので、既定もこちら側になる。
 */
const RETRY_SAFE_METHODS = new Set(['GET', 'HEAD'])

/** 読み取り (GET/HEAD) が timeout したとき。押し直して構わないので、そう書く。 */
export const FETCH_TIMEOUT_MESSAGE_READ = '通信が応答しません。もう一度お試しください'

/**
 * 書き込み (POST/PUT/PATCH/DELETE) が timeout したとき。
 * **再試行を促さない** — 応答が返らなかっただけでサーバ側は成功していることがあり、
 * 押し直すと同じ登録が二重に積み上がる。
 */
export const FETCH_TIMEOUT_MESSAGE_WRITE
  = '通信が応答しませんでした。処理は完了している可能性があります。同じ操作を繰り返さず、画面を確認するか運行管理者に連絡してください'

/** その要求を押し直してよいかで文言を選ぶ。 */
export function timeoutMessageFor(method?: string): string {
  return RETRY_SAFE_METHODS.has((method ?? 'GET').toUpperCase())
    ? FETCH_TIMEOUT_MESSAGE_READ
    : FETCH_TIMEOUT_MESSAGE_WRITE
}

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
 * `method` でその要求を押し直してよいかが変わるので、それも渡す。
 * それ以外の失敗 (HTTP エラー・呼び出し側自身の中断) はそのまま返す。
 */
export function asTimeoutError(e: unknown, method?: string): unknown {
  if (e instanceof Error && e.name === 'TimeoutError') return new Error(timeoutMessageFor(method))
  return e
}

/** timeout 付きの `fetch`。timeout したら method に応じた文言で reject する。 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  ms: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, withTimeout(init, ms))
  }
  catch (e) {
    throw asTimeoutError(e, init.method)
  }
}
