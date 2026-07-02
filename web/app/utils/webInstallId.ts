// re-pair (再認証) の TOFU hardware bind 用フォールバック識別子 (Refs
// rust-alc-api#495)。Android bridge の `getHardwareId()` (ANDROID_ID ベース、
// PR4/任意) が無い web/PC 環境向けに、localStorage に永続する乱数 UUID を
// 「この端末インストール」の識別子として使う。
const WEB_INSTALL_ID_KEY = 'alc_web_install_id'

/** localStorage に保存された web install id を返す。無ければ新規発行して保存する。 */
export function getOrCreateWebInstallId(): string {
  if (typeof window === 'undefined') return ''
  let id = localStorage.getItem(WEB_INSTALL_ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(WEB_INSTALL_ID_KEY, id)
  }
  return id
}
