/**
 * 画面から Vein Station を再起動する (USB の信号でチップをリセット、`useVeinSerial().restart`)。
 * 遠隔で操作していると USB の抜き差しができないため。
 *
 * 再起動しても画面から見て USB の口が切れないことがあり (useSerialOta の冒頭 doc)、つないだときの
 * 準備 (端末の鍵・照合データ・血圧計の設定) がやり直されない。機体が起き上がる間を置いてから
 * ページを読み込み直して、準備を最初からやり直す (USB の OTA の後と同じ扱い)。
 */

import { reloadPage } from '~/utils/page-reload'

/** 再起動を頼んでからページを読み込み直すまで (機体の起動を待つ間) */
export const VEIN_RESTART_RELOAD_MS = 5_000

/** ページの読み込み直し。試験は `run` を差し替える (jsdom は `location.reload` を持たない) */
export const veinRestartReload = {
  run: reloadPage,
}

/** 再起動を頼み、{@link VEIN_RESTART_RELOAD_MS} 後にページを読み込み直す。頼めなければ投げる (読み込まない) */
export async function restartVeinAndReload(restart: () => Promise<void>): Promise<void> {
  await restart()
  setTimeout(() => veinRestartReload.run(), VEIN_RESTART_RELOAD_MS)
}
