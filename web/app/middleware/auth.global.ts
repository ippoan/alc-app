/** 管理ページの認証ミドルウェア */
export default defineNuxtRouteMiddleware((to) => {
  // Staging bypass: NUXT_PUBLIC_STAGING_TENANT_ID 設定時は認証スキップ
  const config = useRuntimeConfig()
  if (config.public.stagingTenantId) return

  const protectedPaths = ['/register', '/maintenance']

  if (!protectedPaths.some(p => to.path.startsWith(p))) {
    return // 測定ページ・ログインページは認証不要
  }

  const { isAuthenticated, isLoading } = useAuth()

  // 初期化中はスキップ (init() が完了するまで待つ)
  if (isLoading.value) return

  if (!isAuthenticated.value) {
    return navigateTo('/login')
  }
})
