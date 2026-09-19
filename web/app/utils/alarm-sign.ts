/**
 * `AUTH SIGN <nonce>` を端末に送って ed25519 署名を受け取る部分だけを持つ (#214 → #353-8)。
 *
 * firmware (ippoan/alc-app-s3#205) が `AUTH SIGN <nonce>` に `AUTH SIG <pubkey> <sig>` で応え、
 * auth-worker (ippoan/auth-worker#521/#522) が公開鍵の登録と nonce 発行・検証を持つ。
 * ここはその間を繋ぐだけで、鍵も署名も検証しない。
 *
 * 送り先は `request` 引数で切り替える (#234-2):
 *   - 既定値 = 警告デバイス (`useAlarmDevice().request`) — useManagerDeviceToken.ts (#337 運行管理者席)
 *   - CoreS3 (`useCoreS3Serial().request`) — useDeviceToken.ts (#231 キオスクの短命端末 JWT)
 */

/** firmware への `AUTH SIGN <nonce>` 応答を待つ上限 (useHubClaim の AUTH TICKET と同じ 10 秒) */
const AUTH_SIGN_TIMEOUT_MS = 10_000
const AUTH_SIGN_MATCH_PREFIX = 'AUTH SIG '

/** `AUTH SIG <pubkey> <sig>` を空白で分割して parse。形式が合わなければ null */
export function parseAuthSigLine(line: string): { pubkey: string, sig: string } | null {
  const parts = line.split(' ')
  if (parts.length !== 4 || parts[0] !== 'AUTH' || parts[1] !== 'SIG') return null
  return { pubkey: parts[2]!, sig: parts[3]! }
}

/**
 * `AUTH SIGN <nonce>` を送り、応答 `AUTH SIG <pubkey> <sig>` を parse して返す。
 * firmware が `ERR AUTH: ...` を返せば request がそのまま reject するので、ここでは
 * 投げっぱなしにする (呼び出し側でメッセージを出し分ける)。parse に失敗したときだけ null を返す。
 *
 * firmware の `ERR AUTH: no key` / `ERR AUTH: bad nonce` は useSerialArbiter.request の
 * `errPrefix` (`ERR ${送った行の先頭トークン}` = `ERR AUTH`) に一致するため、nonce を
 * echo しなくても即 reject される (10 秒のタイムアウトを待たない)。
 */
export async function signAlarmDeviceNonce(
  nonce: string,
  request: (line: string, matchPrefix: string, timeoutMs: number) => Promise<string> = useAlarmDevice().request,
): Promise<{ pubkey: string, sig: string } | null> {
  const line = await request(`AUTH SIGN ${nonce}`, AUTH_SIGN_MATCH_PREFIX, AUTH_SIGN_TIMEOUT_MS)
  return parseAuthSigLine(line)
}
