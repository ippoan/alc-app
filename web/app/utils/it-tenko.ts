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

/**
 * 運行管理者が IT点呼 の判定を確定するときの「確認の方法」。通話で確認した (IT) か、
 * 本人が来て対面で確認した (対面) か。**値の文字列を書くのはここだけ** — ほかは
 * この定数か型を参照する (backend の `method` と同じ綴り)。
 */
export const MANAGER_JUDGMENT_METHOD = { IT: 'it', IN_PERSON: 'in_person' } as const
export type ManagerJudgmentMethod = (typeof MANAGER_JUDGMENT_METHOD)[keyof typeof MANAGER_JUDGMENT_METHOD]

/** 点呼の記録の `tenko_method` に入る IT点呼 の値 (端末が保存時に送り、運行管理者側が一覧を絞る) */
export const IT_TENKO_METHOD = 'IT点呼'

/**
 * 判定パネルに最初に選んでおく確認の方法。着信から通話して開いたものは IT、
 * 一覧から通話なしで開いたものは対面
 */
export function defaultJudgmentMethod(viaCall: boolean): ManagerJudgmentMethod {
  return viaCall ? MANAGER_JUDGMENT_METHOD.IT : MANAGER_JUDGMENT_METHOD.IN_PERSON
}

/**
 * signaling の部屋の一覧を IT点呼 の部屋とそれ以外に分ける (順序は保つ)。
 * IT点呼 の受け画面は `it`、遠隔点呼モニターは `remote` を使う
 */
export function splitRooms(rooms: readonly string[]): { it: string[], remote: string[] } {
  const it: string[] = []
  const remote: string[] = []
  for (const room of rooms) (isItTenkoRoom(room) ? it : remote).push(room)
  return { it, remote }
}

/** その点呼の記録の IT点呼 の部屋が一覧に在ればその部屋の id、無ければ null (未完了の一覧の「通話中」) */
export function itTenkoRoomOf(sessionId: string, rooms: readonly string[]): string | null {
  const roomId = itTenkoRoomId(sessionId)
  return rooms.includes(roomId) ? roomId : null
}
