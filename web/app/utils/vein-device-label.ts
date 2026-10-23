/**
 * 指静脈の記録を「どの端末で登録したか」(サーバーの `registered_device_id`) の見せ方
 * (Refs ippoan/alc-app#436)。値は登録した端末の token の `sub`:
 * - `alarm:<鍵の指紋 16 hex>` … 鍵で端末になった機 (Vein Station など)
 * - それ以外 … 端末の登録簿の id (CoreS3 のキオスクなど)
 * - null / 無し … 分からない (管理者のログインで登録した・端末を記録する前の記録)
 *
 * 全端末の一覧の報告では、端末の id の `:` を `-` に替えている (`alarm-<指紋>`。recorder の字種のため)。
 * 見比べるときは {@link sameVeinDevice} を使う。
 */

/** 端末の id を画面の短い名前にする。分からなければ「不明」 */
export function veinDeviceLabel(id: string | null | undefined): string {
  if (!id) return '不明'
  const key = /^alarm[:-]([0-9a-f]{16})$/.exec(id)?.[1]
  if (key) return `Vein Station ${key.slice(0, 8)}`
  return id.slice(0, 8)
}

/** 2 つの端末の id が同じ端末か (`alarm:` と `alarm-` の違いを無視する) */
export function sameVeinDevice(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return a.replace(/^alarm:/, 'alarm-') === b.replace(/^alarm:/, 'alarm-')
}
