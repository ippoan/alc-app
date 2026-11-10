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
 *   モジュールに無い・古ければ書いて照合する。枠が埋まっていたら一番長く使っていない人の
 *   枠を譲らせる — **91 人を超えても照合できる** (Refs ippoan/alc-app-s3#352)。記録は PC に持たない。
 *   照合は 1:N (`VEIN IDENTIFY KEEP`) で、当たった ID がその人の枠のときだけ通す (`matchVeinModuleEmployee`)。
 *   通ったら、同じ置き方で撮った 1 本で一番古い 1 本を入れ替える (`rotateVeinModuleRecord`)
 *
 * モジュールの ID は 1 = 作業用 / 2〜9 = 確認タブの試験 / **10〜100 = ここが割り振る** (ファームの
 * docs/console-protocol.md の「ID の分け方」)。サーバーは端末の ID を知らない。
 */
import type { Ref } from 'vue'
import type { ApiEmployee } from '~/types'
import { noteVeinShotView } from '~/utils/vein-shot-view'
import { getEmployeeById, getEmployees, getPendingVeinModuleTemplates, getVeinAuthLogEnabled, getVeinModuleTemplate, getVeinModuleTemplates, postVeinAuthShot, postVeinVerifyShot, rotateVeinModuleDeviceRecord } from '~/utils/api'
import type { ApiVeinModuleRecord, RequestTokenScope, VeinEnrollNear } from '~/utils/api'
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
 * `own`・`other` (混ぜずに選んだ、この端末の記録・他の端末の最新) / `rotated` (照合に置いた 1 回の指で一番古い 1 本を
 * 入れ替えた記録、{@link rotateVeinModuleRecord})。乗務員の ID は載せない
 */
export function noteVeinModuleRecord(id: number, kind: 'composed' | 'server' | 'native' | 'own' | 'other' | 'rotated'): void {
  recordVeinLine(`PC VEIN RECORD ${id} KIND=${kind} MODE=${readVeinAddedFingerMode()}`)
}

/**
 * 登録した記録 (`id` の枠) に、他の人の承認済みの記録が合格した (サーバーの `near`) ことを診断ログに残す
 * (`PC VEIN ENROLL NEAR <id> OTHER=<相手の枠|?> RULE=<c> SCORES=<a,b,c> COARSE=<n>`)。どの登録を直すかを後から見るため。
 * 画面には出さず、承認も変えない。相手はこの端末の対応表で枠に置き換え、無ければ `?` (乗務員の ID は載せない)
 */
export async function noteVeinEnrollNear(id: number, near: readonly VeinEnrollNear[] | undefined): Promise<void> {
  if (!near?.length) return
  const entries = await loadVeinModuleEntries().catch(() => [])
  for (const n of near) {
    const other = entries.find(e => e.employeeId === n.employee_id)?.moduleId ?? '?'
    recordVeinLine(`PC VEIN ENROLL NEAR ${id} OTHER=${other} RULE=${n.rule ?? '-'} SCORES=${n.scores?.join(',') ?? '-'} COARSE=${n.coarse ?? '-'}`)
  }
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

// ---- 認証ログ (Refs ippoan/alc-app-s3#352) ----
//
// 本番の判定はモジュールのまま。認証のたびに、その場の撮影 (`VEIN IDENTIFY KEEP ALL` が出す 1 本撮りの記録) と
// モジュールの結果をサーバー (`POST /api/vein/auth-shots`) へ送って保存し、判定はサーバー側で何度でもやり直せるようにする。
// 送るのは照合の後に裏で (画面・待ち時間に触らない)。対象は検証用のテナントだけ: `GET /api/vein/auth-log/enabled` を
// ページの間に 1 度だけ引き、false・失敗なら以後送らない。送信の失敗は投げず、診断ログに 1 行だけ残す (生体データは載せない)。

/** 認証ログを送るか (最初の 1 回だけ問い合わせる。失敗は false)。テストのために戻せる */
let authLogEnabled: Promise<boolean> | null = null

/** @internal テスト用: 認証ログの「送るか」の記憶を捨てる */
export function resetVeinAuthLogEnabled(): void {
  authLogEnabled = null
}

function isAuthLogEnabled(scope: RequestTokenScope): Promise<boolean> {
  authLogEnabled ??= (async () => {
    try {
      return (await getVeinAuthLogEnabled(scope)).enabled === true
    }
    catch {
      return false
    }
  })()
  return authLogEnabled
}

/**
 * 照合の後に裏で認証ログを送る (次のタスクへ回す)。撮った記録が無ければ何もしない。
 * `hit` はモジュールが当たった枠: `self` = 本人 / `other` = 他人 / `none` = 不一致
 */
function scheduleVeinAuthShot(employeeId: string, got: KeepResult, hit: 'self' | 'other' | 'none', scope: RequestTokenScope): void {
  if (!got.record) return
  const shot = got.record
  const capturedAt = new Date().toISOString()
  setTimeout(() => {
    void sendVeinAuthShot(employeeId, shot, got, hit, capturedAt, scope)
  }, 0)
}

async function sendVeinAuthShot(employeeId: string, shot: Uint8Array, got: KeepResult, hit: 'self' | 'other' | 'none', capturedAt: string, scope: RequestTokenScope): Promise<void> {
  try {
    if (!await isAuthLogEnabled(scope)) return
    const started = performance.now()
    const shift = await postVeinAuthShot({
      employee_id: employeeId,
      shot,
      module: {
        result: got.id === null ? 'NOMATCH' : 'IDENTIFIED',
        slot: got.id,
        hit,
        score: got.score ?? null,
        thresholds: got.thresholds ?? null,
        via: got.via ?? null,
        rule: got.rule ?? null,
        fv_slot: got.fvSlot ?? null,
        fp_slot: got.fpSlot ?? null,
        fv_score: got.fvScore ?? null,
      },
      firmware: got.firmware ?? null,
      captured_at: capturedAt,
      pick: recordPick(),
    }, scope)
    // 位置のずれ (置き方の診断): 件・dx・dy・重なり・ずらさない重なり (千分率)
    const where = shift ? ` SHIFT ${shift.entry} ${shift.dx} ${shift.dy} ${shift.overlap} ${shift.overlap0}` : ''
    // 開発用の端末だけ、置いた指と登録の平面を画面の隅に描く (components/VeinShiftView.vue)
    if (shift) noteVeinShotView({ shift, shot, employeeId, scope, pick: recordPick(), at: Date.now() })
    recordVeinLine(`PC VEIN AUTHLOG OK ${Math.round(performance.now() - started)}${where}`)
  }
  catch (e) {
    recordVeinLine(`PC VEIN AUTHLOG FAILED ${messageOf(e)}`)
  }
}

/** 本人が決まった人の照合が使うモジュールの口 (`useVeinSerial` の一部) */
export interface VeinMatchPort {
  identify: (onAgain?: () => void) => Promise<number | null>
  /** 置いた 1 回の指を撮ってから照合する (`VEIN IDENTIFY KEEP`)。無い・古いファームは `identify` に戻す */
  identifyKeep?: (onAgain?: () => void) => Promise<KeepResult>
}

/** `VEIN IDENTIFY KEEP` の結果: 当たった ID (不一致は null)・撮った記録 (撮れなかった・当たらなかった古いファームは null)・モジュールの点数 (無ければ null) */
export interface KeepResult {
  id: number | null
  record: Uint8Array | null
  score?: number | null
  /** モジュールの閾値 (`THS=`、無ければ null) */
  thresholds?: number[] | null
  /** どの層で当たったか (`VIA=`)・静脈の行の規則 (`RULE=`)・各層が当てた枠 (`FV=` / `FP=`)・違う枠の静脈の点数 (`FVSCORE=`)。古いファームは null */
  via?: 'FV' | 'FP' | null
  rule?: string | null
  fvSlot?: number | null
  fpSlot?: number | null
  fvScore?: number | null
  /** ファームの版 (`DEVICE … VER=`、分からなければ null) */
  firmware?: string | null
}

/** 本人が決まった人の照合の結果: 当たった ID と、同じ置き方で撮った記録 (撮れなかった・古いファームは null) */
export interface VeinMatch {
  id: number
  record: Uint8Array | null
}

/** `VEIN IDENTIFY KEEP` を知らない古いファームの印 (`useVeinSerial.identifyKeep` が投げる Error の message) */
export const VEIN_IDENTIFY_KEEP_UNSUPPORTED = 'IDENTIFY_KEEP_UNSUPPORTED'

/** `VEIN IDENTIFY KEEP` を知らないファームだった (このページの間は普通の照合だけにする) */
let identifyKeepUnsupported = false

/**
 * 免許証・社員番号で決まった `employeeId` を、モジュールの 1:N で照合し、当たった ID がその人の承認済みの枠のときだけ
 * 結果を返す (それ以外は null)。`VEIN VERIFY <id>` は、モジュールが指定と違う ID に当たっても成功を返し、ファームも
 * 当たった ID を見ていない (2026-11-03 実測) — 他人の指で通さないため、1:N で当たった ID を対応表で引いて確かめる。
 * 照合は `VEIN IDENTIFY KEEP` (置いた 1 回の指を撮ってから照合) で行い、通れば撮った記録も返す
 * ({@link rotateVeinModuleRecord} で一番古い 1 本と入れ替える)。他人・誰にも当たらないときは
 * {@link VEIN_NOMATCH_RETRIES} 回までやり直す (やり直す前に `onRetry`)。読み取りの失敗は投げる。
 * 結果が出るたび (本人・他人・不一致) に、撮った記録を裏で認証ログとして送る (`scope` はその鍵。{@link scheduleVeinAuthShot})
 */
export async function matchVeinModuleEmployee(
  port: VeinMatchPort,
  employeeId: string,
  onAgain?: () => void,
  onRetry: () => void | Promise<void> = () => {},
  scope: RequestTokenScope = 'default',
): Promise<VeinMatch | null> {
  // 最後の回が「誰にも当たらなかった」ときの撮影 (他人の枠に当たった回はサーバーで確かめない)
  let lastMissShot: Uint8Array | null = null
  const read = async (): Promise<VeinMatch | null> => {
    const got = await readKeeping(port, onAgain)
    lastMissShot = null
    if (got.id === null) {
      scheduleVeinAuthShot(employeeId, got, 'none', scope)
      lastMissShot = got.record
      return null
    }
    const entry = (await loadVeinModuleEntries()).find(e => e.moduleId === got.id)
    const self = entry?.employeeId === employeeId && entry.approved
    scheduleVeinAuthShot(employeeId, got, self ? 'self' : 'other', scope)
    if (self) return { id: got.id, record: got.record }
    // 他人の枠に当たった: 本人ではない (乗務員の ID は残さない。撮った記録も捨てる)
    recordVeinLine(`PC VEIN OTHER ${got.id}`)
    return null
  }
  const hit = await retryOnVeinMiss(read, hit => hit === null, onRetry)
  if (hit !== null || lastMissShot === null) return hit
  return await verifyOnServer(employeeId, lastMissShot, scope)
}

/**
 * モジュールが誰にも当てなかった撮影を、本人の承認済みの記録とだけサーバーで比べる (1:1、`POST /api/vein/verify-shot`)。
 * 通ればその人の枠で通す (撮った記録はモジュールが外したものなので入れ替えに使わない = record は null)。
 * 結果は `PC VEIN SERVER11 OK|NG|FAILED …` で診断ログに残す。サーバーに届かない・古いサーバーは不一致のまま
 */
async function verifyOnServer(employeeId: string, shot: Uint8Array, scope: RequestTokenScope): Promise<VeinMatch | null> {
  const entry = (await loadVeinModuleEntries()).find(e => e.employeeId === employeeId && e.approved)
  if (!entry) return null
  try {
    const v = await postVeinVerifyShot(employeeId, shot, scope)
    recordVeinLine(`PC VEIN SERVER11 ${v.matched ? 'OK' : 'NG'} ${entry.moduleId} RULE=${v.rule ?? '-'} SCORES=${v.scores?.join(',') ?? '-'}`)
    return v.matched ? { id: entry.moduleId, record: null } : null
  }
  catch (e) {
    recordVeinLine(`PC VEIN SERVER11 FAILED ${entry.moduleId} ${messageOf(e)}`)
    return null
  }
}

/**
 * 本人が決まっていない 1:N の照合 (血圧測定台・キオスクの指だけの入口・運行管理者の入口)。当たった ID (不一致は null) を返し、
 * 不一致は {@link VEIN_NOMATCH_RETRIES} 回までやり直す (やり直す前に `onRetry`)。認証ログを送るテナントだけ、置いた 1 回の指を
 * 撮ってから照合し (`VEIN IDENTIFY KEEP ALL`)、承認済みの枠に当たった回を、当たった人の撮影として裏で送る ({@link scheduleVeinAuthShot})。
 * 不一致の回は乗務員が決まらないので送らない。送らないテナントは今までどおりの照合 (`VEIN IDENTIFY`、記録の読み出しで遅くしない)
 */
export async function identifyVeinModuleAnyone(
  port: VeinMatchPort,
  onAgain?: () => void,
  onRetry: () => void | Promise<void> = () => {},
  scope: RequestTokenScope = 'default',
): Promise<number | null> {
  const keep = await isAuthLogEnabled(scope)
  const read = async (): Promise<number | null> => {
    if (!keep) return await port.identify(onAgain)
    const got = await readKeeping(port, onAgain)
    if (got.id !== null) {
      const entry = (await loadVeinModuleEntries()).find(e => e.moduleId === got.id)
      if (entry?.approved) scheduleVeinAuthShot(entry.employeeId, got, 'self', scope)
    }
    return got.id
  }
  return await retryOnVeinMiss(read, id => id === null, onRetry)
}

/** 撮ってから照合する。`KEEP` を知らないファームなら、このページの間は普通の照合 (記録なし) に戻す */
async function readKeeping(port: VeinMatchPort, onAgain?: () => void): Promise<KeepResult> {
  if (port.identifyKeep && !identifyKeepUnsupported) {
    try {
      return await port.identifyKeep(onAgain)
    }
    catch (e) {
      if ((e as Error).message !== VEIN_IDENTIFY_KEEP_UNSUPPORTED) throw e
      identifyKeepUnsupported = true
      recordVeinLine('PC VEIN KEEP UNSUPPORTED')
    }
  }
  return { id: await port.identify(onAgain), record: null }
}

/**
 * 照合が通った人 (`employeeId`) の枠 (`match.id`) を、同じ置き方で撮った 1 本で入れ替える: サーバーで一番古い 1 本と
 * 入れ替えてこの端末の記録として預け (`…/module/devices/rotate`)、返った記録をその枠に書き戻し、対応表を新しい版にする。
 * 通るたびに入れ替わり、この端末の記録はだんだんこの端末で撮った件になる。**照合の後に裏で走らせる** (約 3 秒。画面は待たない)。
 * 投げない: 撮った記録が無ければ何もしない。預けられなければ枠はそのまま。書き戻しに失敗したら対応表から外す
 * (次の用意がサーバーの記録を書き直す)。結果は診断ログ (`PC VEIN RECORD <id> KIND=rotated` / `PC VEIN ROTATE <id> FAILED <理由>`)
 */
export async function rotateVeinModuleRecord(
  port: VeinModulePort,
  match: VeinMatch,
  employeeId: string,
  scope: RequestTokenScope = 'default',
): Promise<void> {
  if (!match.record) return
  const id = match.id
  let saved: { record: string; updated_at: string }
  try {
    saved = await rotateVeinModuleDeviceRecord(employeeId, match.record, recordPick(), scope)
  }
  catch (e) {
    recordVeinLine(`PC VEIN ROTATE ${id} FAILED ${messageOf(e)}`)
    return
  }
  const entry = (await loadVeinModuleEntries()).find(e => e.employeeId === employeeId)
  // 書き込みが途中で落ちても、古い版を承認済みとして引かないよう先に外す
  await deleteVeinModuleEntry(employeeId)
  try {
    await port.syncWrite(id, base64ToBytes(saved.record))
  }
  catch (e) {
    recordVeinLine(`PC VEIN ROTATE ${id} FAILED ${messageOf(e)}`)
    return
  }
  noteVeinModuleRecord(id, 'rotated')
  await putVeinModuleEntry({
    employeeId,
    moduleId: id,
    updatedAt: saved.updated_at,
    approved: true,
    registeredDeviceId: entry?.registeredDeviceId ?? null,
    source: 'own',
    lastUsedAt: Date.now(),
  })
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

/** このページの間に引いた社員 (照合で当たった人)。2 回目からはサーバーを待たずに使い、裏で引き直す */
const employeeCache = new Map<string, ApiEmployee>()

/** @internal テスト用: 引いた社員の記憶を捨てる */
export function resetVeinEmployeeCache(): void {
  employeeCache.clear()
}

/**
 * 社員を引く。このページで一度引いた人は待たずに返し、裏で `GET /api/employees/{id}` を引き直して記憶を新しくする
 * (照合の後にサーバーを待たないため)。初めての人はオンラインは `GET /api/employees/{id}`、
 * ネットワークの失敗は `getEmployees()` (キャッシュ) から
 */
async function findEmployee(employeeId: string, scope: RequestTokenScope): Promise<ApiEmployee | undefined> {
  const cached = employeeCache.get(employeeId)
  if (cached) {
    void getEmployeeById(employeeId, scope).then((e) => { if (e) employeeCache.set(employeeId, e) }, () => {})
    return cached
  }
  const found = await fetchEmployee(employeeId, scope)
  if (found) employeeCache.set(employeeId, found)
  return found
}

async function fetchEmployee(employeeId: string, scope: RequestTokenScope): Promise<ApiEmployee | undefined> {
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
    // 出どころを持たない古い対応表にも残す (どの端末の記録を置いているかの診断用)
    await touchVeinModuleEntry(own.native ? own : { ...own, source: serverRecordKind(template) })
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
    source: serverRecordKind(template),
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
    //
    // その場で撮った記録 (native) の人は、別の端末で登録し直して承認待ちになっただけなら消さない
    // (Refs ippoan/alc-app-s3#352)。その場の記録はモジュールの中で登録したので、静脈 (FV) と指紋互換 (FP) の
    // 両方を持つが、外へ読み出して書き戻せるのは FV だけ。一度消すと FP が戻らず、同じ記録を書き直しても
    // 通りにくくなる (2026-11-06、開発端末で 10 回中 7 回落ちた)。承認待ちかを確かめられないときも残す
    let pending: Promise<Set<string> | null> | null = null
    const pendingIds = () => (pending ??= getPendingVeinModuleTemplates(opts.scope)
      .then(list => new Set(list.map(p => p.employee_id)))
      .catch(() => null))
    for (const entry of [...entries.values()]) {
      if (!entry.approved || listed.has(entry.employeeId)) continue
      if (keepsOnSpotRecord(entry)) {
        const ids = await pendingIds()
        if (ids === null || ids.has(entry.employeeId)) {
          stat.unchanged += 1
          continue
        }
      }
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
      if (current && keepsOnSpotRecord(current)) {
        // この端末で登録した記録が承認された (サーバーが配る版が、この端末で登録した版と同じ): 対応表も承認済みにする。
        // 版が違う (この端末の分は承認待ちで、サーバーは別の承認済みの記録を配っている) なら承認待ちのまま
        if (!current.approved && current.updatedAt === t.updated_at) {
          await putVeinModuleEntry({ ...current, approved: true, registeredDeviceId: t.registered_device_id ?? null })
        }
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
          source: serverRecordKind(t),
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
