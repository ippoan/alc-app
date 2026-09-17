/**
 * 打刻カードの台帳 (`card_id` → 社員 ID) をブラウザに置く (Refs ippoan/rust-alc-api#644)。
 *
 * # なぜ持つのか
 *
 * ハブ端末 (CoreS3) が IC カードを読むと、firmware は
 * `EVT TIMECARD card_id=… card_kind=…` を USB シリアルへ流す。**目の前のケーブルで
 * 届いている**この事実を使って画面を即座に動かすには、**誰のカードかをブラウザだけで
 * 判る**必要がある。サーバへ問い合わせるとクラウドを一周することになり、
 * 「WS を待たない」という目的が崩れる。
 *
 * # なぜ `card_id` を URL に載せないのか
 *
 * カード 1 枚ずつを引く口は**カード ID を URL に載せる**ため、アクセスログに IDm が
 * 恒久的に残っていた。**その口そのものが消えた** (client / server とも削除済み、
 * Refs ippoan/rust-alc-api#644)。**台帳をまとめて 1 回引き、突き合わせはブラウザの
 * 中だけで行う。**
 *
 * # なぜ IndexedDB なのか (メモリだけにしない)
 *
 * **このキオスクはリロードが頻繁**で、実測で 44 分に 11 回ポートを開き直していた。
 * メモリだけだと**リロードのたびに台帳が消え、その直後のタップはクラウド待ちに戻る** —
 * 一番起きやすい場面で目的が崩れる。`localStorage` にしないのは**同期 API で
 * メインスレッドを止める**から (打刻の応答性がこのタスクの主題)。
 *
 * # 何を入れて、何を入れないか
 *
 * **入れるのは `card_id` → 社員 ID の対応と取得時刻だけ。** 氏名も所属も入れない —
 * 氏名はボタンを出すときに既存の社員一覧から引ける。持ち回る値を最小にする。
 */

/** 台帳 1 件。**これ以上のフィールドを足さないこと** (上の doc)。 */
export interface TimecardCardEntry {
  /** NFC の生値 (FeliCa IdM / NFC-A UID)。**ブラウザの外へ出さない** */
  cardId: string
  /** 解決先の社員 ID */
  employeeId: string
  /** サーバから引いた時刻 (古さが分かるように持つ。古くても使う) */
  fetchedAt: number
}

const DB_NAME = 'alc-timecard-card-db'
const DB_VERSION = 1
const STORE_NAME = 'cards'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: 'cardId' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/**
 * 台帳を**まるごと差し替える** (clear → put)。
 *
 * 差分更新にしないのは、**サーバで消されたカードを消す**ため。1 件ずつ put すると
 * 「退職者のカードが手元に残り続ける」形になる。
 */
export async function saveTimecardCardIndex(entries: readonly TimecardCardEntry[]): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    store.clear()
    for (const entry of entries) store.put(entry)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** 台帳を全件読む (起動時に 1 回。件数はカードの枚数ぶんで小さい)。 */
export async function loadTimecardCardIndex(): Promise<TimecardCardEntry[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const request = tx.objectStore(STORE_NAME).getAll()
    // `getAll()` は仕様上つねに配列を返す (空なら `[]`) ので、防御の `??` は置かない
    request.onsuccess = () => resolve(request.result as TimecardCardEntry[])
    request.onerror = () => reject(request.error)
  })
}
