<script setup lang="ts">
const { consumeAuthCookie, isAuthenticated } = useAuth()
const route = useRoute()
const error = ref<string | null>(null)

// #434: Google OAuth は auth-worker が orchestrate し、logi_auth_token cookie で
// ログインを配布する。callback では cookie を消費するだけ (code 交換は auth-worker)。
onMounted(() => {
  const queryError = route.query.error as string
  if (queryError) {
    error.value = `Google 認証エラー: ${queryError}`
    return
  }

  if (!consumeAuthCookie()) {
    error.value = 'ログインに失敗しました (認証情報が見つかりません)'
    return
  }

  // ログイン成功 → リダイレクト先へ
  const redirect = sessionStorage.getItem('oauth_redirect') || '/?role=admin'
  sessionStorage.removeItem('oauth_redirect')
  navigateTo(redirect)
})
</script>

<template>
  <div class="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-4">
    <div class="bg-white rounded-2xl p-8 shadow-sm max-w-sm w-full text-center">
      <template v-if="error">
        <h1 class="text-xl font-bold text-red-600 mb-4">ログイン失敗</h1>
        <p class="text-sm text-gray-600 mb-6">{{ error }}</p>
        <NuxtLink
          to="/login"
          class="inline-block px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
        >
          ログイン画面へ戻る
        </NuxtLink>
      </template>
      <template v-else>
        <p class="text-gray-500">認証中...</p>
      </template>
    </div>
  </div>
</template>
