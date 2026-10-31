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
 * - `module_ids` store (版 2 で追加): 照合をモジュールに移す経路 (M-b、Refs ippoan/alc-app#436) の
 *   乗務員 ↔ 端末のモジュールの ID (10〜100) の対応表。**サーバーは端末の ID を知らない**ので、
 *   モジュールが返した ID から乗務員を引けるのはこの表だけ (`vein-module.ts`)
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

/** 端末のモジュールの ID に置いた乗務員 1 人 */
export interface VeinModuleEntry {
  employeeId: string
  /** モジュールの ID (10〜100) */
  moduleId: number
  /** 置いた記録の版 (サーバーの `updated_at`) */
  updatedAt: string
  /** 管理者が承認済みか。承認待ちの ID に当たっても本人確認にしない */
  approved: boolean
  /** 記録を登録した端末の id (サーバーの `registered_device_id`)。分からなければ null / 無し */
  registeredDeviceId?: string | null
  /**
   * この端末で足した指 (「この端末の指を足す」) を、その場で撮った記録のままモジュールに置いている。
   * 端末の設定が「その場で撮った記録を使う」の間は、同期がこの記録を書き換えない (`vein-module.ts`)
   */
  native?: boolean
}

const DB_NAME = 'alc-vein-db'
/** 版 1 → 2 で `module_ids` を足した。既存の store はそのまま残す (写しは消えない) */
const DB_VERSION = 2
const TEMPLATES_STORE = 'templates'
const META_STORE = 'meta'
const MODULE_STORE = 'module_ids'
const META_KEY = 'current'

function openDb(): Promise<IDBDatabase> {
  return openIdb(DB_NAME, DB_VERSION, (db) => {
    // 版 1 から上げるときは templates / meta が既に在る。無いものだけ作る (module_ids は版 2 で初めて作る)
    if (!db.objectStoreNames.contains(TEMPLATES_STORE)) db.createObjectStore(TEMPLATES_STORE, { keyPath: 'employeeId' })
    if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE)
    db.createObjectStore(MODULE_STORE, { keyPath: 'employeeId' })
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

/**
 * 手元の写しを**すべて消す** (templates と meta を同一 transaction で clear)。
 * 一度も保存していなくても成功する。消したあと照合は「データがありません」になり、
 * 次の同期 (`syncVeinTemplates`) で取り直す
 */
export async function clearVeinTemplates(): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction([TEMPLATES_STORE, META_STORE], 'readwrite')
    tx.objectStore(TEMPLATES_STORE).clear()
    tx.objectStore(META_STORE).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** モジュールの ID の対応表を全件読む */
export async function loadVeinModuleEntries(): Promise<VeinModuleEntry[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MODULE_STORE, 'readonly')
    const req = tx.objectStore(MODULE_STORE).getAll()
    tx.oncomplete = () => resolve(req.result as VeinModuleEntry[])
    tx.onerror = () => reject(tx.error)
  })
}

/** 対応表の 1 人を書く (同じ乗務員は置き換わる) */
export async function putVeinModuleEntry(entry: VeinModuleEntry): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MODULE_STORE, 'readwrite')
    tx.objectStore(MODULE_STORE).put(entry)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** 対応表から 1 人を外す (居なくても成功する) */
export async function deleteVeinModuleEntry(employeeId: string): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MODULE_STORE, 'readwrite')
    tx.objectStore(MODULE_STORE).delete(employeeId)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
