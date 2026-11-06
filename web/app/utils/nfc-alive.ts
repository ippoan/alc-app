/**
 * Vein Station の NFC の読み取りが回っているか (Refs ippoan/alc-app-s3#352)。
 *
 * ファームは読み取りのループが回っている間、10 秒ごとに `EVT NFC_ALIVE` を出す。止まったら
 * 30 秒で自分で再起動する (`EVT NFC_STALL`)。画面はこの行が途絶えたら「NFC 応答なし」にする。
 * 一度も来ていないとき (行を出さない古いファーム) は判定しない (`'unknown'`、今までの表示のまま)。
 *
 * NFC ユニットが見つからない (配線・電源) あいだは、ファームが初期化を 5 秒ごとにやり直し、
 * そのたびに `EVT NFC_INIT_NG` を出す。直近に来ていて、その後 `EVT NFC_ALIVE` が来ていなければ
 * `'missing'` (「NFC 未検出」)。
 */

/** この時間 `EVT NFC_ALIVE` が来なければ止まったとみなす (ms、ファームの間隔 10 秒の 3.5 倍) */
export const NFC_ALIVE_STALE_MS = 35_000

/** `EVT NFC_INIT_NG` (5 秒ごと) をこの時間内に受けていれば、まだ見つかっていないとみなす (ms) */
export const NFC_INIT_NG_FRESH_MS = 15_000

export type NfcAliveState = 'unknown' | 'alive' | 'stale' | 'missing'

export function nfcAliveState(lastAliveAt: number | null, now: number, lastInitNgAt: number | null = null): NfcAliveState {
  if (lastInitNgAt !== null && now - lastInitNgAt < NFC_INIT_NG_FRESH_MS
    && (lastAliveAt === null || lastAliveAt < lastInitNgAt)) return 'missing'
  if (lastAliveAt === null) return 'unknown'
  return now - lastAliveAt >= NFC_ALIVE_STALE_MS ? 'stale' : 'alive'
}
