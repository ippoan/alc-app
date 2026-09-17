import type { FaceDataEntry } from '~/types'
import {
  getAllDescriptorsWithTimestamp,
  bulkSaveFaceDescriptors,
} from '~/utils/face-db'
import { getFaceData, updateEmployeeFace } from '~/utils/api'
import { FACE_MODEL_VERSION } from '~/composables/useFaceDetection'

// モジュールスコープ: 複数コンポーネントから同時に sync() が走らないようにする
let globalSyncing = false

/**
 * 再同期の下限間隔。**これ以内の `sync()` は何も取りに行かない。**
 *
 * `GET /api/employees/face-data` は**承認済み全社員ぶんの embedding を毎回返す**
 * (128 次元 × 人数)。以前はカードをかざすたびにこれを `await` していたため、
 * 読み取りから「操作を選んでください」まで**実測 1.5〜6.2 秒**かかっていた
 * (Refs ippoan/rust-alc-api#644)。
 *
 * **サーバに「差分があるか」を安く尋ねる口が無い**ので時間で刻む。5 分にしたのは:
 *
 * - **同じ端末で登録した人は影響を受けない** — `useFaceAuth.register()` が
 *   サーバより先に IndexedDB へ書く (`saveFaceDescriptor`)
 * - **別端末で登録した人だけ**が最大 5 分、この端末で顔認証に落ちうる
 *   (`useFaceAuth.verify()` は手元に無ければ `verified: false`)。
 *   短くすれば安全だが、そのぶん全件ダウンロードが戻る
 *
 * **必ず最新が要る場所は `force: true` を使うこと** (下の `sync` の doc 参照)。
 */
const MIN_SYNC_INTERVAL_MS = 5 * 60 * 1000

/**
 * 直前に同期できた時刻の保存先。**リロードを跨いで覚えるのが目的** —
 * module 変数だけだと、キオスクを開き直すたびに全社員ぶんを取り直す。
 *
 * 読み書きは try/catch で囲む (private window / site data を落とした環境では
 * throw する)。**読めなければ「まだ同期していない」に倒す** = 取りに行く側 =
 * 安全側。書けなくても同期そのものは成立しているので握り潰す。
 */
const LAST_SYNC_KEY = 'alc.faceSync.lastSyncAt'

function readLastSyncAt(): number {
  try {
    const raw = localStorage.getItem(LAST_SYNC_KEY)
    const at = raw === null ? Number.NaN : Number(raw)
    return Number.isFinite(at) ? at : 0
  }
  catch {
    return 0
  }
}

function writeLastSyncAt(at: number): void {
  try {
    localStorage.setItem(LAST_SYNC_KEY, String(at))
  }
  catch { /* 保存できなくても同期は済んでいる (次回また取りに行くだけ) */ }
}

export function useFaceSync() {
  const isSyncing = ref(false)
  const lastSyncAt = ref<number | null>(null)
  const syncError = ref<string | null>(null)

  /**
   * 顔データをサーバと同期する。
   *
   * **`force` を付けない呼び出しは `MIN_SYNC_INTERVAL_MS` で間引かれる。**
   * 間引かれたときは `isSyncing` も立てずに即戻る (画面に「同期中」を出さない)。
   *
   * `force: true` は**ここで最新でないと困る場所だけ**に付ける。いま付けているのは
   * 管理者の入口 (`RoleAuthGate`) — あちらの顔認証は必須でスキップの逃げ道が無く、
   * 古いデータで落とすと**管理者が入れなくなる**。
   */
  async function sync(options?: { force?: boolean }) {
    if (globalSyncing) return
    // **間引きは globalSyncing の後** — 走っている同期を待たない挙動は従来どおり
    if (!options?.force && Date.now() - readLastSyncAt() < MIN_SYNC_INTERVAL_MS) return
    globalSyncing = true
    isSyncing.value = true
    syncError.value = null

    try {
      // 1. サーバーの顔データ取得
      const serverData = await getFaceData()
      console.log(`[FaceSync] server: ${serverData.length} 件 (approved)`, serverData.map(e => ({ id: e.id.slice(0, 8), status: e.face_approval_status, ts: e.face_embedding_at })))

      // 2. ローカルの顔データ取得
      const localRecords = await getAllDescriptorsWithTimestamp()
      console.log(`[FaceSync] local: ${localRecords.length} 件`, localRecords.map(r => ({ id: r.employeeId.slice(0, 8), approval: r.approvalStatus, model: r.modelVersion, ts: new Date(r.updatedAt).toISOString() })))

      const serverMap = new Map<string, FaceDataEntry>()
      for (const entry of serverData) {
        serverMap.set(entry.id, entry)
      }

      const localMap = new Map<string, { descriptor: number[]; updatedAt: number }>()
      for (const rec of localRecords) {
        localMap.set(rec.employeeId, {
          descriptor: Array.from(rec.descriptor),
          updatedAt: rec.updatedAt,
        })
      }

      // 3. Remote → Local: サーバーが新しければダウンロード
      const toDownload: { employeeId: string; descriptor: number[]; updatedAt: number; modelVersion?: string }[] = []
      for (const [empId, serverEntry] of serverMap) {
        const serverTs = new Date(serverEntry.face_embedding_at).getTime()
        const local = localMap.get(empId)

        if (!local || serverTs > local.updatedAt) {
          console.log(`[FaceSync] download: ${empId.slice(0, 8)} (${!local ? 'new' : 'server newer'}, serverTs=${new Date(serverTs).toISOString()}, localTs=${local ? new Date(local.updatedAt).toISOString() : 'none'})`)
          toDownload.push({
            employeeId: empId,
            descriptor: serverEntry.face_embedding,
            updatedAt: serverTs,
            modelVersion: serverEntry.face_model_version ?? undefined,
          })
        } else {
          console.log(`[FaceSync] skip download: ${empId.slice(0, 8)} (local newer or equal, serverTs=${new Date(serverTs).toISOString()}, localTs=${new Date(local.updatedAt).toISOString()})`)
        }
      }

      if (toDownload.length > 0) {
        await bulkSaveFaceDescriptors(toDownload)
        console.log(`[FaceSync] ${toDownload.length} 件ダウンロード`)
      }

      // 4. Local → Remote: サーバーに承認済みデータがない場合のみアップロード
      const downloadedIds = new Set(toDownload.map(d => d.employeeId))
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      for (const [empId, localEntry] of localMap) {
        if (!uuidRegex.test(empId)) {
          console.warn(`[FaceSync] ${empId} は UUID でないためスキップ`)
          continue
        }
        if (downloadedIds.has(empId)) continue
        if (serverMap.has(empId)) continue

        try {
          await updateEmployeeFace(empId, undefined, localEntry.descriptor, FACE_MODEL_VERSION)
          console.log(`[FaceSync] ${empId} アップロード (新規)`)
        } catch (e) {
          console.error(`[FaceSync] ${empId} のアップロード失敗:`, e)
        }
      }

      // **成功したときだけ**刻む — 失敗を刻むと、次の呼び出しまで間引かれて
      // 「取りに行けていないのに取りに行かない」状態が続く
      lastSyncAt.value = Date.now()
      writeLastSyncAt(lastSyncAt.value)
    } catch (e) {
      syncError.value = e instanceof Error ? e.message : '顔データ同期エラー'
      console.error('[FaceSync] sync error:', e)
    } finally {
      isSyncing.value = false
      globalSyncing = false
    }
  }

  // マウント時に自動同期
  onMounted(() => {
    const { deviceTenantId, accessToken } = useAuth()
    if (!deviceTenantId.value && !accessToken.value) {
      console.warn('[FaceSync] 認証未準備のため初回同期スキップ')
      return
    }
    sync()
  })

  return {
    isSyncing: readonly(isSyncing),
    lastSyncAt: readonly(lastSyncAt),
    syncError: readonly(syncError),
    sync,
  }
}
