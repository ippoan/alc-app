/**
 * カード ID の正規化。**rust-alc-api の `normalize_card_id` と同じ規則**
 * (`crates/alc-core/src/repository/timecard.rs`、Refs ippoan/alc-app-s3#134)。
 *
 * 同じ物理カードでも読み取り側で表記が揺れる (NFC タイムカード端末は `%02X` の
 * 大文字 IDm、ローカル NFC ブリッジは小文字、`AA:BB:..` と区切る実装もある)。
 * サーバは `timecard_cards.card_id` を正規化形 (小文字) で持つので、
 * **端末の生値 (ハブ測定値の payload) で引くときは必ずこれを通す。**
 *
 * 免許証の `employees.nfc_id` (交付日 8 桁 + 有効期限 8 桁 = 16 桁の数字) に
 * 対しては no-op なので、免許証経路には影響しない。
 *
 * 両者がずれると「登録済みなのに『未登録カード』と表示される」形で壊れる。
 * 規則を変えるときは必ずサーバ側と同時に変えること。
 */
export function normalizeCardId(cardId: string): string {
  return cardId.trim().toLowerCase().replace(/:/g, '')
}
