/**
 * reload の理由の置き場 (sessionStorage の key)。
 *
 * 書くのは plugins/reload-grace.client.ts (chunk 読み込み失敗の自動復旧 reload の直前)、
 * 読んで消すのは app.vue の `[RELOAD-DETECT] page loaded … reason=<理由>` (Refs ippoan/alc-app#197)。
 */
export const RELOAD_REASON_KEY = 'reload_reason'
