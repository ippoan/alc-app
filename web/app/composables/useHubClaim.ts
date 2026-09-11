/**
 * CoreS3 が USB で繋がったら、短命端末 JWT (#234-2 の CoreS3 署名) を 1 回先取りする。
 *
 * かつては CoreS3 の `AUTH TICKET` → `/device/pair/token` で永続 credential を発行し、
 * 管理者ログイン無しで端末登録まで済ませていた (#213)。だが応答が alc.ippoan.org から
 * 読めずブラウザで一度も成功していなかったため撤去した。CoreS3 が USB で繋がっている
 * あいだは `useDeviceToken` の署名先が CoreS3 に切り替わっており (#234-2)、
 * `getDeviceJwt()` を呼べば nonce 取得・署名・mint まで自力で完結する。ここは
 * 「繋がったら 1 回呼んでおく」だけの先取りに縮小した (isDeviceActivated には無関係に動く)。
 * 起動時の 1 本 (`useDeviceToken().startupDeviceJwt`: CoreS3 の探索 → 最初の端末 JWT の取得、
 * 上限 3 秒) もここで 1 回だけ始める (Refs ippoan/alc-app#238)。
 *
 * ファイル名と戻り値の形 `{ lastError, attemptClaim }` は据え置く
 * (`TimePunchKiosk.vue` が `useHubClaim().lastError` を参照するため)。
 * `lastError` は useDeviceToken のもの (CoreS3 署名経路の失敗理由) をそのまま返す。
 */

/** CoreS3 の接続 (再接続含む) のたびに 1 回試すための onOpen 登録 (module 内で 1 度だけ) */
let listenerInstalled = false

export function useHubClaim() {
  const { getDeviceJwt, lastError, startupDeviceJwt } = useDeviceToken()
  const coreS3 = useCoreS3Serial()

  /** CoreS3 接続中に device JWT を先取りする (getDeviceJwt 自体が single-flight/cache を持つ) */
  async function attemptClaim(): Promise<void> {
    await getDeviceJwt()
  }

  // CoreS3 の接続 (再接続含む) のたびに 1 回試す。listenerInstalled で二重登録を避ける
  // (useHubClaim() は app.vue と TimePunchKiosk.vue の双方から呼ばれる想定)
  if (!listenerInstalled) {
    listenerInstalled = true
    coreS3.onOpen(() => { void attemptClaim() })
    // 起動時の 1 本 (CoreS3 の探索 ≤3 秒 + 最初の端末 JWT の取得) をここで始める。
    // onOpen の attemptClaim は起動中なら同じ in-flight に合流する (二重取得にならない)。
    // 繋がると 3 秒ごとの `HB OK` が全ページで始まるが、運行者端末では NFC の画面で既に同じことが起きている
    void startupDeviceJwt()
  }

  return {
    lastError,
    attemptClaim,
  }
}
