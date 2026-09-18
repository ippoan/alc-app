import type { Ref } from 'vue'
import type { KioskScreen } from '~/utils/app-update-gate'

/**
 * キオスク画面の現在地を、**画面の外からも読める 1 か所**に置く (Refs #338 の項目 5)。
 *
 * ## なぜ要るか
 *
 * 本番 flip 後の新版への載せ替えは「点呼の最初の画面に居るとき」だけ許したいが、
 * 段 (`useTenkoKiosk` の `step`) は **component ごとに生える素の `ref`** で、
 * `useState` のような共有状態ではない。plugin から `useTenkoKiosk()` を呼び直しても
 * **別インスタンスができるだけ**で、その `step` は初期値のまま永久に動かない
 * — それを「最初の画面に居る」と読むと**点呼の最中でもリロードしてしまう**。
 *
 * なので「読める場所へ出す」側を 1 本用意する。`TenkoKiosk.vue` が
 * {@link useKioskScreen.track} で自分の段を流し込み、plugin は
 * {@link readKioskScreen} で読むだけ。**`useTenkoKiosk.ts` は触らない。**
 *
 * キオスクが載っていない画面 (管理画面など) では `null` のままで、
 * 載せ替えの対象にならない (Refs #338: 広げず「狭く確実に」)。
 */

/** シングルトン: いま載っているキオスク画面。載っていなければ `null`。 */
let current: KioskScreen | null = null

/** plugin 側の読み口。Vue の context を必要としない。 */
export function readKioskScreen(): KioskScreen | null {
  return current
}

/** テスト用の後始末 (本番の経路からは呼ばない)。 */
export function resetKioskScreen(): void {
  current = null
}

export function useKioskScreen() {
  /**
   * キオスク画面の現在地を流し込む。component の scope が終わったら `null` に戻す
   * (画面を離れたキオスクの段を、いつまでも「最初の画面」と読ませない)。
   */
  function track(source: Ref<KioskScreen> | (() => KioskScreen)): void {
    watch(source, (screen) => { current = screen }, { immediate: true })
    onScopeDispose(() => { current = null })
  }

  return { track, readKioskScreen }
}
