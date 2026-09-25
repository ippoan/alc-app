/**
 * 指静脈テンプレートの手元の写し (Refs ippoan/vein-match#20)。
 *
 * # なぜ持つのか
 *
 * キオスクがオフラインのとき、指静脈の照合をブラウザの wasm で行う (`vein-match.ts`)。
 * そのための登録データを、オンラインのうちに `GET /api/vein/templates` で取ってここに置く。
 * **正本はサーバー** — ここは写しで、オフラインの照合でも学習しない (書き戻さない)。
 *
 * # 何を入れるか
 *
 * - `templates` store: 社員ごとのテンプレート (base64。wasm の `import_temp_b64` がそのまま読む)
 * - `meta` store: 取得した時点の `logic_version` と取得時刻。**版を一緒に持つのは、wasm の
 *   `logic_version()` と食い違ったらオフラインの照合を止めるため** (`vein-identify.ts`)
 */
import { openIdb } from '~/utils/idb'

/** テンプレート 1 件 */
export interface VeinTemplateEntry {
  employeeId: string
  /** base64 (サーバーの `template` をそのまま) */
  template: string
  updatedAt: string
}

/** 手元に置いた一覧 (1 回の `GET /api/vein/templates` の結果) */
export interface VeinTemplateSnapshot {
  /** サーバーの照合ロジックの版 (`logic_version`) */
  logicVersion: string
  /** 取得した時刻 (ms) */
  fetchedAt: number
  templates: VeinTemplateEntry[]
}

const DB_NAME = 'alc-vein-db'
const DB_VERSION = 1
const TEMPLATES_STORE = 'templates'
const META_STORE = 'meta'
const META_KEY = 'current'

function openDb(): Promise<IDBDatabase> {
  return openIdb(DB_NAME, DB_VERSION, (db) => {
    db.createObjectStore(TEMPLATES_STORE, { keyPath: 'employeeId' })
    db.createObjectStore(META_STORE)
  })
}

/**
 * 一覧を**まるごと差し替える** (clear → put。`timecard-card-db.ts` と同じ形)。
 *
 * 差分更新にしないのは、**サーバーで消された登録を消す**ため (退職者の指で通らないように)。
 * テンプレートと版は同じ transaction で書くので、片方だけ新しくなることはない。
 */
export async function saveVeinTemplates(snapshot: VeinTemplateSnapshot): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction([TEMPLATES_STORE, META_STORE], 'readwrite')
    const templates = tx.objectStore(TEMPLATES_STORE)
    templates.clear()
    for (const entry of snapshot.templates) templates.put(entry)
    tx.objectStore(META_STORE).put(
      { logicVersion: snapshot.logicVersion, fetchedAt: snapshot.fetchedAt },
      META_KEY,
    )
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** 手元の一覧を読む。一度も保存していなければ `null` */
export async function loadVeinTemplates(): Promise<VeinTemplateSnapshot | null> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction([TEMPLATES_STORE, META_STORE], 'readonly')
    const metaReq = tx.objectStore(META_STORE).get(META_KEY)
    const templatesReq = tx.objectStore(TEMPLATES_STORE).getAll()
    tx.oncomplete = () => {
      const meta = metaReq.result as { logicVersion: string; fetchedAt: number } | undefined
      resolve(meta
        ? { ...meta, templates: templatesReq.result as VeinTemplateEntry[] }
        : null)
    }
    tx.onerror = () => reject(tx.error)
  })
}
