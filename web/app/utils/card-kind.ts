/**
 * かざしたカードの種別を 3 値に畳み込む 1 か所 (Refs ippoan/rust-alc-api#644)。
 *
 * サーバの `card_kind` は `'license'` / `'felica_idm'` / `'nfca_uid'` / `null`
 * を返す (`null` はブラウザ経由の打刻や、種別が記録されていない古い行)。
 * **`null` を「その他」に倒さない** — ブラウザ経由の打刻は実態として免許証の
 * 読み取りが主なので、「その他」と表示すると嘘になる。`'unknown'` (画面では
 * 「—」) が正直。
 *
 * サーバがこのフィールドをまだ返さない間 (#c644-5 が未反映) は `undefined` に
 * なりうるので、型では表さず防御的に受け取る。
 */
export type CardKind = 'license' | 'other' | 'unknown'

export function cardKindOf(k: string | null | undefined): CardKind {
  if (k === 'license') return 'license'
  if (k === 'felica_idm' || k === 'nfca_uid') return 'other'
  return 'unknown'
}
