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
 * **少し古くても使う。**「古いから引き直してから答える」にするとクラウド待ちに戻り、
 * 目的 (WS を待たない) が崩れる。**手元の答えを即返し、引き直しは背景で**行う。
 * ただし**古すぎる台帳では引かない** (`STALE_LIMIT_MS`。下の定数の doc 参照)。
 *
 * 引き直す契機は 4 つ。**どれも背景で走り、`resolve()` を待たせない**:
 *
 * | 契機 | 何のためか |
 * |---|---|
 * | `refresh()` の明示呼び出し | 呼び出し側が打刻の合図などで叩く |
 * | **経過時間 (`startPeriodicRefresh`)** | 打刻が一度も来なくても古びないように。**朝いちばんの 1 人目**が古い台帳に当たらない |
 * | **`resolve()` のたび** | 取得時刻を見て古ければ引き直す (`MAX_AGE_MS`)。古すぎて引かなかったときも |
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

/**
 * この時間を過ぎた台帳では**引かない** (`resolve()` が `null` を返す)。定期同期の間隔の 2 倍。
 * 台帳をサーバから取れた時刻が分からないとき (一度も取れていない / 時刻を持たない写しを
 * IndexedDB から戻した / **取得時刻が今より未来** = 端末の時計が後ろへ戻った) も同じ扱い
 * (Refs ippoan/alc-app#387)。
 *
 * # なぜ上限が要るのか
 *
 * ここで引けた打刻は「この端末の機体で読んだ社員証」として扱われ、その回は IT点呼 を
 * 選べる (`useHubTimecardPunch` の `readOnThisDevice`)。カードを別の人に付け替えた後も
 * 古い写しで引き続けると、**前の持ち主の名義**でその回を始められてしまう。取得に失敗し
 * 続けた台帳・リロード直後に IndexedDB から戻した古い台帳で起きるので、**結び付く幅を
 * 同期 1〜2 回ぶんに抑える**。
 *
 * 引かなかったときはサーバ経由の案内に倒れる (IT点呼 は選べない)。**遅くなるだけで壊れない。**
 *
 * この写しで引くのは、オフラインのときと、サーバーへの持ち主の照会が失敗したときだけ
 * (`useHubTimecardPunch` の doc。オンラインならまず照会する)。
 */
const STALE_LIMIT_MS = 2 * MAX_AGE_MS

/**
 * カードの番号を突き合わせ用の形に揃える。**台帳に入れるとき (キー) と引くとき (引数) の
 * 両方に通す** (Refs ippoan/alc-app#387)。
 *
 * 機体 (CoreS3) は読み取った番号を**大文字の 16 進**で出し、サーバの台帳は正規化済み
 * (**小文字**) で返す。揃えずに完全一致で引くと、a〜f を含むカードが常に引けない。
 *
 * 規則は backend と同じ 3 つだけ — 前後の空白を落とす・小文字にする・`:` を除く。
 * **`-` や内側の空白は消さない** (backend が消さないので、消すと別のカードに当たり得る)。
 * 写し元: rust-alc-api `crates/alc-core/src/repository/timecard.rs` の `normalize_card_id`
 * (`card_id.trim().to_lowercase().replace(':', "")`)。規則を変えるときは両方を揃えること。
 */
export function normalizeCardId(cardId: string): string {
  return cardId.trim().toLowerCase().replace(/:/g, '')
}

/** 正規化済みの `card_id` → 社員 ID。**氏名は入れない** (`timecard-card-db.ts` の doc 参照) */
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
  // サーバから取ったぶんも IndexedDB から戻したぶんもここを通る (キーの正規化は 1 か所)
  for (const e of entries) index.set(normalizeCardId(e.cardId), e.employeeId)
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
    // **取得時刻で間引く。** 0 を渡せば必ず引き直す。
    // 経過が負 (端末の時計が後ろへ戻り、取得時刻が未来になった) なら**間引かない** —
    // 間引くと時計が追いつくまで同期が 1 回も走らない。取れれば取得時刻が今になって回復する
    const age = Date.now() - fetchedAt
    if (minAgeMs > 0 && age >= 0 && age < minAgeMs) return
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
   * 台帳が引いてよい新しさか。サーバから取れた時刻が分からない (0) か、
   * `STALE_LIMIT_MS` より古ければ `false`。**取得時刻が未来 (経過が負) のときも `false`** —
   * 時計が後ろへ戻った端末で、古い写しを新しいと誤認しないため。
   */
  function isFresh(): boolean {
    const age = Date.now() - fetchedAt
    return fetchedAt > 0 && age >= 0 && age <= STALE_LIMIT_MS
  }

  /**
   * `card_id` (読み取った生値でよい) から社員 ID を引く。**同期。** 引けなければ `null` を
   * 返し、**背景で引き直す** (新しく登録されたカードを次から拾えるように)。
   * **台帳が古すぎるときも `null`** (`STALE_LIMIT_MS`)。
   */
  function resolve(cardId: string): string | null {
    if (!isFresh()) {
      void refresh(MAX_AGE_MS)
      return null
    }
    const employeeId = index.get(normalizeCardId(cardId))
    if (employeeId) {
      // 引けた。**答えは即返し**、古ければ背景で引き直すだけ
      void refresh(MAX_AGE_MS)
      return employeeId
    }
    // 引けなかった。登録直後かもしれないので短い間隔で引き直す
    void refresh(MISS_MIN_AGE_MS)
    return null
  }

  return { restore, refresh, resolve, isFresh, startPeriodicRefresh, stopPeriodicRefresh }
}
