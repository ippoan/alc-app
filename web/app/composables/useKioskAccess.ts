/**
 * 運行者タブ (キオスク) の入口を塞ぐかどうかの一括判定 (Refs #234)。
 *
 * 今までの「未登録」表示は isDeviceActivated (端末登録) 単体で判定していたが、
 * 運行管理者の PC (ログイン無しの共用 PC。端末登録もしない) は、CoreS3 が USB で
 * 挿さっている間だけその署名で短命 device JWT を取って動く (#231,
 * `useDeviceToken().hasDeviceJwt`)。この経路を isDeviceActivated は拾えないため、
 * 「ログイン済み / 端末登録済み / CoreS3 署名の短命 JWT を持つ」のどれか 1 つでも
 * 満たせばキオスクとして動いてよい、を 1 か所にまとめる。
 *
 * `useAuth.ts` には置かない — `useDeviceToken` が `useAuth` の `deviceTenantId` を
 * 読むため、逆向きに `useAuth` から `useDeviceToken` を呼ぶと相互依存になる。
 *
 * `isCheckingKioskAccess` (Refs #238): 起動時の 1 本 (`useDeviceToken().startupDeviceJwt`:
 * CoreS3 の探索 → 最初の端末 JWT の取得、上限 3 秒) が終わるまでは「まだ無い」と
 * 「このまま無い」を区別できない。その間は「未登録」の案内を出さず確認中として扱う。
 */
export function useKioskAccess() {
  const { isAuthenticated, isDeviceActivated } = useAuth()
  const { hasDeviceJwt, isStartupJwtPending } = useDeviceToken()

  const hasKioskAccess = computed(() =>
    isAuthenticated.value || isDeviceActivated.value || hasDeviceJwt.value,
  )

  const isCheckingKioskAccess = computed(() =>
    !hasKioskAccess.value && isStartupJwtPending.value,
  )

  return { hasKioskAccess, isCheckingKioskAccess }
}
