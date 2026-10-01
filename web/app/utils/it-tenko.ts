/**
 * IT点呼 の通話の部屋の id (Refs ippoan/alc-app#387)。
 *
 * 部屋の id は点呼の記録の id そのままではなく **`it-<点呼の記録の id>`**。運行管理者側は
 * signaling の部屋の一覧を id の接頭辞で振り分ける (画面共有の `screen-<id>` と同じ流儀) —
 * 遠隔点呼モニターは IT点呼 の着信を受けず、IT点呼 専用の受け画面が受ける。
 *
 * **接頭辞の判定はここ 1 か所に集める。** 端末側 (`useItTenkoCall`) と運行管理者側が
 * 別々に文字列を組むと、片方だけ変えたときに着信が黙って届かなくなる。
 */

export const IT_TENKO_ROOM_PREFIX = 'it-'

/** 点呼の記録の id から、IT点呼 の通話の部屋の id を作る */
export function itTenkoRoomId(sessionId: string): string {
  return IT_TENKO_ROOM_PREFIX + sessionId
}

/**
 * IT点呼 の部屋か。**接頭辞だけの id (`it-`) は部屋ではない** — 剥がした先に
 * 点呼の記録の id が残らないので、引きにいく先が無い。
 */
export function isItTenkoRoom(roomId: string): boolean {
  return itTenkoSessionId(roomId) !== null
}

/** IT点呼 の部屋の id から点呼の記録の id を取り出す。IT点呼 の部屋でなければ null */
export function itTenkoSessionId(roomId: string): string | null {
  if (!roomId.startsWith(IT_TENKO_ROOM_PREFIX)) return null
  return roomId.slice(IT_TENKO_ROOM_PREFIX.length) || null
}
