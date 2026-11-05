/**
 * キオスクが機器・記録・通信の失敗を `POST /tenko/equipment-failures` へ自動で残す口
 * (自己点検表の不足を埋める: 故障の自動記録)。
 *
 * **点呼の流れを止めない。** ここから例外は出ない (`reportFailure` は戻り値なしの
 * fire-and-forget で、中の失敗は握り潰す)。記録できなかったことで利用者に何かを出すこともしない。
 *
 * 記録するのは**機器・保存・通信の失敗だけ**。利用者の操作の誤り (指静脈の不一致・社員番号の
 * 打ち間違い・サーバーが 4xx で返す入力の不備) は故障ではないので、呼び手が渡さない
 * (`reportApiFailure` は 4xx を自分で除く)。
 *
 * **同じ失敗を連打しない**: `failure_type` + `description` が同じものは {@link DEDUP_WINDOW_MS}
 * のあいだ 1 回だけ送る (機器が壊れていると同じエラーが秒単位で出続ける)。
 *
 * **API に届かないとき**: 通信そのものが落ちている時に送った記録は、端末のメモリ上の待ち行列
 * (最大 {@link MAX_PENDING} 件。あふれたら古い方を捨てる) に預け、通信が戻った合図 (`online`) か
 * 次の記録の送信のときに送り直す。既存のオフラインキュー (`offline-queue`、IndexedDB) は
 * `MeasurementResult` 専用で形が合わないので使わない — **ページを読み込み直すと待ち行列は消える**
 * (消えて困る重さの記録ではない: 同じ故障が続けば次に再び記録される)。
 */
import { apiErrorCode, reportEquipmentFailure } from '~/utils/api'
import type { CreateEquipmentFailure } from '~/types'

/** サーバーが受ける `failure_type` のうち、キオスクが自動で使うもの */
export type KioskFailureType =
  | 'face_recognition_error'
  | 'measurement_recording_failed'
  | 'kiosk_offline'
  | 'database_sync_error'
  | 'photo_storage_error'

/** 同じ失敗を再度送るまでの間隔 */
export const DEDUP_WINDOW_MS = 5 * 60 * 1000
/** 通信が落ちている間に預かる記録の上限 */
export const MAX_PENDING = 20
/** `detected_by` に入れる。人ではなくキオスクが見つけたことを後から読めるようにする */
export const DETECTED_BY = 'キオスク自動記録'

export interface FailureReport {
  type: KioskFailureType
  /** 短い日本語の説明。**同じ失敗には同じ文言を使う** (重複判定がこれを見る) */
  description: string
  /** 壊れている機器の名前 (FC-1200・指静脈リーダー・カメラ など) */
  device?: string
  /** 分かっていれば点呼セッションの ID */
  sessionId?: string
}

/** 直近に送った失敗 (`type|description` → 時刻 ms)。メモリのみ */
const recent = new Map<string, number>()
/** 通信が落ちていて送れなかった記録 */
let pending: CreateEquipmentFailure[] = []
let onlineHooked = false

function toBody(report: FailureReport, detectedAt: Date): CreateEquipmentFailure {
  return {
    failure_type: report.type,
    description: report.description,
    detected_at: detectedAt.toISOString(),
    detected_by: DETECTED_BY,
    ...(report.device ? { affected_device: report.device } : {}),
    ...(report.sessionId ? { session_id: report.sessionId } : {}),
  }
}

/** 4xx は「送り直しても通らない」ので待ち行列に戻さない */
function isClientError(e: unknown): boolean {
  const status = httpStatusOf(e)
  return status !== null && status >= 400 && status < 500
}

function enqueue(body: CreateEquipmentFailure): void {
  pending.push(body)
  if (pending.length > MAX_PENDING) pending = pending.slice(pending.length - MAX_PENDING)
  hookOnline()
}

/** 通信が戻った合図で預かりを送る (1 度だけ登録する) */
function hookOnline(): void {
  if (onlineHooked) return
  onlineHooked = true
  window.addEventListener('online', () => { void flushPending() })
}

/** 預かった記録を古い順に送る。1 件でも通信で落ちたらそこで止めて残りを預け直す */
export async function flushPending(): Promise<void> {
  const batch = pending
  pending = []
  for (let i = 0; i < batch.length; i++) {
    try {
      await reportEquipmentFailure(batch[i]!)
    }
    catch (e) {
      if (isClientError(e)) continue
      pending = [...batch.slice(i), ...pending]
      return
    }
  }
}

async function send(body: CreateEquipmentFailure): Promise<void> {
  try {
    await reportEquipmentFailure(body)
    if (pending.length > 0) await flushPending()
  }
  catch (e) {
    if (isClientError(e)) {
      console.warn('[FailureReport] 故障の記録を送れませんでした (入力が受け付けられません):', body.failure_type)
      return
    }
    // 通信が落ちている: 預かって、戻ったときに送り直す
    enqueue(body)
    console.warn('[FailureReport] 故障の記録を送れなかったので預かります:', body.failure_type)
  }
}

/**
 * 失敗を 1 件記録する。**待たなくてよい・例外は出ない。**
 * 同じ `type` + `description` が {@link DEDUP_WINDOW_MS} 以内なら何もしない。
 */
export function reportFailure(report: FailureReport): void {
  try {
    const now = Date.now()
    const key = `${report.type}|${report.description}`
    const last = recent.get(key)
    if (last !== undefined && now - last < DEDUP_WINDOW_MS) return
    recent.set(key, now)
    // 古い印を掃除する (端末は動きっぱなしなので増え続けさせない)
    for (const [k, t] of recent) {
      if (now - t >= DEDUP_WINDOW_MS) recent.delete(k)
    }
    void send(toBody(report, new Date(now)))
  }
  catch (e) {
    console.warn('[FailureReport] 故障の記録に失敗しました:', e)
  }
}

/** `Error` の `.status`、無ければ `API エラー (<status>): …` の文言から HTTP status を読む。無ければ null */
export function httpStatusOf(e: unknown): number | null {
  const s = (e as { status?: unknown } | null)?.status
  if (typeof s === 'number') return s
  const m = e instanceof Error ? /^API エラー \((\d{3})\)/.exec(e.message) : null
  return m ? Number(m[1]) : null
}

/**
 * API 呼び出しの失敗を故障として記録する。分類:
 *
 * - **4xx は記録しない** (入力の不備・権限・存在しない ID。故障ではない)
 * - **HTTP の応答が無い** (fetch の TypeError・タイムアウトなど) → `kiosk_offline` (通信できない)
 * - **5xx** → `database_sync_error` (サーバー側の保存・同期の失敗)
 *
 * `type` を渡すと分類を上書きする (測定の記録・写真の保存など、何が失敗したかが分かっている場面)。
 * その場合も 4xx は記録しない。
 */
export function reportApiFailure(
  e: unknown,
  what: string,
  opts: { sessionId?: string, type?: KioskFailureType, device?: string } = {},
): void {
  const status = httpStatusOf(e)
  if (status !== null && status >= 400 && status < 500) return
  // 点呼の記録が書けなかった (`record_failed`) は、サーバーが機器故障として記録済み。重ねて残さない
  if (apiErrorCode(e) === 'record_failed') return
  const type: KioskFailureType = opts.type ?? (status === null ? 'kiosk_offline' : 'database_sync_error')
  const description = status === null
    ? `${what}に失敗しました (サーバーに接続できません)`
    : `${what}に失敗しました (サーバーエラー ${status})`
  reportFailure({ type, description, device: opts.device, sessionId: opts.sessionId })
}

/** テスト用: 重複判定と待ち行列を空にする */
export function resetFailureReportState(): void {
  recent.clear()
  pending = []
}

/** テスト用: 預かっている件数 */
export function pendingFailureCount(): number {
  return pending.length
}
