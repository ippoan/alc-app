import wasm from 'vite-plugin-wasm'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  runtimeConfig: {
    // server-only: /api/proxy が rust-alc-api を叩く backend URL (#434 step 2)。
    // 未設定なら public.apiBase に fallback する (proxy handler 側で実装)。
    alcApiUrl: process.env.NUXT_ALC_API_URL || '',
    public: {
      apiBase: process.env.NUXT_PUBLIC_API_BASE || 'http://localhost:3001',
      signalingUrl: process.env.NUXT_PUBLIC_SIGNALING_URL || 'http://localhost:8787',
      tenantId: process.env.NUXT_PUBLIC_TENANT_ID || 'default',
      googleClientId: process.env.NUXT_PUBLIC_GOOGLE_CLIENT_ID || '',
      authWorkerUrl: process.env.NUXT_PUBLIC_AUTH_WORKER_URL || 'https://auth.ippoan.org',
      stagingTenantId: process.env.NUXT_PUBLIC_STAGING_TENANT_ID || '',
      // staging export/import の X-Staging-Key (rust-alc-api#391 opt-in 認証)。空なら送らない
      stagingApiKey: process.env.NUXT_PUBLIC_STAGING_API_KEY || '',
      appVersion: process.env.NUXT_PUBLIC_APP_VERSION || 'dev',
    },
  },

  nitro: {
    preset: 'cloudflare_module',
  },

  modules: [
    '@nuxtjs/tailwindcss',
    '@vite-pwa/nuxt',
  ],

  vite: {
    plugins: [wasm()],
    optimizeDeps: {
      exclude: ['fc1200-wasm'],
    },
    build: {
      sourcemap: 'hidden',
    },
  },

  pwa: {
    registerType: 'autoUpdate',
    manifest: {
      name: 'アルコールチェッカー',
      short_name: 'ALC',
      theme_color: '#1e40af',
      background_color: '#ffffff',
      display: 'standalone',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    },
    workbox: {
      navigateFallback: null,
      // ランタイムキャッシュ戦略
      runtimeCaching: [
        {
          // human.js モデルファイル (CDN)
          urlPattern: /^https:\/\/vladmandic\.github\.io\/human-models\//,
          handler: 'CacheFirst',
          options: {
            cacheName: 'human-models',
            expiration: { maxEntries: 20, maxAgeSeconds: 30 * 24 * 60 * 60 },
            cacheableResponse: { statuses: [0, 200] },
          },
        },
        {
          // API: 測定履歴 (GET) — ネットワーク優先、オフライン時キャッシュ
          urlPattern: /\/api\/measurements(\?.*)?$/,
          handler: 'NetworkFirst',
          options: {
            cacheName: 'api-measurements',
            expiration: { maxEntries: 50, maxAgeSeconds: 24 * 60 * 60 },
            cacheableResponse: { statuses: [0, 200] },
            networkTimeoutSeconds: 5,
          },
        },
        {
          // API: 乗務員一覧 (GET)
          urlPattern: /\/api\/employees(\?.*)?$/,
          handler: 'NetworkFirst',
          options: {
            cacheName: 'api-employees',
            expiration: { maxEntries: 10, maxAgeSeconds: 24 * 60 * 60 },
            cacheableResponse: { statuses: [0, 200] },
            networkTimeoutSeconds: 5,
          },
        },
        {
          // 顔写真 (Cloud Storage signed URL)
          urlPattern: /storage\.googleapis\.com/,
          handler: 'CacheFirst',
          options: {
            cacheName: 'face-photos',
            expiration: { maxEntries: 100, maxAgeSeconds: 7 * 24 * 60 * 60 },
            cacheableResponse: { statuses: [0, 200] },
          },
        },
      ],
    },
  },
})
