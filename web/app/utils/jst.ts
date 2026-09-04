/**
 * JST (Asia/Tokyo, UTC+9) の暦日ユーティリティ。
 *
 * **このアプリの「今日」は JST 固定**で、サーバ側もそう作られている
 * (rust-alc-api の `list_today_punches` が `Asia/Tokyo`、CSV 出力が
 * `FixedOffset::east(9h)`)。ブラウザのローカル時刻で切ると、**JST 以外に
 * 設定された端末でサーバと「今日」が食い違う** (Refs ippoan/alc-app-s3#134)。
 *
 * 日本には夏時間が無いので固定オフセットで足りる。
 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/**
 * JST の「今日」の 0 時を ISO 文字列 (UTC 表記) で返す。
 * API の `date_from` にそのまま渡せる。
 */
export function jstTodayStartIso(now: Date = new Date()): string {
  // +9h してから UTC として日付を切り出すと JST の暦日になる
  const shifted = new Date(now.getTime() + JST_OFFSET_MS)
  const midnightUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  )
  // その暦日の JST 0 時 = UTC 0 時 − 9h
  return new Date(midnightUtc - JST_OFFSET_MS).toISOString()
}

/**
 * JST の「今日」を `YYYY-MM-DD` で返す (`<input type="date">` の初期値用)。
 *
 * **`new Date().toISOString().slice(0, 10)` は UTC の日付**なので、JST の
 * 00:00〜09:00 のあいだは「昨日」になる。日付を UTC で決めて範囲だけ `+09:00`
 * で作ると、**正しい範囲を間違った日に対して**引くことになる。
 */
export function jstTodayDate(now: Date = new Date()): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10)
}
