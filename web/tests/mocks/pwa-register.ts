import { ref } from 'vue'

// virtual:pwa-register/vue のテスト用スタブ。
// Windows では vitest (environment: nuxt) がこの virtual module を
// `file:///@vite-plugin-pwa/...` として解決しようとして落ちるため、
// fc1200-wasm と同様に alias で差し替える (テストは Service Worker を使わない)。
export function useRegisterSW() {
  return {
    needRefresh: ref(false),
    offlineReady: ref(false),
    updateServiceWorker: async () => {},
  }
}
