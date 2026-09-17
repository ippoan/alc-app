import type { TimecardCardEntry } from '~/utils/timecard-card-db'
import { loadTimecardCardIndex, saveTimecardCardIndex } from '~/utils/timecard-card-db'
import { listTimecardCards } from '~/utils/api'

/**
 * 打刻カードの台帳 (`card_id` → 社員 ID) を手元に持ち、**同期で**引けるようにする
 * (Refs ippoan/rust-alc-api#644)。
 *
 * # なぜ同期で引ける必要があるのか
 *
 * ハブ端末の `EVT TIMECARD` が届いた瞬間にボタンを出したい。ここで `await` が入ると
 * その待ち時間が体感になる。**IndexedDB からの読み出しは起動時に 1 回**だけ行い、
 * 以後は in-memory の `Map` を引く。
 *
 * # 鮮度
 *
 * **古くても使う。**「古いから引き直してから答える」にするとクラウド待ちに戻り、
 * 目的 (WS を待たない) が崩れる。**手元の答えを即返し、引き直しは背景で**行う。
 *
 * 引き直す契機は 2 つ:
 *
 * - `refresh()` — 呼び出し側が打刻の合図などで叩く
 * - **引けなかったとき** — 運用中に登録された新しいカードはここで拾う。
 *   その 1 回は空振りするが、**従来どおり WS 由来のボタンに倒れるだけ**で劣化しない
 *
 * # module スコープで持つ理由
 *
 * 複数の component から呼ばれても**台帳は 1 つ**にする (`useStrayAlcohol` と同型)。
 */

/** `card_id` → 社員 ID。**氏名は入れない** (`timecard-card-db.ts` の doc 参照) */
const index = new Map<string, string>()
/** IndexedDB からの復元を始めたか (起動から 1 回だけ) */
let restored = false
/** 背景で引き直している最中か (同時に何本も走らせない) */
let refreshing = false

/** テスト用: module スコープの状態を捨てる。 */
export function _resetTimecardCardIndex(): void {
  index.clear()
  restored = false
  refreshing = false
}

function apply(entries: readonly TimecardCardEntry[]): void {
  index.clear()
  for (const e of entries) index.set(e.cardId, e.employeeId)
}

export function useTimecardCardIndex() {
  /**
   * サーバから台帳を引き直して IndexedDB と in-memory に反映する。
   * **失敗しても投げない** — 手元の台帳はそのまま使い続ける。
   */
  async function refresh(): Promise<void> {
    if (refreshing) return
    refreshing = true
    try {
      const cards = await listTimecardCards()
      const now = Date.now()
      const entries: TimecardCardEntry[] = cards.map(c => ({
        cardId: c.card_id,
        employeeId: c.employee_id,
        fetchedAt: now,
      }))
      apply(entries)
      await saveTimecardCardIndex(entries)
    }
    catch (e) {
      console.warn('[TimecardCardIndex] 台帳の取得に失敗 (手元のものを使い続けます)', e)
    }
    finally {
      refreshing = false
    }
  }

  /**
   * 起動時の復元。**IndexedDB を先に読んで即使えるようにし、引き直しは背景で**行う
   * (await しない) — 2 回目以降のロードでは手元の台帳が最初から効く。
   */
  async function restore(): Promise<void> {
    if (restored) return
    restored = true
    try {
      apply(await loadTimecardCardIndex())
    }
    catch (e) {
      console.warn('[TimecardCardIndex] 台帳の復元に失敗 (サーバから引き直します)', e)
    }
    void refresh()
  }

  /**
   * `card_id` から社員 ID を引く。**同期。** 引けなければ `null` を返し、
   * **背景で引き直す** (新しく登録されたカードを次から拾えるように)。
   */
  function resolve(cardId: string): string | null {
    const employeeId = index.get(cardId)
    if (employeeId) return employeeId
    void refresh()
    return null
  }

  return { restore, refresh, resolve }
}
