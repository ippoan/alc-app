import type { MeasurementResult } from '~/types'
import { getVideo, markVideoUploaded } from '~/utils/video-store'
import { uploadBlowVideo } from '~/utils/api'

const DB_NAME = 'alc-offline-db'
const DB_VERSION = 2
const STORE_NAME = 'pending-measurements'

/** キューに保存する際、measuredAt を ISO 文字列化したもの */
export interface SerializedResult {
  activeMeasurementId?: string
  employeeId: string
  alcoholValue: number
  resultType: 'normal' | 'over' | 'error'
  deviceUseCount: number
  facePhotoUrl?: string
  measuredAt: string
  // Medical data (BLE Medical Gateway)
  temperature?: number
  systolic?: number
  diastolic?: number
  pulse?: number
  medicalMeasuredAt?: string
  // 録画
  videoStoreId?: string
}

export interface PendingMeasurement {
  id: number
  result: SerializedResult
  facePhotoBase64?: string
  createdAt: string
  retryCount: number
  /** 送信済みの場合に設定される ISO タイムスタンプ */
  syncedAt?: string
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = (event) => {
      const db = request.result
      if ((event.oldVersion || 0) < 1) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true })
      }
      // v2: syncedAt インデックス追加 (v0→v2, v1→v2 どちらでも実行)
      const store = request.transaction!.objectStore(STORE_NAME)
      store.createIndex('syncedAt', 'syncedAt', { unique: false })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Blob を Base64 文字列に変換 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** Base64 文字列を Blob に変換 */
function base64ToBlob(base64: string): Blob {
  const parts = base64.split(',')
  const header = parts[0] || ''
  const data = parts[1] || ''
  const mime = header.match(/:(.*?);/)?.[1] || 'image/jpeg'
  const bytes = atob(data)
  const arr = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

/** オフライン測定結果をキューに追加 */
export async function enqueue(
  result: MeasurementResult,
  facePhotoBlob?: Blob,
  activeMeasurementId?: string,
  syncedAt?: string,
  videoStoreId?: string,
): Promise<number> {
  const db = await openDb()
  const serialized: SerializedResult = {
    activeMeasurementId,
    employeeId: result.employeeId,
    alcoholValue: result.alcoholValue,
    resultType: result.resultType,
    deviceUseCount: result.deviceUseCount,
    facePhotoUrl: result.facePhotoUrl,
    measuredAt: result.measuredAt.toISOString(),
    temperature: result.temperature,
    systolic: result.systolic,
    diastolic: result.diastolic,
    pulse: result.pulse,
    medicalMeasuredAt: result.medicalMeasuredAt?.toISOString(),
    videoStoreId,
  }
  const entry: Omit<PendingMeasurement, 'id'> = {
    result: serialized,
    facePhotoBase64: facePhotoBlob ? await blobToBase64(facePhotoBlob) : undefined,
    createdAt: new Date().toISOString(),
    retryCount: 0,
    syncedAt,
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const addReq = tx.objectStore(STORE_NAME).add(entry)
    addReq.onsuccess = () => resolve(addReq.result as number)
    tx.onerror = () => reject(tx.error)
  })
}

/** 全件取得 (synced/pending 両方) */
export async function getAllWithStatus(): Promise<PendingMeasurement[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const request = tx.objectStore(STORE_NAME).getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** 未送信 (syncedAt 未設定) のみ取得 */
export async function getAll(): Promise<PendingMeasurement[]> {
  const all = await getAllWithStatus()
  return all.filter(item => !item.syncedAt)
}

/** キューから 1 件削除 */
export async function remove(id: number): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** 送信済みとしてマーク */
export async function markSynced(id: number): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const getReq = store.get(id)
    getReq.onsuccess = () => {
      const entry = getReq.result as PendingMeasurement | undefined
      if (entry) {
        entry.syncedAt = new Date().toISOString()
        store.put(entry)
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** リトライ回数を更新 */
async function incrementRetry(id: number): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const getReq = store.get(id)
    getReq.onsuccess = () => {
      const entry = getReq.result as PendingMeasurement | undefined
      if (entry) {
        entry.retryCount++
        store.put(entry)
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** 未送信のみ全件削除 */
export async function clearAll(): Promise<void> {
  const pending = await getAll()
  if (pending.length === 0) return
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    for (const item of pending) {
      store.delete(item.id)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** 未送信件数を取得 */
export async function pendingCount(): Promise<number> {
  const pending = await getAll()
  return pending.length
}

/** 保存期間超過のレコードを削除 */
export async function cleanupOld(retentionDays: number): Promise<number> {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - retentionDays)
  const cutoffIso = cutoff.toISOString()

  const all = await getAllWithStatus()
  const toDelete = all.filter(item =>
    item.syncedAt && item.syncedAt < cutoffIso,
  )
  if (toDelete.length === 0) return 0

  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    for (const item of toDelete) {
      store.delete(item.id)
    }
    tx.oncomplete = () => resolve(toDelete.length)
    tx.onerror = () => reject(tx.error)
  })
}

/** IndexedDB の使用サイズを推定 (全レコードの JSON サイズ合計) */
export async function estimateDbSize(): Promise<{ totalBytes: number; recordCount: number }> {
  const all = await getAllWithStatus()
  let totalBytes = 0
  for (const item of all) {
    totalBytes += new Blob([JSON.stringify(item)]).size
  }
  return { totalBytes, recordCount: all.length }
}

const MAX_RETRIES = 5

/** 紐づいた録画をアップロードし、measurement に video_url を設定 (best-effort) */
async function uploadLinkedVideo(
  videoStoreId: string | undefined,
  measurementId: string | undefined,
  updateFn?: (id: string, data: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  if (!videoStoreId) return
  try {
    const record = await getVideo(videoStoreId)
    if (!record || record.uploadedAt) return
    const url = await uploadBlowVideo(record.videoBlob)
    if (measurementId && updateFn) {
      await updateFn(measurementId, { video_url: url }).catch(() => {})
    }
    await markVideoUploaded(videoStoreId)
    console.log('[OfflineSync] Video uploaded:', videoStoreId)
  } catch (e) {
    console.warn('[OfflineSync] Video upload failed:', videoStoreId, e)
  }
}

/** キュー内の未送信測定結果を順次 API 送信 (オンライン復帰時に呼ぶ) */
export async function flush(
  saveFn: (result: MeasurementResult, blob?: Blob) => Promise<unknown>,
  updateFn?: (id: string, data: Record<string, unknown>) => Promise<unknown>,
): Promise<{ sent: number; failed: number }> {
  const entries = await getAll()
  let sent = 0
  let failed = 0

  for (const entry of entries) {
    if (entry.retryCount >= MAX_RETRIES) {
      failed++
      continue
    }
    try {
      if (entry.result.activeMeasurementId && updateFn) {
        // 既存の started レコードを completed に更新
        let facePhotoUrl: string | undefined
        if (entry.facePhotoBase64) {
          const blob = base64ToBlob(entry.facePhotoBase64)
          // uploadFacePhoto は saveFn 経由では呼べないため、facePhotoUrl があればそれを使う
          facePhotoUrl = entry.result.facePhotoUrl
          // blob がある場合はフォールバックで saveFn を使う
          if (!facePhotoUrl) {
            // 写真アップロード付きの場合は従来の POST パスにフォールバック
            const result: MeasurementResult = {
              ...entry.result,
              measuredAt: new Date(entry.result.measuredAt),
              medicalMeasuredAt: entry.result.medicalMeasuredAt
                ? new Date(entry.result.medicalMeasuredAt)
                : undefined,
            }
            await saveFn(result, blob)
            await markSynced(entry.id)
            sent++
            continue
          }
        }
        await updateFn(entry.result.activeMeasurementId, {
          status: 'completed',
          alcohol_value: entry.result.alcoholValue,
          result_type: entry.result.resultType,
          device_use_count: entry.result.deviceUseCount,
          face_photo_url: facePhotoUrl || entry.result.facePhotoUrl,
          measured_at: entry.result.measuredAt,
          temperature: entry.result.temperature,
          systolic: entry.result.systolic,
          diastolic: entry.result.diastolic,
          pulse: entry.result.pulse,
          medical_measured_at: entry.result.medicalMeasuredAt,
          record_as_tenko: true,
        })
      } else {
        // 従来の POST パス
        const result: MeasurementResult = {
          ...entry.result,
          measuredAt: new Date(entry.result.measuredAt),
          medicalMeasuredAt: entry.result.medicalMeasuredAt
            ? new Date(entry.result.medicalMeasuredAt)
            : undefined,
        }
        const blob = entry.facePhotoBase64 ? base64ToBlob(entry.facePhotoBase64) : undefined
        await saveFn(result, blob)
      }
      await markSynced(entry.id)
      sent++
      // 録画があればバックグラウンドでアップロード
      uploadLinkedVideo(entry.result.videoStoreId, entry.result.activeMeasurementId, updateFn)
    } catch {
      await incrementRetry(entry.id)
      failed++
    }
  }

  return { sent, failed }
}
