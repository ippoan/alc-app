/**
 * 本番が flip されたとき、開きっぱなしのキオスクが古い app shell を掴み続けないようにする
 * plugin (Refs ippoan/alc-app#338 の項目 5)。
 *
 * `nuxt.config.ts` の `pwa.registerType: 'prompt'` + `pwa.client.periodicSyncForUpdates`
 * と対。あちらが**検知**を担い (新 SW を waiting にして `$pwa.needRefresh` を立てる)、
 * ここが**いつ適用するか**を決める。判定そのものは `~/utils/app-update-gate` の純ロジックで、
 * 「点呼の最初の画面に居る = リロードで失うものが無い」ときだけ通す。キオスクの載っていない
 * 画面 (運行管理者席など) は、その画面が自分で「安全」と申告したときだけ (Refs #345)。
 *
 * `autoUpdate` に戻してはいけない — あちらの register は新 SW の `activated` で
 * 即 `window.location.reload()` するので、**測定中・入力中でも問答無用で飛ぶ。**
 *
 * `$pwa` は `@vite-pwa/nuxt` が `enforce: 'post'` で provide する。plugin の登録順に
 * 依存しないよう `dependsOn` は使わず、**tick のたびに遅延で引く**。PWA が無効な
 * 環境 (dev / テスト) では `$pwa` が生えないので、その場合は何もしない。
 */

import {
  APP_UPDATE_NOTICE_MS,
  APP_UPDATE_RELOAD_REASON,
  APP_UPDATE_TICK_MS,
  createAppUpdateGate,
} from '~/utils/app-update-gate'
import { readReloadContext } from '~/composables/useKioskScreen'
import { RELOAD_REASON_KEY } from '~/utils/reload-reason'

/** 告知を出す要素の id (二重挿入の抑止に使う)。 */
const NOTICE_ID = 'app-update-notice'

const NOTICE_STYLE =
  'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;'
  + 'padding:1.5rem;text-align:center;background:rgba(255,255,255,0.95);color:#111111;'
  + 'font-size:1.25rem;line-height:1.6'

/** `$pwa` のうちここが使う部分だけ。型は @vite-pwa/nuxt 側に依存させない。 */
interface PwaLike {
  needRefresh: { value: boolean }
  updateServiceWorker: (reloadPage?: boolean) => void
}

/** 新版がある旨を画面に出す (無言で飛ばさない)。 */
function renderNotice(message: string): void {
  if (document.getElementById(NOTICE_ID)) return

  const el = document.createElement('div')
  el.id = NOTICE_ID
  el.setAttribute('style', NOTICE_STYLE)
  el.textContent = message
  document.body.appendChild(el)
}

export default defineNuxtPlugin({
  name: 'app-update',
  enforce: 'post',
  setup(nuxtApp) {
    const pwaOf = (): PwaLike | undefined =>
      (nuxtApp as unknown as { $pwa?: PwaLike }).$pwa

    const gate = createAppUpdateGate({
      context: readReloadContext,
      noticeMs: APP_UPDATE_NOTICE_MS,
      notice: renderNotice,
      beforeApply: () => {
        const at = new Date().toLocaleTimeString('ja-JP')
        sessionStorage.setItem(RELOAD_REASON_KEY, `${APP_UPDATE_RELOAD_REASON} at ${at}`)
        console.warn(`[RELOAD-DETECT] ${at} ${APP_UPDATE_RELOAD_REASON}: applying waiting service worker`)
        // event handler の中では Nuxt の context が無いので明示的に載せる
        // (握っている警告デバイス / CoreS3 を意図的リロードで鳴らさないため)
        void nuxtApp.runWithContext(() => useAlarmDevice().notifyIntentionalReload())
      },
      // `updateServiceWorker()` が skipWaiting を送り、controlling でページがリロードされる
      apply: () => pwaOf()?.updateServiceWorker(),
      schedule: (fn, ms) => { window.setTimeout(fn, ms) },
    })

    window.setInterval(() => {
      if (pwaOf()?.needRefresh.value === true) gate.markUpdateAvailable()
      gate.tick()
    }, APP_UPDATE_TICK_MS)
  },
})
