import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * vitest を workerd 上 (@cloudflare/vitest-pool-workers) で動かす (ui-preview と同構成)。
 *
 * wrangler.toml は読ませず miniflare options を手書きする:
 *   - `secrets_store_secrets` (INTERNAL_SHARED_SECRET) はテストでは扱えないので
 *     plain binding の固定文字列で注入する (コードは resolveSecret で両対応)。
 *   - AUTH_WORKER service binding は auxiliary worker (test/mocks/auth-worker.mjs)
 *     に差し替える (/auth/introspect と /alc-internal-proxy の両モック + spy)。
 * binding 名 / DO class 名は wrangler.toml と一致させること (drift 注意)。
 */
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        main: "./src/index.ts",
        // SQLite-backed DO の per-test 隔離ストレージは既知問題があるため無効化
        // (ui-preview と同判断)。テスト間の干渉は tenant 名の分離と後始末で避ける。
        isolatedStorage: false,
        miniflare: {
          compatibilityDate: "2025-07-15",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            RECORDER_HUB: { className: "RecorderHub", useSQLite: true },
          },
          serviceBindings: { AUTH_WORKER: "auth-worker" },
          bindings: { INTERNAL_SHARED_SECRET: "test-shared-secret" },
          r2Buckets: { CRASH_LOGS: "alc-crash-logs", BATTERY_HISTORY: "alc-battery-history" },
          workers: [
            {
              name: "auth-worker",
              modules: true,
              scriptPath: "./test/mocks/auth-worker.mjs",
              compatibilityDate: "2025-07-15",
            },
          ],
        },
      },
    },
  },
});
