import type { MeasurementResult } from '~/types'
import { isClient } from '~/utils/env'
import type { PendingMeasurement } from '~/utils/offline-queue'
import { saveMeasurement, updateMeasurement } from '~/utils/api'
import { enqueue, flush, getAllWithStatus, remove, clearAll, cleanupOld } from '~/utils/offline-queue'
import { reportApiFailure, reportFailure } from '~/utils/equipment-failure-report'

const DEFAULT_RETENTION_DAYS = 730 // 2年

/** オフライン時のキューイング + オンライン復帰時の自動同期 */
export function useOfflineSync() {
  const isOnline = ref(true)
  const pending = ref(0)
  const queueItems = ref<PendingMeasurement[]>([])
  const allItems = ref<PendingMeasurement[]>([])
  const isSyncing = ref(false)
  const lastSyncResult = ref<{ sent: number; failed: number } | null>(null)

  async function refreshQueue() {
    try {
      const all = await getAllWithStatus()
      allItems.value = all
      const pendingItems = all.filter(item => !item.syncedAt)
      queueItems.value = pendingItems
      pending.value = pendingItems.length
    } catch {
      // IndexedDB エラーは無視
    }
  }

  /** 測定結果を保存 (オフラインならキュー、オンラインなら直接 API) */
  async function save(result: MeasurementResult, facePhotoBlob?: Blob, activeMeasurementId?: string, videoStoreId?: string): Promise<'saved' | 'queued'> {
    if (!isOnline.value) {
      await enqueue(result, facePhotoBlob, activeMeasurementId, undefined, videoStoreId)
      await refreshQueue()
      return 'queued'
    }
    try {
      await saveMeasurement(result, facePhotoBlob)
      // オンライン送信成功時もローカルに記録 (顔写真は省略、URLのみ)
      await enqueue(result, undefined, activeMeasurementId, new Date().toISOString(), videoStoreId)
      await refreshQueue()
      return 'saved'
    } catch (e) {
      // API 失敗時もキューに退避。通信・サーバーの失敗は故障として残す (4xx は残さない)
      reportApiFailure(e, '測定結果の送信', { type: 'measurement_recording_failed' })
      await enqueue(result, facePhotoBlob, activeMeasurementId, undefined, videoStoreId)
      await refreshQueue()
      return 'queued'
    }
  }

  /** キュー内の測定結果を一括送信 */
  async function syncQueue() {
    if (isSyncing.value || !isOnline.value) return
    isSyncing.value = true
    try {
      const result = await flush(saveMeasurement, updateMeasurement)
      lastSyncResult.value = result
      if (result.failed > 0) {
        reportFailure({
          type: 'database_sync_error',
          description: '端末に保存した測定結果をサーバーへ送り直せませんでした',
          device: 'オフラインキュー',
        })
      }
      await refreshQueue()
    } finally {
      isSyncing.value = false
    }
  }

  /** キューから 1 件削除 */
  async function removeItem(id: number) {
    await remove(id)
    await refreshQueue()
  }

  /** 未送信キューを全件削除 */
  async function clearQueue() {
    await clearAll()
    await refreshQueue()
  }

  /** 保存期間設定を取得 */
  function getRetentionDays(): number {
    if (!isClient) return DEFAULT_RETENTION_DAYS
    const stored = localStorage.getItem('alc-retention-days')
    return stored ? parseInt(stored, 10) || DEFAULT_RETENTION_DAYS : DEFAULT_RETENTION_DAYS
  }

  /** 保存期間設定を変更 */
  function setRetentionDays(days: number) {
    if (!isClient) return
    localStorage.setItem('alc-retention-days', String(days))
  }

  if (isClient) {
    isOnline.value = navigator.onLine

    const handleOnline = () => {
      isOnline.value = true
      syncQueue()
    }
    const handleOffline = () => {
      isOnline.value = false
    }

    onMounted(async () => {
      window.addEventListener('online', handleOnline)
      window.addEventListener('offline', handleOffline)
      // 古いレコードをクリーンアップ
      try {
        await cleanupOld(getRetentionDays())
      } catch {
        // 無視
      }
      await refreshQueue()
    })

    onUnmounted(() => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    })
  }

  return {
    isOnline: readonly(isOnline),
    pending: readonly(pending),
    queueItems: readonly(queueItems),
    allItems: readonly(allItems),
    isSyncing: readonly(isSyncing),
    lastSyncResult: readonly(lastSyncResult),
    save,
    syncQueue,
    removeItem,
    clearQueue,
    refreshQueue,
    getRetentionDays,
    setRetentionDays,
  }
}
