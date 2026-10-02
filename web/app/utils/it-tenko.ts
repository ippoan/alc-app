/**
 * IT点呼 の通話の部屋の id (Refs ippoan/alc-app#387)。
 *
 * 部屋の id は点呼の記録の id そのままではなく **`it-<点呼の記録の id>`**。運行管理者側は
 * signaling の部屋の一覧を id の接頭辞で振り分ける (画面共有の `screen-<id>` と同じ流儀) —
 * 遠隔点呼モニターは IT点呼 の着信を受けず、IT点呼 専用の受け画面が受ける。
 *
 * **接頭辞の判定はここ 1 か所に集める。** 端末側 (`useItTenkoCall`) と運行管理者側が
 * 別々に文字列を組むと、片方だけ変えたときに着信が黙って届かなくなる。
 * 画面共有の部屋の接頭辞もここに置く (共有する側 `useScreenShare` と見る側が同じ関数を使う)。
 */

export const IT_TENKO_ROOM_PREFIX = 'it-'

/**
 * 画面共有の部屋の id の接頭辞。signaling の DO (`cf-alc-signaling/src/signaling-room.ts`) は
 * 別 package なので同じ値を直に書いている — 変えるときは両方。
 */
export const SCREEN_SHARE_ROOM_PREFIX = 'screen-'

/** 画面共有の部屋の id を作る (`id` は共有のたびに振る一意な値) */
export function screenShareRoomId(id: string): string {
  return SCREEN_SHARE_ROOM_PREFIX + id
}

/** 画面共有の部屋か */
export function isScreenShareRoom(roomId: string): boolean {
  return roomId.startsWith(SCREEN_SHARE_ROOM_PREFIX)
}

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
 * 運転者の今回の本人確認の方法 (Refs ippoan/alc-app#387)。端末が測定の保存 (PUT) に
 * `identity_method` として送り、点呼の記録に残る。**backend はこの 5 つに完全一致しない値を
 * 400 で断る (測定の保存ごと失敗する)** ので、値の文字列を書くのはここだけにする。
 *
 * - `license` = この端末で運転免許証を読んだ
 * - `ic_card` = この端末に繋いだ機体で社員証を読んだ (その打刻の案内から始めた回)
 * - `remote_punch` = 別の端末の打刻の案内から始めた (この端末ではカードを読んでいない)
 * - `nfc_card` = この端末で免許証でないカードを読んだ
 * - `manual` = 社員番号の手入力
 */
export const IDENTITY_METHOD = {
  LICENSE: 'license',
  IC_CARD: 'ic_card',
  REMOTE_PUNCH: 'remote_punch',
  NFC_CARD: 'nfc_card',
  MANUAL: 'manual',
} as const
export type IdentityMethod = (typeof IDENTITY_METHOD)[keyof typeof IDENTITY_METHOD]

/** 本人確認の方法の表示の文 (IT点呼 の受け画面) */
const IDENTITY_METHOD_LABEL: Record<IdentityMethod, string> = {
  license: '運転免許証',
  ic_card: '社員証',
  remote_punch: '社員証 (別の端末で打刻)',
  nfc_card: 'カード',
  manual: '手入力',
}

/** 本人確認の方法の表示の文。値が無い・知らない値は null (呼び手は行ごと出さない) */
export function identityMethodLabel(value: string | null | undefined): string | null {
  return value != null && Object.hasOwn(IDENTITY_METHOD_LABEL, value)
    ? IDENTITY_METHOD_LABEL[value as IdentityMethod]
    : null
}

/**
 * 社員証の IC カードで本人確認した回 (`ic_card`) にも IT点呼 を選べるようにするか。
 * **一時的な許容** (オーナーの決定 2026-10-02)。外すときは false にする — IT点呼 を
 * 選べるのは運転免許証の回だけに戻る (`identity_method` の記録は残る)。
 */
export const IT_TENKO_ALLOW_IC_CARD: boolean = true

/**
 * 判定パネルに最初に選んでおく確認の方法。着信から通話して開いたものは IT、
 * 一覧から通話なしで開いたものは対面
 */
export function defaultJudgmentMethod(viaCall: boolean): ManagerJudgmentMethod {
  return viaCall ? MANAGER_JUDGMENT_METHOD.IT : MANAGER_JUDGMENT_METHOD.IN_PERSON
}

/**
 * signaling の部屋の一覧を IT点呼 の部屋・画面共有の部屋・それ以外に分ける (順序は保つ)。
 * IT点呼 の受け画面は `it`、画面共有を見る部品は `screen`、遠隔点呼モニターは `remote` を使う
 */
export function splitRooms(rooms: readonly string[]): { it: string[], screen: string[], remote: string[] } {
  const it: string[] = []
  const screen: string[] = []
  const remote: string[] = []
  for (const room of rooms) {
    if (isItTenkoRoom(room)) it.push(room)
    else if (isScreenShareRoom(room)) screen.push(room)
    else remote.push(room)
  }
  return { it, screen, remote }
}

/** その点呼の記録の IT点呼 の部屋が一覧に在ればその部屋の id、無ければ null (未完了の一覧の「通話中」) */
export function itTenkoRoomOf(sessionId: string, rooms: readonly string[]): string | null {
  const roomId = itTenkoRoomId(sessionId)
  return rooms.includes(roomId) ? roomId : null
}
