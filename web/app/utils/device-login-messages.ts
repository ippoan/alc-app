/** 警告デバイス認証 (#214) が失敗したときの文言を 1 か所にまとめる (employee-lookup-messages.ts と同じ流儀) */

/** firmware に警告デバイスの鍵が登録されていないとき (`ERR AUTH: no key`) */
export const deviceLoginNoKeyMessage = '管理画面の端末一覧で警告デバイスの鍵を登録してください'

/** nonce 取得 (`GET /auth/device-nonce`) が失敗したとき */
export function deviceLoginNonceFailedMessage(reason: string): string {
  return `認証用のnonceを取得できませんでした: ${reason}`
}

/**
 * 警告デバイスからの応答を待つ間にタイムアウトした、または想定外のエラーで失敗したとき
 * (`no key` 以外の request() reject 全般。`ERR AUTH: bad nonce` 等の個別文言は持たない)
 */
export const deviceLoginTimeoutMessage = '警告デバイスからの応答がありませんでした。デバイスの接続を確認してもう一度お試しください'

/** 警告デバイスの応答が想定した形式 (`AUTH SIG <pubkey> <sig>`) でなかったとき */
export const deviceLoginParseFailedMessage = '警告デバイスの応答を解釈できませんでした'
