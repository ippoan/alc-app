import type { Ref } from 'vue'
import type { KioskScreen, ReloadContext } from '~/utils/app-update-gate'

/**
 * 「いまリロードして失うものが無いか」の材料を、**画面の外からも読める 1 か所**に置く
 * (Refs #338 の項目 5 / #345)。
 *
 * ## なぜ要るか
 *
 * 本番 flip 後の新版への載せ替えは「失うものが無いとき」だけ許したいが、その判定材料は
 * **component ごとに生える素の `ref`** で、`useState` のような共有状態ではない。plugin から
 * `useTenkoKiosk()` を呼び直しても **別インスタンスができるだけ**で、その `step` は初期値の
 * まま永久に動かない — それを「最初の画面に居る」と読むと**点呼の最中でもリロードしてしまう**。
 *
 * なので「読める場所へ出す」側を 1 本用意する。画面側が {@link useKioskScreen} の口で
 * 自分の状態を流し込み、plugin は {@link readReloadContext} で読むだけ。
 * **`useTenkoKiosk.ts` は触らない。**
 *
 * ## 口は 3 つ — キオスクは現在地、それ以外は opt-in の申告
 *
 * - {@link useKioskScreen.track} — キオスクが自分の段を流し込む (`TenkoKiosk.vue`)
 * - {@link useKioskScreen.declareSafeToReload} — キオスクの載っていない画面が
 *   「いまリロードして失うものが無い」と**明示的に申告**する
 * - {@link useKioskScreen.declareReloadBlocked} — 同じ画面の中の別の component が
 *   「いまは困る」と**拒否**する (拒否が 1 件でもあれば申告より優先)
 *
 * 運行管理者席は遠隔点呼の呼び出しを待って**画面を開いたまま待機する**ので、キオスクと
 * まったく同じ形で古い app shell を掴み続ける (Refs #345。#341 の取りこぼし)。かといって
 * 「キオスクが載っていなければ安全」にすると、編集中・保存中の管理画面まで巻き込んで
 * リロードしてしまう。だから**申告した画面だけを安全**にする — 誰も申告していない画面
 * (システム管理など) は従来どおり載せ替えの対象にならない。後から 1 component ずつ足せる。
 */

/** シングルトン: いま載っているキオスク画面。載っていなければ `null`。 */
let current: KioskScreen | null = null

/**
 * 申告中の component を表すトークンの集合。**数ではなく集合で持つ**のが肝 —
 * 同じ画面が二重に載る瞬間 (`pages/index.vue` の `:key` 再マウント) があっても、
 * 破棄した側は**自分のトークンだけ**を取り下げるので、残っている側の申告を巻き添えにしない。
 */
const safeDeclarations = new Set<object>()
const blockedDeclarations = new Set<object>()

/** plugin 側の読み口。Vue の context を必要としない。 */
export function readReloadContext(): ReloadContext {
  return { screen: current, safe: safeDeclarations.size, blocked: blockedDeclarations.size }
}

/** テスト用の後始末 (本番の経路からは呼ばない)。 */
export function resetReloadContext(): void {
  current = null
  safeDeclarations.clear()
  blockedDeclarations.clear()
}

/**
 * `source` が真のあいだだけ `registry` に載る申告を 1 件登録する。
 *
 * `flush: 'sync'` にしてあるのは、**状態が変わった瞬間に申告が動く**ようにするため。
 * 既定の `'pre'` だと取り下げが次の tick まで遅れ、その隙に「安全」と読まれうる。
 */
function declare(registry: Set<object>, source: Ref<boolean> | (() => boolean)): void {
  const token = {}
  watch(source, (on) => {
    if (on) registry.add(token)
    else registry.delete(token)
  }, { immediate: true, flush: 'sync' })
  onScopeDispose(() => { registry.delete(token) })
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

  /** この画面は「いまリロードして失うものが無い」と申告する (真のあいだだけ)。 */
  function declareSafeToReload(source: Ref<boolean> | (() => boolean)): void {
    declare(safeDeclarations, source)
  }

  /** この画面は「いまリロードされると困る」と申告する (真のあいだだけ)。 */
  function declareReloadBlocked(source: Ref<boolean> | (() => boolean)): void {
    declare(blockedDeclarations, source)
  }

  return { track, declareSafeToReload, declareReloadBlocked, readReloadContext }
}
