<script setup lang="ts">
import { StagingFooter, VersionBadge } from '@ippoan/auth-client'

const { init, isLoading } = useAuth()
const { isAndroidApp } = useFingerprint()
const config = useRuntimeConfig()
const apiBase = config.public.apiBase as string
const stagingTenantId = config.public.stagingTenantId as string
const stagingApiKey = config.public.stagingApiKey as string
const appVersion = config.public.appVersion as string

onMounted(async () => {
  // --- リロード検知ログ ---
  const now = Date.now()
  const navEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  const navType = navEntry?.type ?? 'unknown'
  const lastLoad = Number(sessionStorage.getItem('_lastLoad') || '0')
  const gap = lastLoad ? ((now - lastLoad) / 1000).toFixed(1) : null
  sessionStorage.setItem('_lastLoad', String(now))
  const ts = new Date().toLocaleTimeString('ja-JP')
  if (gap && Number(gap) < 10) {
    console.warn(`[RELOAD-DETECT] ${ts} SUSPICIOUS RELOAD — last load was ${gap}s ago, navType=${navType}`)
  } else {
    console.log(`[RELOAD-DETECT] ${ts} page loaded (gap=${gap ?? 'first'}s, navType=${navType})`)
  }
  document.addEventListener('visibilitychange', () => {
    console.log(`[RELOAD-DETECT] visibility=${document.visibilityState} at ${new Date().toLocaleTimeString('ja-JP')}`)
  })

  await init()
})

useHead({
  htmlAttrs: {
    class: computed(() => isAndroidApp.value ? 'android-app' : ''),
  },
})
</script>

<template>
  <div class="min-h-screen flex flex-col bg-gray-50">
    <NuxtRouteAnnouncer />
    <div v-if="isLoading" class="flex-1 flex items-center justify-center">
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
