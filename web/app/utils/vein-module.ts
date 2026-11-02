/**
 * 指静脈の照合を端末のモジュール自身に任せる経路 (M-b、Refs ippoan/alc-app#436)。
 *
 * **すべての端末 (本番・開発用・測定台) が使う。** 登録がモジュールの形式で保存されるため、
 * どれか 1 つでもサーバーの照合 (`VEIN CAPTURE` → `vein-identify.ts`) に残すと、その端末からは
 * 照合の相手が一人も載らない (Refs ippoan/alc-app#436)。測定台の鍵にもモジュールの口
 * (PUT …/module・GET /vein/module-templates・GET /employees/{id}) を開けてある (auth-worker の
 * `BP_STATION_ROUTES`)。
 * `VEIN IDENTIFY` / `VEIN SYNC` を持たない古い Vein Station のファームは照合が `ERR VEIN: …` で失敗するので、
 * Web インストーラ (vein.html) で焼き直す。
 *
 * - 登録: モジュールの ID に `VEIN ENROLL` → 記録全体をサーバーへ預ける (`useVeinEnroll`)
 * - 照合: `VEIN IDENTIFY` が返した ID を、手元の対応表 (`vein-db.ts` の `module_ids`) で乗務員に引く。
 *   **承認済みの ID だけ**本人確認にする (承認待ちに当たったら不一致)
 * - 同期: サーバーの承認済みの記録 (`GET /api/vein/module-templates`) と対応表を比べ、新しい・変わった
 *   記録を空いている ID に書き、一覧から消えた乗務員はモジュールから消す。枠が埋まったら書かずに飛ばす
 * - 免許証・社員番号で本人が決まったら (`prepareVeinModuleRecord`): その 1 人の記録をサーバーから取り、
 *   モジュールに無い・古ければ書いて 1:1 (`VEIN VERIFY`) で照合する。枠が埋まっていたら一番長く使っていない人の
 *   枠を譲らせる — **91 人を超えても照合できる** (Refs ippoan/alc-app-s3#352)。記録は PC に持たない
 *
 * モジュールの ID は 1 = 作業用 / 2〜9 = 確認タブの試験 / **10〜100 = ここが割り振る** (ファームの
 * docs/console-protocol.md の「ID の分け方」)。サーバーは端末の ID を知らない。
 */
import type { Ref } from 'vue'
import type { ApiEmployee } from '~/types'
import { getEmployeeById, getEmployees, getVeinModuleTemplate, getVeinModuleTemplates } from '~/utils/api'
import type { ApiVeinModuleRecord, RequestTokenScope } from '~/utils/api'
import { deleteVeinModuleEntry, loadVeinModuleEntries, putVeinModuleEntry } from '~/utils/vein-db'
import type { VeinModuleEntry } from '~/utils/vein-db'
import type { VeinIdentifyOutcome } from '~/utils/vein-identify'
import { readVeinAddedFingerMode } from '~/utils/vein-added-finger-mode'
import { recordVeinLine } from '~/utils/vein-line-log'

export const VEIN_MODULE_ID_MIN = 10
export const VEIN_MODULE_ID_MAX = 100

/** 同期が使うモジュールの口 (`useVeinSerial` の一部) */
export interface VeinModulePort {
  isConnected: Readonly<Ref<boolean>>
  syncWrite: (id: number, record: Uint8Array) => Promise<void>
  syncClear: (id: number) => Promise<void>
}

/**
 * 照合・登録・同期をモジュールで行うか。今はすべての端末で true。サーバーの照合へ戻すときの
 * 切り替えをこの 1 か所に残してある (呼び手は TenkoKiosk・BloodPressureMeasurement・useVeinEnroll)
 */
export function usesVeinModule(): boolean {
  return true
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

/**
 * {@link allocateVeinModuleId} と同じだが、空きが無ければ一番長く照合に使っていない (`lastUsedAt` が古い)
 * 承認済みの人の ID を譲らせる。承認待ち (この端末で登録して承認を待つ人) は譲らせない。
 * 譲らせた人は `evicted` で返す (呼び手が対応表から外す)。譲らせる人も居なければ null
 */
export function allocateOrEvictVeinModuleId(
  entries: readonly VeinModuleEntry[],
  employeeId: string,
): { id: number; evicted: VeinModuleEntry | null } | null {
  const id = allocateVeinModuleId(entries, employeeId)
  if (id !== null) return { id, evicted: null }
  let victim: VeinModuleEntry | null = null
  for (const e of entries) {
    if (!e.approved || e.employeeId === employeeId) continue
    if (victim === null || (e.lastUsedAt ?? 0) < (victim.lastUsedAt ?? 0)) victim = e
  }
  return victim ? { id: victim.moduleId, evicted: victim } : null
}

/** 端末の設定が「その場で撮った記録を使う」なら、サーバーに混ぜずに選んだ記録を頼む (混ぜた記録は通りにくい) */
function recordPick(): 'own' | undefined {
  return readVeinAddedFingerMode() === 'native' ? 'own' : undefined
}

/** 照合に使った印 (枠を譲らせる順に使う)。失敗は捨てる (照合は止めない) */
async function touchVeinModuleEntry(entry: VeinModuleEntry): Promise<void> {
  await putVeinModuleEntry({ ...entry, lastUsedAt: Date.now() }).catch(() => {})
}

/**
 * 同期・用意が、この端末の「その場で撮った記録」を書き換えずに残すか (Refs ippoan/alc-app#558)。
 * 端末の設定が「その場で撮った記録を使う」(`native`) で、その記録を置いている人だけ。
 * 設定が「混ぜた記録」(`mixed`) なら false (サーバーが組んだ記録で書き直す)
 */
function keepsOnSpotRecord(entry: VeinModuleEntry | undefined): boolean {
  return entry?.native === true && readVeinAddedFingerMode() === 'native'
}

/**
 * モジュールのどの ID にどの記録を書いたかを、Vein Station の行と同じ溜め場所に残す
 * (`PC VEIN RECORD <id> KIND=<種類> MODE=<端末の設定>`。recorder へ上がる診断ログ、`useVeinLogUpload`)。
 * 続く `VEIN IDENTIFIED <id> SCORE=…` / `VEIN NOMATCH` と並べ、記録の種類ごとの点数を後から集計する。
 * 種類は `composed` (この端末向けに組んだ混ぜた記録) / `server` (組んでいない記録) / `native` (その場で撮った記録) /
 * `own`・`other` (混ぜずに選んだ、この端末の記録・他の端末の最新)。乗務員の ID は載せない
 */
export function noteVeinModuleRecord(id: number, kind: 'composed' | 'server' | 'native' | 'own' | 'other'): void {
  recordVeinLine(`PC VEIN RECORD ${id} KIND=${kind} MODE=${readVeinAddedFingerMode()}`)
}

/** 不一致のとき、自動でもう一度照合する回数 (置き方のぶれ・閾値の揺れで落ちた回を拾う) */
export const VEIN_NOMATCH_RETRIES = 1

/**
 * モジュールの照合 `read` (`VEIN IDENTIFY` / `VEIN VERIFY`) を、不一致 (`missed`) なら
 * {@link VEIN_NOMATCH_RETRIES} 回まで自動でやり直す。やり直す前に `onRetry` (画面の「もう一度置いて」と機器の `VEIN SAY AGAIN`) を待ち、
 * 診断ログに `PC VEIN RETRY` を残す (照合の失敗・別の人に当たった回はやり直さない — 呼び手が決める)
 */
export async function retryOnVeinMiss<T>(read: () => Promise<T>, missed: (r: T) => boolean, onRetry: () => void | Promise<void>): Promise<T> {
  let result = await read()
  for (let i = 0; i < VEIN_NOMATCH_RETRIES && missed(result); i++) {
    await onRetry()
    recordVeinLine('PC VEIN RETRY')
    result = await read()
  }
  return result
}

/** サーバーの記録の種類 (`composed` も `source` も無い古いサーバー・管理者の鍵は `server`) */
function serverRecordKind(t: ApiVeinModuleRecord): 'composed' | 'server' | 'own' | 'other' {
  return t.source ?? (t.composed ? 'composed' : 'server')
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
 * 対応表に無い ID は不一致、承認待ちの ID は `pending` (本人確認にはしない)。社員の情報はオンラインは
 * `GET /api/employees/{id}`、ネットワークで失敗したら `getEmployees()` (Service Worker のキャッシュ) から引く。
 * `scope` はどの鍵で引くか (`syncVeinTemplates` と同じ)
 */
export async function identifyVeinModuleEmployee(moduleId: number | null, scope: RequestTokenScope = 'default'): Promise<VeinIdentifyOutcome> {
  if (moduleId === null) return { kind: 'miss' }
  try {
    const entry = (await loadVeinModuleEntries()).find(e => e.moduleId === moduleId)
    if (!entry) return { kind: 'miss' }
    await touchVeinModuleEntry(entry)
    if (!entry.approved) {
      // 名前は飾り (「○○さんは未承認」)。引けなくても未承認であることは伝える
      const pending = await findEmployee(entry.employeeId, scope).catch(() => undefined)
      return { kind: 'pending', employeeId: entry.employeeId, name: pending?.name ?? null }
    }
    const employee = await findEmployee(entry.employeeId, scope)
    if (!employee) {
      return { kind: 'error', message: '指静脈は一致しましたが、乗務員の情報が手元にありません。NFC か社員番号で進んでください' }
    }
    return { kind: 'hit', employee }
  }
  catch (e) {
    return { kind: 'error', message: `指静脈の照合に失敗しました: ${messageOf(e)}` }
  }
}

/** 社員を引く。オンラインは `GET /api/employees/{id}`、ネットワークの失敗は `getEmployees()` (キャッシュ) から */
async function findEmployee(employeeId: string, scope: RequestTokenScope): Promise<ApiEmployee | undefined> {
  try {
    return await getEmployeeById(employeeId, scope)
  }
  catch (e) {
    if (!(e instanceof TypeError)) throw e
    return (await getEmployees(scope)).find(emp => emp.id === employeeId)
  }
}

/**
 * 免許証・社員番号で本人が決まった乗務員の記録を、この端末のモジュールに用意して ID を返す
 * (Refs ippoan/alc-app#436: 端末に無ければ DB から取ってきて書く)。その 1 人の記録だけをサーバーから取って版を
 * 確かめ (Refs ippoan/alc-app-s3#352)、手元の対応表と版が同じならそのまま、違えば (無ければ) 書き直す。
 * 枠が埋まっていたら、一番長く使っていない人の枠を譲らせる。サーバーに承認済みの記録が無ければ null。
 * サーバーに届かないときは、手元の対応表に承認済みで在ればその ID を使う。
 * 書き込みの失敗は投げる (呼び手が顔認証などへ逃がす)。`scope` はどの鍵で取るか
 */
export async function prepareVeinModuleRecord(port: VeinModulePort, employeeId: string, scope: RequestTokenScope = 'default'): Promise<number | null> {
  const entries = await loadVeinModuleEntries()
  const own = entries.find(e => e.employeeId === employeeId)
  let template: ApiVeinModuleRecord | undefined
  try {
    template = await getVeinModuleTemplate(employeeId, { pick: recordPick(), scope })
  }
  catch (e) {
    if (!(e instanceof TypeError)) throw e
    if (!own?.approved) return null
    await touchVeinModuleEntry(own)
    return own.moduleId
  }
  if (!template) return null
  // その場の記録 (native) は、同じ版でも混ぜた記録とは中身が違う: 設定が native なら残し、mixed なら書き直す
  if (own?.approved && (keepsOnSpotRecord(own) || (own.updatedAt === template.updated_at && !own.native))) {
    await touchVeinModuleEntry(own)
    return own.moduleId
  }
  const slot = allocateOrEvictVeinModuleId(entries, employeeId)
  if (slot === null) throw new Error('モジュールの ID が空いていません (10〜100)')
  // 書き込みが途中で落ちても、古い版・譲らせた人を承認済みとして引かないよう先に外す
  if (own) await deleteVeinModuleEntry(employeeId)
  if (slot.evicted) await deleteVeinModuleEntry(slot.evicted.employeeId)
  await port.syncWrite(slot.id, base64ToBytes(template.record))
  noteVeinModuleRecord(slot.id, serverRecordKind(template))
  await putVeinModuleEntry({
    employeeId,
    moduleId: slot.id,
    updatedAt: template.updated_at,
    approved: true,
    registeredDeviceId: template.registered_device_id ?? null,
    lastUsedAt: Date.now(),
  })
  return slot.id
}

let lastModuleSyncedAt: number | null = null
let moduleSyncing = false

/**
 * サーバーの承認済みの記録と端末のモジュールを揃える。モジュールがつながっているときだけ動く
 * (呼ぶかどうかは呼び手が `usesVeinModule` で決める)。`ifOlderThanMs` を渡すと、前回の同期からその時間がたっていなければ何もしない。
 *
 * 1 人ずつ書く・消す。1 人の失敗はその人を飛ばして続ける (次の同期で取り直す)。**投げない**
 * (今の `syncVeinTemplates` と同じ流儀)。最後まで回ったら true
 */
export async function syncVeinModule(port: VeinModulePort, opts: { ifOlderThanMs?: number; scope?: RequestTokenScope } = {}): Promise<boolean> {
  if (!port.isConnected.value || moduleSyncing) return false
  if (opts.ifOlderThanMs !== undefined && lastModuleSyncedAt !== null && Date.now() - lastModuleSyncedAt < opts.ifOlderThanMs) {
    return false
  }
  moduleSyncing = true
  const stat = { written: 0, cleared: 0, unchanged: 0, full: 0, failed: 0 }
  try {
    const { templates } = await getVeinModuleTemplates(opts.scope, recordPick())
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
        stat.cleared += 1
      }
      catch (e) {
        stat.failed += 1
        console.warn('[vein] モジュールから消せませんでした (次の同期で取り直す):', e)
      }
    }

    for (const t of templates) {
      const current = entries.get(t.employee_id)
      // この端末で足した指を「その場で撮った記録」のまま使う設定: サーバーの版が変わっても書き換えない
      if (keepsOnSpotRecord(current)) {
        stat.unchanged += 1
        continue
      }
      // native の記録は版が同じでも混ぜた記録とは中身が違うので、設定が mixed なら書き直す (下へ進む)
      if (current?.updatedAt === t.updated_at && !current.native) {
        // この端末で登録した記録が承認された: モジュールには既に在る。登録した端末もサーバーの値に合わせる
        const registeredDeviceId = t.registered_device_id ?? null
        if (!current.approved || (current.registeredDeviceId ?? null) !== registeredDeviceId) {
          await putVeinModuleEntry({ ...current, approved: true, registeredDeviceId })
        }
        stat.unchanged += 1
        continue
      }
      const id = allocateVeinModuleId([...entries.values()], t.employee_id)
      // 枠が埋まっている: 書かずに飛ばす (免許証・社員番号で決まったときに prepareVeinModuleRecord が枠を譲らせて書く)
      if (id === null) {
        stat.full += 1
        continue
      }
      try {
        // 書き込みが途中で落ちても、古い版を承認済みとして引かないよう先に外す
        if (current) await deleteVeinModuleEntry(current.employeeId)
        entries.delete(t.employee_id)
        await port.syncWrite(id, base64ToBytes(t.record))
        noteVeinModuleRecord(id, serverRecordKind(t))
        const entry = {
          employeeId: t.employee_id,
          moduleId: id,
          updatedAt: t.updated_at,
          approved: true,
          registeredDeviceId: t.registered_device_id ?? null,
          lastUsedAt: current?.lastUsedAt,
        }
        await putVeinModuleEntry(entry)
        entries.set(t.employee_id, entry)
        stat.written += 1
      }
      catch (e) {
        stat.failed += 1
        console.warn('[vein] モジュールへ書けませんでした (次の同期で取り直す):', e)
      }
    }
    lastModuleSyncedAt = Date.now()
    console.info(`[vein] モジュール同期 完了 書き込み=${stat.written} 消去=${stat.cleared} 変更なし=${stat.unchanged} 枠なし=${stat.full} 失敗=${stat.failed} 対象=${templates.length}`)
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
