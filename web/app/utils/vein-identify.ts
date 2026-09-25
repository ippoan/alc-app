/**
 * キオスクの指静脈による本人確認 (Refs ippoan/vein-match#20)。
 *
 * **オンラインはサーバー、オフラインはブラウザの wasm で照合する。**
 * - オンライン: `POST /api/vein/identify` (当たるとサーバーが学習する)
 * - オフライン (`navigator.onLine === false`、または fetch がネットワークで失敗):
 *   手元の写し (`vein-db.ts`) を wasm で照合する (`vein-match.ts`。学習しない)
 *
 * 当たったあとの社員の情報は、オンラインは `GET /api/employees/{id}`、オフラインは
 * `getEmployees()` (Service Worker が NetworkFirst でキャッシュしている) から引く。
 */
import type { ApiEmployee } from '~/types'
import { apiErrorMessage, getEmployeeById, getEmployees, getVeinTemplates, identifyVein } from '~/utils/api'
import { loadVeinTemplates, saveVeinTemplates } from '~/utils/vein-db'
import { loadVeinWasm, matchVeinOffline } from '~/utils/vein-match'

/** 点呼の開始時に同期し直す間隔 (前回の同期からこれだけたっていれば取り直す) */
export const VEIN_TEMPLATE_SYNC_INTERVAL_MS = 10 * 60 * 1000

export const VEIN_NO_MATCH_MESSAGE = '指静脈が一致する乗務員が見つかりません。もう一度読み取るか、NFC か社員番号で進んでください'
export const VEIN_OFFLINE_STALE_MESSAGE = '指静脈の照合データが古くなっています。オンラインで同期してください'
export const VEIN_OFFLINE_NO_DATA_MESSAGE = '指静脈の照合データがありません。オンラインで同期してください'

let lastSyncedAt: number | null = null

/**
 * テンプレートの一覧をサーバーから取り、手元をまるごと差し替える。あわせて wasm を
 * 1 度読んでおく (Service Worker にキャッシュさせ、オフラインでも読めるようにする)。
 *
 * `ifOlderThanMs` を渡すと、前回の同期からその時間がたっていなければ何もしない。
 * **失敗しても投げない** (オフラインなら手元の写しで照合を続ける)。同期したら true。
 */
export async function syncVeinTemplates(opts: { ifOlderThanMs?: number } = {}): Promise<boolean> {
  if (opts.ifOlderThanMs !== undefined && lastSyncedAt !== null && Date.now() - lastSyncedAt < opts.ifOlderThanMs) {
    return false
  }
  try {
    const res = await getVeinTemplates()
    await saveVeinTemplates({
      logicVersion: res.logic_version,
      fetchedAt: Date.now(),
      templates: res.templates.map(t => ({ employeeId: t.employee_id, template: t.template, updatedAt: t.updated_at })),
    })
    lastSyncedAt = Date.now()
    await loadVeinWasm()
    return true
  }
  catch (e) {
    console.warn('[vein] 照合データの同期に失敗 (手元の写しで続ける):', e)
    return false
  }
}

export type VeinIdentifyOutcome =
  | { kind: 'hit'; employee: ApiEmployee }
  | { kind: 'miss' }
  /** 照合できなかった。`message` はそのまま画面に出す */
  | { kind: 'error'; message: string }

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 読み取った特徴量 (hex) で乗務員を特定する。
 *
 * fetch のネットワーク失敗は `TypeError` で来る (HTTP の失敗は `API エラー (…)` の Error) ので、
 * `TypeError` だけをオフラインとして wasm の照合へ回す。422 などはそのまま理由を返す。
 */
export async function identifyVeinEmployee(chara: string): Promise<VeinIdentifyOutcome> {
  if (navigator.onLine) {
    try {
      const res = await identifyVein(chara)
      if (!res.employee_id) return { kind: 'miss' }
      return { kind: 'hit', employee: await getEmployeeById(res.employee_id) }
    }
    catch (e) {
      if (!(e instanceof TypeError)) {
        return { kind: 'error', message: apiErrorMessage(e) ?? messageOf(e) }
      }
    }
  }
  return identifyVeinEmployeeOffline(chara)
}

async function identifyVeinEmployeeOffline(chara: string): Promise<VeinIdentifyOutcome> {
  try {
    const snapshot = await loadVeinTemplates()
    if (!snapshot) return { kind: 'error', message: VEIN_OFFLINE_NO_DATA_MESSAGE }
    const match = await matchVeinOffline(chara, snapshot)
    switch (match.kind) {
      case 'miss':
        return { kind: 'miss' }
      case 'version_mismatch':
        return { kind: 'error', message: VEIN_OFFLINE_STALE_MESSAGE }
      case 'invalid_chara':
        return { kind: 'error', message: `指静脈の読み取りデータの形式が正しくありません (${match.code})` }
    }
    const employee = (await getEmployees()).find(e => e.id === match.employeeId)
    if (!employee) {
      return { kind: 'error', message: '指静脈は一致しましたが、乗務員の情報が手元にありません。NFC か社員番号で進んでください' }
    }
    return { kind: 'hit', employee }
  }
  catch (e) {
    return { kind: 'error', message: `オフラインの指静脈照合に失敗しました: ${messageOf(e)}` }
  }
}
