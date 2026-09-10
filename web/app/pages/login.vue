<script setup lang="ts">
const { loginWithGoogleRedirect, isAuthenticated, isLoading, isDeviceActivated } = useAuth()
const route = useRoute()

// 認証済みならリダイレクト (redirect クエリがあればそちらへ、なければ admin タブ)
watch(isAuthenticated, (val) => {
  if (!val) return
  const redirect = route.query.redirect as string
  if (redirect) {
    navigateTo(redirect)
  } else {
    navigateTo({ path: '/', query: { role: 'admin' } })
  }
}, { immediate: true })

function handleLogin() {
  const redirect = route.query.redirect as string | undefined
  loginWithGoogleRedirect(redirect)
}
</script>

<template>
  <div class="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-4">
    <div class="bg-white rounded-2xl p-8 shadow-sm max-w-sm w-full text-center">
      <h1 class="text-2xl font-bold text-gray-800 mb-2">管理者ログイン</h1>
      <p class="text-sm text-gray-500 mb-6">
        Google アカウントでログインしてください
      </p>

      <div v-if="isLoading" class="text-gray-400 text-sm">
        読み込み中...
      </div>

      <template v-else>
        <button
          class="w-full flex items-center justify-center gap-3 px-6 py-3 border border-gray-300 rounded-xl bg-white hover:bg-gray-50 transition-colors font-medium text-gray-700"
          @click="handleLogin"
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
          </svg>
          Google でログイン
        </button>

        <p
          v-if="isDeviceActivated"
          class="mt-4 text-left text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3"
        >
          共用端末です。Google の「アカウントを選択」に前の利用者の名前が残っているときは、その名前の右のメニューから「アカウントの削除」を選んで消してください。ログアウトだけでは一覧から消えません。
        </p>
      </template>

      <NuxtLink to="/" class="block mt-6 text-sm text-blue-600 hover:underline">
        測定画面へ戻る
      </NuxtLink>
    </div>
  </div>
</template>
