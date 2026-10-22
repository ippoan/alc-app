/**
 * 指静脈の照合を端末のモジュール自身に任せる経路 (M-b、Refs ippoan/alc-app#436)。
 *
 * **測定台以外の端末 (本番・開発用とも) が使う。** 測定台だけはサーバーの照合 (`VEIN CAPTURE` →
 * `vein-identify.ts`) のまま。本番も開発用と同じ経路にしたのは、登録がモジュールの形式で保存される
 * ため — 開発用だけに絞ると、本番の端末からはその人が照合の相手に一人も載らない (Refs ippoan/alc-app#436)。
 * `VEIN IDENTIFY` / `VEIN SYNC` を持たない古い Vein Station のファームは照合が `ERR VEIN: …` で失敗するので、
 * Web インストーラ (vein.html) で焼き直す。
 *
 * - 登録: モジュールの ID に `VEIN ENROLL` → 記録全体をサーバーへ預ける (`useVeinEnroll`)
 * - 照合: `VEIN IDENTIFY` が返した ID を、手元の対応表 (`vein-db.ts` の `module_ids`) で乗務員に引く。
 *   **承認済みの ID だけ**本人確認にする (承認待ちに当たったら不一致)
 * - 同期: サーバーの承認済みの記録 (`GET /api/vein/module-templates`) と対応表を比べ、新しい・変わった
 *   記録を空いている ID に書き、一覧から消えた乗務員はモジュールから消す
 *
 * モジュールの ID は 1 = 作業用 / 2〜9 = 確認タブの試験 / **10〜100 = ここが割り振る** (ファームの
 * docs/console-protocol.md の「ID の分け方」)。サーバーは端末の ID を知らない。
 */
import type { Ref } from 'vue'
import type { ApiEmployee } from '~/types'
import { getEmployeeById, getEmployees, getVeinModuleTemplates } from '~/utils/api'
import { deleteVeinModuleEntry, loadVeinModuleEntries, putVeinModuleEntry } from '~/utils/vein-db'
import type { VeinModuleEntry } from '~/utils/vein-db'
import type { VeinIdentifyOutcome } from '~/utils/vein-identify'

export const VEIN_MODULE_ID_MIN = 10
export const VEIN_MODULE_ID_MAX = 100

/** 同期が使うモジュールの口 (`useVeinSerial` の一部) */
export interface VeinModulePort {
  isConnected: Readonly<Ref<boolean>>
  syncWrite: (id: number, record: Uint8Array) => Promise<void>
  syncClear: (id: number) => Promise<void>
}

/**
 * 照合・登録・同期をモジュールで行う端末か (測定台以外)。測定台 (`isBpStation`) は対象外 —
 * 測定台の鍵にはモジュールの記録の口 (PUT …/module・GET /vein/module-templates) が開いていない
 */
export function usesVeinModule(isBpStation = false): boolean {
  return !isBpStation
}

/**
 * `employeeId` を置くモジュールの ID。既に置いてあればその ID、無ければ 10〜100 の空いている最小の ID。
 * 空きが無ければ null
 */
export function allocateVeinModuleId(entries: readonly VeinModuleEntry[], employeeId: string): number | null {
  const own = entries.find(e => e.employeeId === employeeId)
  if (own) return own.moduleId
  const used = new Set(entries.map(e => e.moduleId))
  for (let id = VEIN_MODULE_ID_MIN; id <= VEIN_MODULE_ID_MAX; id++) {
    if (!used.has(id)) return id
  }
  return null
}

/** base64 をバイト列に */
function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * モジュールが返した ID (`VEIN IDENTIFY`、不一致は null) から乗務員を引く。
 * 対応表に無い ID・承認待ちの ID は不一致。社員の情報はオンラインは `GET /api/employees/{id}`、
 * ネットワークで失敗したら `getEmployees()` (Service Worker のキャッシュ) から引く
 */
export async function identifyVeinModuleEmployee(moduleId: number | null): Promise<VeinIdentifyOutcome> {
  if (moduleId === null) return { kind: 'miss' }
  try {
    const entry = (await loadVeinModuleEntries()).find(e => e.moduleId === moduleId)
    if (!entry?.approved) return { kind: 'miss' }
    let employee: ApiEmployee | undefined
    try {
      employee = await getEmployeeById(entry.employeeId)
    }
    catch (e) {
      if (!(e instanceof TypeError)) throw e
      employee = (await getEmployees()).find(emp => emp.id === entry.employeeId)
    }
    if (!employee) {
      return { kind: 'error', message: '指静脈は一致しましたが、乗務員の情報が手元にありません。NFC か社員番号で進んでください' }
    }
    return { kind: 'hit', employee }
  }
  catch (e) {
    return { kind: 'error', message: `指静脈の照合に失敗しました: ${messageOf(e)}` }
  }
}

let lastModuleSyncedAt: number | null = null
let moduleSyncing = false

/**
 * サーバーの承認済みの記録と端末のモジュールを揃える。モジュールがつながっているときだけ動く
 * (測定台で呼ばないのは呼び手が `usesVeinModule` で決める)。`ifOlderThanMs` を渡すと、前回の同期からその時間がたっていなければ何もしない。
 *
 * 1 人ずつ書く・消す。1 人の失敗はその人を飛ばして続ける (次の同期で取り直す)。**投げない**
 * (今の `syncVeinTemplates` と同じ流儀)。最後まで回ったら true
 */
export async function syncVeinModule(port: VeinModulePort, opts: { ifOlderThanMs?: number } = {}): Promise<boolean> {
  if (!port.isConnected.value || moduleSyncing) return false
  if (opts.ifOlderThanMs !== undefined && lastModuleSyncedAt !== null && Date.now() - lastModuleSyncedAt < opts.ifOlderThanMs) {
    return false
  }
  moduleSyncing = true
  try {
    const { templates } = await getVeinModuleTemplates()
    const entries = new Map((await loadVeinModuleEntries()).map(e => [e.employeeId, e]))
    const listed = new Set(templates.map(t => t.employee_id))

    // 一覧から消えた (承認の取り消し・削除・退職) 乗務員をモジュールから消す。承認待ちは一覧に
    // 載らないので残す (この端末で登録して承認を待っている人)
    for (const entry of [...entries.values()]) {
      if (!entry.approved || listed.has(entry.employeeId)) continue
      try {
        await port.syncClear(entry.moduleId)
        await deleteVeinModuleEntry(entry.employeeId)
        entries.delete(entry.employeeId)
      }
      catch (e) {
        console.warn('[vein] モジュールから消せませんでした (次の同期で取り直す):', e)
      }
    }

    for (const t of templates) {
      const current = entries.get(t.employee_id)
      if (current?.updatedAt === t.updated_at) {
        // この端末で登録した記録が承認された: モジュールには既に在る
        if (!current.approved) await putVeinModuleEntry({ ...current, approved: true })
        continue
      }
      const id = allocateVeinModuleId([...entries.values()], t.employee_id)
      if (id === null) {
        console.warn('[vein] モジュールの ID が空いていません (10〜100)')
        continue
      }
      try {
        // 書き込みが途中で落ちても、古い版を承認済みとして引かないよう先に外す
        if (current) await deleteVeinModuleEntry(current.employeeId)
        entries.delete(t.employee_id)
        await port.syncWrite(id, base64ToBytes(t.record))
        const entry = { employeeId: t.employee_id, moduleId: id, updatedAt: t.updated_at, approved: true }
        await putVeinModuleEntry(entry)
        entries.set(t.employee_id, entry)
      }
      catch (e) {
        console.warn('[vein] モジュールへ書けませんでした (次の同期で取り直す):', e)
      }
    }
    lastModuleSyncedAt = Date.now()
    return true
  }
  catch (e) {
    console.warn('[vein] モジュールの同期に失敗:', e)
    return false
  }
  finally {
    moduleSyncing = false
  }
}
