import wasm from 'vite-plugin-wasm'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  // auth-client の SSR 認証状態 (opt-in、Refs ippoan/auth-worker#560)。
  // server が cookie から認証の判定 (expiresAt / orgId / username) を決めて useState に載せる。
  // payload に生 JWT は載らない。戻すときはこの 1 行を消す。
  ippoanAuthClient: { authState: true },
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  runtimeConfig: {
    // server-only: /api/proxy が rust-alc-api を叩く backend URL (#434 step 2)。
    // 未設定なら public.apiBase に fallback する (proxy handler 側で実装)。
    alcApiUrl: process.env.NUXT_ALC_API_URL || '',
    public: {
      apiBase: process.env.NUXT_PUBLIC_API_BASE || 'http://localhost:3001',
      signalingUrl: process.env.NUXT_PUBLIC_SIGNALING_URL || 'http://localhost:8787',
      // cf-alc-recorder (打刻更新の購読 WS `/watch-timecard`、Refs
      // ippoan/alc-app-s3#134)。`https://` を渡す — composable が `ws://` に直す
      recorderUrl: process.env.NUXT_PUBLIC_RECORDER_URL || 'https://alc-recorder.m-tama-ramu.workers.dev',
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

  // chunk load 失敗 (immutable キャッシュされた `/_nuxt/*.js` の 404) からの自動復旧。
  // `experimental.emitRouteChunkError = 'manual'` と transpile 登録も module 側が行う
  // ので consumer は 1 行で済む (Refs ippoan/auth-worker#452)。
  modules: [
    '@nuxtjs/tailwindcss',
    '@vite-pwa/nuxt',
    '@ippoan/auth-client/module',
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
    // ★ `autoUpdate` に戻さないこと (Refs #338 の項目 5)。
    // `autoUpdate` は (1) `skipWaiting` / `clientsClaim` を入れて**走行中のページの足元で**
    // 新 SW を activate させ、(2) register が `activated` で即 `window.location.reload()` する
    // ため、**点呼の測定中・入力中でも問答無用でタブが飛ぶ**。
    // `prompt` なら新 SW は waiting で待ち `$pwa.needRefresh` が立つだけなので、
    // 「いつ適用するか」を `app/plugins/app-update.client.ts` が決められる
    // (無操作が続いたとき = 点呼をしていないときだけ、告知してから入れ替える)。
    registerType: 'prompt',
    client: {
      // ★ 既定は `0` = **定期チェックが 1 度も走らない**。ブラウザが Service Worker の更新を
      // 見に行くのはナビゲーション時だけなので、24 時間開きっぱなしのキオスクは本番の flip を
      // 永久に知らず、古い app shell を掴み続けて遅延 chunk が 404 になっていた (#338 の引き金)。
      // 5 分ごとに `registration.update()` を打たせる (取りに行くのは sw.js 1 本)。
      periodicSyncForUpdates: 300,
    },
    // manifest は module に生成させず `public/manifest-{driver,manager}.webmanifest` を
    // 静的に置き、トップ画面が `?role=` に応じて `<link rel="manifest">` を出し分ける
    // (Refs #179)。`false` にすると module は manifest の生成も link の自動注入もしないので、
    // manifest link が 2 本になって Chrome が先頭だけ使う事故を避けられる。
    // Service Worker (下の workbox) は 1 つのまま。
    manifest: false,
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
