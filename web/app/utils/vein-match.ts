/**
 * オフラインの指静脈照合 (ブラウザの wasm、Refs ippoan/vein-match#20)。
 *
 * wasm は `app/vendor/vein-match/` (glue) と `public/vein/` (本体) に同梱している
 * (出どころと更新の手順は `app/vendor/vein-match/README.md`)。
 *
 * **学習しない。** `search_user_hex` の第 3 引数 (t8) を渡さないと、当たっても
 * テンプレートを書き換えない。登録データの正本はサーバーで、手元の写し
 * (`vein-db.ts`) は次の同期でまるごと差し替わるだけなので、ここで学習しても捨てられる。
 */
import initVeinWasm, { VeinLibrary, logic_version as wasmLogicVersion } from '~/vendor/vein-match/vein_match_wasm'
import type { VeinTemplateSnapshot } from '~/utils/vein-db'

/** wasm 本体の URL (`public/vein/`) */
export const VEIN_WASM_URL = '/vein/vein_match_wasm_bg.wasm'

/** 照合の厳しさ。**サーバー (rust-alc-api の `/api/vein/identify`) と同じ値** */
export const VEIN_SEARCH_LEVEL = 2

/** `new VeinLibrary(n)` が受ける件数の範囲 (wasm 側の制約) */
const LIBRARY_MIN = 2
export const VEIN_LIBRARY_MAX = 500

let wasmReady: Promise<unknown> | null = null

/**
 * wasm を読み込む (初回だけ。以後は使い回す)。失敗したら次の呼び出しで読み直す。
 *
 * オンラインのうちに 1 度呼んでおくと、Service Worker が `/vein/` をキャッシュするので
 * オフラインでも読める (`nuxt.config.ts` の workbox)。
 */
export async function loadVeinWasm(): Promise<void> {
  wasmReady ??= initVeinWasm({ module_or_path: VEIN_WASM_URL })
  try {
    await wasmReady
  }
  catch (e) {
    wasmReady = null
    throw e
  }
}

export type VeinOfflineMatch =
  /** 当たり */
  | { kind: 'hit'; employeeId: string }
  /** 外れ */
  | { kind: 'miss' }
  /** 読み取った特徴量の形式が正しくない (`search_user_hex` の戻りの負数をそのまま) */
  | { kind: 'invalid_chara'; code: number }
  /** 手元の一覧の版と wasm の版が違う (照合していない) */
  | { kind: 'version_mismatch'; stored: string; wasm: string }

/**
 * 手元の一覧で 1:N 照合する。
 *
 * **先に版を突き合わせる。** 一覧を作ったサーバーの照合ロジック (`logicVersion`) と
 * 同梱の wasm の `logic_version()` が違えば、テンプレートの形式や判定が食い違っている
 * おそれがあるので**照合しない** (外れや別人の当たりを出さない)。
 *
 * 一覧の i 番目を利用者番号 i+1 として入れ、`search_user_hex` の戻りが 1 以上ならその番号の
 * 社員、-1 なら外れ、それ以外は形式エラー。
 * wasm の上限 ({@link VEIN_LIBRARY_MAX} 件) を超えた分は入れられないので、先頭から上限まで使う。
 */
export async function matchVeinOffline(chara: string, snapshot: VeinTemplateSnapshot): Promise<VeinOfflineMatch> {
  await loadVeinWasm()
  const wasm = wasmLogicVersion()
  if (snapshot.logicVersion !== wasm) return { kind: 'version_mismatch', stored: snapshot.logicVersion, wasm }
  const entries = snapshot.templates.slice(0, VEIN_LIBRARY_MAX)
  if (entries.length < snapshot.templates.length) {
    console.warn(`[vein-match] 登録が ${snapshot.templates.length} 件あり、上限 ${VEIN_LIBRARY_MAX} 件を超えた分はオフラインで照合できない`)
  }
  const library = new VeinLibrary(Math.max(entries.length, LIBRARY_MIN))
  try {
    entries.forEach((entry, i) => {
      const rc = library.import_temp_b64(i + 1, entry.template)
      if (rc !== 0) console.warn(`[vein-match] テンプレートを読めなかった (employee_id=${entry.employeeId}, rc=${rc})`)
    })
    const result = library.search_user_hex(chara, VEIN_SEARCH_LEVEL, undefined)
    const ret = result.ret
    result.free()
    if (ret >= 1) return { kind: 'hit', employeeId: entries[ret - 1]!.employeeId }
    if (ret === -1) return { kind: 'miss' }
    return { kind: 'invalid_chara', code: ret }
  }
  finally {
    library.free()
  }
}
