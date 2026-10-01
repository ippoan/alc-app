import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * vitest を workerd 上 (@cloudflare/vitest-pool-workers) で動かす (cf-alc-recorder と同構成)。
 *
 * wrangler.toml は読ませず miniflare options を手書きする:
 *   - `secrets_store_secrets` (INTERNAL_SHARED_SECRET) はテストでは扱えないので
 *     plain binding の固定文字列で注入する (コードは resolveSecret で両対応)。
 *   - AUTH_WORKER service binding は auxiliary worker (test/mocks/auth-worker.mjs)
 *     に差し替える (/auth/introspect のモック)。
 *   - 着信通知 (FCM) の `fetch(BACKEND_API_URL/...)` は outboundService で
 *     auxiliary worker (test/mocks/backend.mjs) に流し、叩かれた body を記録する。
 * binding 名 / DO class 名は wrangler.toml と一致させること (drift 注意)。
 */
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        main: "./src/index.ts",
        // RoomRegistry は singleton なので test 間で state が残る。テスト間の干渉は
        // 部屋 id の分離と後始末で避ける (cf-alc-recorder と同判断)。
        isolatedStorage: false,
        miniflare: {
          compatibilityDate: "2025-01-01",
          durableObjects: {
            SIGNALING_ROOM: { className: "SignalingRoom" },
            ROOM_REGISTRY: { className: "RoomRegistry" },
            CAMERA_SIGNALING_ROOM: { className: "CameraSignalingRoom" },
          },
          serviceBindings: { AUTH_WORKER: "auth-worker" },
          bindings: {
            INTERNAL_SHARED_SECRET: "test-shared-secret",
            BACKEND_API_URL: "https://backend.test",
          },
          outboundService: "backend",
          workers: [
            {
              name: "auth-worker",
              modules: true,
              scriptPath: "./test/mocks/auth-worker.mjs",
              compatibilityDate: "2025-01-01",
            },
            {
              name: "backend",
              modules: true,
              scriptPath: "./test/mocks/backend.mjs",
              compatibilityDate: "2025-01-01",
            },
          ],
        },
      },
    },
  },
});
