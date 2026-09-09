/**
 * chunk 読み込み失敗の自動復旧 reload の直前に、警告デバイス / CoreS3 へ ` grace=45` 付きの
 * heartbeat を送り、reload の理由を sessionStorage に残す
 * (Refs ippoan/alc-app#197, ippoan/alc-app-s3#192)。
 *
 * 実際に reload するのは `@ippoan/auth-client/module` が注入する chunkReload plugin
 * (Refs ippoan/auth-worker#452)。あちらは `app:chunkError` hook と window の
 * `vite:preloadError` / `unhandledrejection` の 3 入口から同じ `recover()` に入り、失敗した
 * chunk を `fetch(url, { cache: 'reload' })` で取り直してから `location.reload()` する。
 * Nuxt の hook は登録順に直列で呼ばれ、window のリスナーも登録順なので `enforce: 'pre'` で
 * あちらより先に登録する。仮に後になっても、あちらは取り直しの fetch を await してから
 * reload するので、同期的に書き込むここは間に合う。
 *
 * 理由は `app.vue` の `[RELOAD-DETECT] page loaded … reason=<理由>` が起動時に読んで消す。
 * 理由が残っていない reload は利用者の F5 か Chrome のメモリセーバー (`document.wasDiscarded`)。
 */

import { RELOAD_REASON_KEY } from '~/utils/reload-reason'

/** unknown なエラー値から message 相当の文字列を取り出す */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return ''
}

/**
 * chunk 読み込み失敗が原因の reject か。`unhandledrejection` は無関係な reject も拾うので、
 * この入口だけ判定を通す (chunkReload plugin と同じ 3 文言)
 */
export function isChunkLoadError(message: string): boolean {
  return message.includes('dynamically imported module')
    || message.includes('Importing a module script failed')
    || message.includes('Loading chunk')
}

/** 失敗した chunk の URL (無ければ message の先頭) */
function describeChunkError(message: string): string {
  return message.match(/https?:\/\/[^\s'"()]+\.(?:m?js|css)/)?.[0] ?? message.slice(0, 120)
}

export default defineNuxtPlugin({
  name: 'reload-grace',
  enforce: 'pre',
  setup(nuxtApp) {
    function beforeRecoveryReload(kind: string, error: unknown): void {
      const detail = describeChunkError(errorMessage(error))
      const at = new Date().toLocaleTimeString('ja-JP')
      sessionStorage.setItem(RELOAD_REASON_KEY, `${kind} ${detail} at ${at}`)
      console.warn(`[RELOAD-DETECT] ${at} ${kind}: ${detail} -> sending grace before auto-recovery reload`)
      // event handler の中では Nuxt の context が無いので明示的に載せる
      void nuxtApp.runWithContext(() => useAlarmDevice().notifyIntentionalReload())
    }

    nuxtApp.hook('app:chunkError', ({ error }) => beforeRecoveryReload('chunkError', error))

    window.addEventListener('vite:preloadError', (event) => {
      beforeRecoveryReload('vite:preloadError', (event as Event & { payload?: unknown }).payload)
    })

    window.addEventListener('unhandledrejection', (event) => {
      if (isChunkLoadError(errorMessage(event.reason))) beforeRecoveryReload('unhandledrejection', event.reason)
    })
  },
})
