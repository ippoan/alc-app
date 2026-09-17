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
 * 引き直す契機は 4 つ。**どれも背景で走り、`resolve()` を待たせない**:
 *
 * | 契機 | 何のためか |
 * |---|---|
 * | `refresh()` の明示呼び出し | 呼び出し側が打刻の合図などで叩く |
 * | **経過時間 (`startPeriodicRefresh`)** | 打刻が一度も来なくても古びないように。**朝いちばんの 1 人目**が古い台帳に当たらない |
 * | **`resolve()` のたび** | 取得時刻を見て古ければ引き直す (`MAX_AGE_MS`) |
 * | **引けなかったとき** | 運用中に登録された新しいカードを拾う (`MISS_MIN_AGE_MS`) |
 *
 * ## ★ 時刻での同期が要る本当の理由は「削除」
 *
 * 引けたときは何も起きないので、**取り消されたカードは手元に残り続ける** —
 * 退職者のカードでボタンが出続ける。引けなかったときの引き直しでは**絶対に拾えない**
 * (引けてしまうため)。**時刻で回すことだけが、削除を伝える経路**になる。
 *
 * ## 間隔の根拠 (`MAX_AGE_MS` = 5 分)
 *
 * - **削除が最大 5 分で伝わる。** 上のとおりここが本題
 * - **登録直後は `MISS_MIN_AGE_MS` (30 秒) 側が拾う**ので、5 分待つ必要は無い
 * - **叩きすぎない。** 5 分間隔なら 1 台あたり 1 日 288 回。カード一覧は小さな JSON
 * - `useFaceSync` の再同期の下限と同値。**この画面の「古さの許容」を 1 つに揃える**
 *
 * **差分同期は使えない。** `GET /api/timecard/cards` の絞り込みは `employee_id` だけで、
 * 「この時刻以降に変わったもの」を返す口が無い (rust-alc-api の `CardFilter`)。全件で引く。
 *
 * # module スコープで持つ理由
 *
 * 複数の component から呼ばれても**台帳は 1 つ**にする (`useStrayAlcohol` と同型)。
 */

/** この時間を過ぎた台帳は背景で引き直す (根拠は上の doc)。定期同期の間隔も同値 */
const MAX_AGE_MS = 5 * 60 * 1000

/**
 * 引けなかったときに引き直す下限間隔。登録直後のカードを早く拾うために
 * `MAX_AGE_MS` より短いが、**未登録カードを連打されても叩き続けない**ようにする。
 */
const MISS_MIN_AGE_MS = 30 * 1000

/** `card_id` → 社員 ID。**氏名は入れない** (`timecard-card-db.ts` の doc 参照) */
const index = new Map<string, string>()
/** 台帳をサーバから取れた時刻 (0 = まだ一度も取れていない) */
let fetchedAt = 0
/** IndexedDB からの復元を始めたか (起動から 1 回だけ) */
let restored = false
/** 背景で引き直している最中か (同時に何本も走らせない) */
let refreshing = false
/** 定期同期のタイマー */
let periodicTimer: ReturnType<typeof setInterval> | null = null

/** テスト用: module スコープの状態を捨てる。 */
export function _resetTimecardCardIndex(): void {
  index.clear()
  fetchedAt = 0
  restored = false
  refreshing = false
  if (periodicTimer !== null) clearInterval(periodicTimer)
  periodicTimer = null
}

function apply(entries: readonly TimecardCardEntry[], at: number): void {
  index.clear()
  for (const e of entries) index.set(e.cardId, e.employeeId)
  fetchedAt = at
}

/**
 * IndexedDB から戻したぶんの「取得時刻」(空なら 0 = 未取得)。
 *
 * `saveTimecardCardIndex` は**全件をまるごと差し替え、同じ時刻を書く**ので、
 * 先頭 1 件を見れば足りる。走査して最大を採ると、**絶対に通らない分岐**ができる。
 */
function restoredFetchedAt(entries: readonly TimecardCardEntry[]): number {
  return entries[0]?.fetchedAt ?? 0
}

export function useTimecardCardIndex() {
  /**
   * サーバから台帳を引き直して IndexedDB と in-memory に反映する。
   * **失敗しても投げない** — 手元の台帳はそのまま使い続ける。
   */
  async function refresh(minAgeMs = 0): Promise<void> {
    if (refreshing) return
    // **取得時刻で間引く。** 0 を渡せば必ず引き直す
    if (minAgeMs > 0 && Date.now() - fetchedAt < minAgeMs) return
    refreshing = true
    try {
      const cards = await listTimecardCards()
      const now = Date.now()
      const entries: TimecardCardEntry[] = cards.map(c => ({
        cardId: c.card_id,
        employeeId: c.employee_id,
        fetchedAt: now,
      }))
      apply(entries, now)
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
      const entries = await loadTimecardCardIndex()
      apply(entries, restoredFetchedAt(entries))
    }
    catch (e) {
      console.warn('[TimecardCardIndex] 台帳の復元に失敗 (サーバから引き直します)', e)
    }
    // **古ければ引き直す。**新しければ IndexedDB のぶんをそのまま使い、叩かない
    void refresh(MAX_AGE_MS)
  }

  /**
   * 経過時間での定期同期を始める (**削除を伝える唯一の経路**。上の doc 参照)。
   * 二重に張らない。`stopPeriodicRefresh` と対で使う。
   */
  function startPeriodicRefresh(): void {
    if (periodicTimer !== null) return
    periodicTimer = setInterval(() => { void refresh(MAX_AGE_MS) }, MAX_AGE_MS)
  }

  function stopPeriodicRefresh(): void {
    if (periodicTimer === null) return
    clearInterval(periodicTimer)
    periodicTimer = null
  }

  /**
   * `card_id` から社員 ID を引く。**同期。** 引けなければ `null` を返し、
   * **背景で引き直す** (新しく登録されたカードを次から拾えるように)。
   */
  function resolve(cardId: string): string | null {
    const employeeId = index.get(cardId)
    if (employeeId) {
      // 引けた。**答えは即返し**、古ければ背景で引き直すだけ
      void refresh(MAX_AGE_MS)
      return employeeId
    }
    // 引けなかった。登録直後かもしれないので短い間隔で引き直す
    void refresh(MISS_MIN_AGE_MS)
    return null
  }

  return { restore, refresh, resolve, startPeriodicRefresh, stopPeriodicRefresh }
}
