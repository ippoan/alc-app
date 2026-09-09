<script setup lang="ts">
import { StagingFooter, VersionBadge } from '@ippoan/auth-client'
import { RELOAD_REASON_KEY } from '~/utils/reload-reason'

const { init, isLoading } = useAuth()
const { isAndroidApp } = useFingerprint()
const config = useRuntimeConfig()
const apiBase = config.public.apiBase as string
const stagingTenantId = config.public.stagingTenantId as string
const stagingApiKey = config.public.stagingApiKey as string
const appVersion = config.public.appVersion as string

onMounted(async () => {
  // --- リロード検知ログ (Refs #197) ---
  // reason は plugins/reload-grace.client.ts が chunk 読み込み失敗の自動復旧 reload の直前に書く。
  // 無ければ利用者の F5 か Chrome のメモリセーバー (タブ破棄 → 復帰は document.wasDiscarded)
  const now = Date.now()
  const navEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  const navType = navEntry?.type ?? 'unknown'
  const lastLoad = Number(sessionStorage.getItem('_lastLoad') || '0')
  const gap = lastLoad ? ((now - lastLoad) / 1000).toFixed(1) : null
  sessionStorage.setItem('_lastLoad', String(now))
  const reason = sessionStorage.getItem(RELOAD_REASON_KEY) ?? 'unknown (user/memory-saver?)'
  sessionStorage.removeItem(RELOAD_REASON_KEY)
  const discarded = (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true
  const ts = new Date().toLocaleTimeString('ja-JP')
  const detail = `navType=${navType}, discarded=${discarded}, reason=${reason}`
  if (gap && Number(gap) < 10) {
    console.warn(`[RELOAD-DETECT] ${ts} SUSPICIOUS RELOAD — last load was ${gap}s ago, ${detail}`)
  } else {
    console.log(`[RELOAD-DETECT] ${ts} page loaded (gap=${gap ?? 'first'}s, ${detail})`)
  }
  const stamp = () => new Date().toLocaleTimeString('ja-JP')
  document.addEventListener('visibilitychange', () => {
    console.log(`[RELOAD-DETECT] visibility=${document.visibilityState} at ${stamp()}`)
  })
  // Page Lifecycle: freeze/resume はメモリセーバーの前段、pagehide/beforeunload は reload・閉じる
  document.addEventListener('freeze', () => console.log(`[RELOAD-DETECT] freeze at ${stamp()}`))
  document.addEventListener('resume', () => console.log(`[RELOAD-DETECT] resume at ${stamp()}`))
  // 利用者の F5 / タブ閉じでも、握っている警告デバイス / CoreS3 へ grace を送っておく (best-effort。
  // 書き込みが reload に間に合わないこともあるが、間に合えば 45 秒は鳴らない。Refs ippoan/alc-app-s3#192)
  const alarm = useAlarmDevice()
  window.addEventListener('pagehide', (e) => {
    console.log(`[RELOAD-DETECT] pagehide persisted=${e.persisted} at ${stamp()}`)
    alarm.notifyIntentionalReload()
  })
  window.addEventListener('beforeunload', () => {
    console.log(`[RELOAD-DETECT] beforeunload at ${stamp()}`)
    alarm.notifyIntentionalReload()
  })

  await init()
})

// --- PWA manifest の出し分け (Refs #179) ---
// 運行管理者だけ `id` / `start_url` の違う manifest を指し、Chrome に「点呼キオスク」とは
// 別のアプリとしてインストールさせる。トップ画面ではなくここで出すのは、認証の初期化中は
// 下のテンプレートがスピナーだけを描き NuxtPage が動かないため — SSR の HTML に link が
// 乗らないと Chrome が初回ロード時点で manifest を読めない。
// `start_url` の `?role=manager` はトップ画面の activeRole が読むので、インストールした
// アプリから起動したときもロールが保たれる。
const route = useRoute()
const manifestRole = computed(() => manifestRoleFromQuery(route.query))
const { manifestHref, themeColor } = useRoleManifest(manifestRole)

// --- 二重起動の検知 (Refs #204) ---
// 同じ role の PWA / タブが既に開いていれば案内を出して本体を描かない。
// OS からの PWA 起動は manifest の launch_handler (focus-existing) が既存ウィンドウへ寄せる。
const { duplicate, closeWindow } = useSingleInstance(manifestRole)

useHead({
  htmlAttrs: {
    class: computed(() => isAndroidApp.value ? 'android-app' : ''),
  },
  link: [{ rel: 'manifest', href: manifestHref }],
  meta: [{ name: 'theme-color', content: themeColor }],
})
</script>

<template>
  <div class="min-h-screen flex flex-col bg-gray-50">
    <NuxtRouteAnnouncer />
    <div v-if="duplicate" class="flex-1 flex items-center justify-center p-6">
      <div class="w-full max-w-md bg-white rounded-xl shadow p-8 text-center">
        <p class="text-xl font-bold text-gray-900">このアプリは既に開いています。</p>
        <p class="mt-2 text-gray-600">開いている方を使ってください。</p>
        <button
          type="button"
          class="mt-6 px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
          @click="closeWindow"
        >
          このウィンドウを閉じる
        </button>
      </div>
    </div>
    <div v-else-if="isLoading" class="flex-1 flex items-center justify-center">
      <div class="animate-spin h-8 w-8 border-4 border-blue-500 border-t-transparent rounded-full" />
    </div>
    <NuxtPage v-else />
    <StagingFooter :api-base="apiBase" :tenant-id="stagingTenantId" :staging-api-key="stagingApiKey" />
    <VersionBadge :api-base="apiBase" :frontend-version="appVersion" />
  </div>
</template>

<style>
@media (min-width: 600px) {
  .android-app {
    font-size: 24px;
  }
}
</style>
