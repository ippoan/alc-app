import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type { MeasurementResult } from '~/types'
import {
  enqueue,
  getAll,
  getAllWithStatus,
  remove,
  pendingCount,
  flush,
  clearAll,
  cleanupOld,
  markSynced,
  estimateDbSize,
} from '~/utils/offline-queue'

vi.mock('~/utils/video-store', () => ({
  getVideo: vi.fn(),
  markVideoUploaded: vi.fn(),
}))

vi.mock('~/utils/api', () => ({
  uploadBlowVideo: vi.fn(),
}))

function createResult(overrides: Partial<MeasurementResult> = {}): MeasurementResult {
  return {
    employeeId: 'EMP001',
    alcoholValue: 0.0,
    resultType: 'normal',
    deviceUseCount: 100,
    measuredAt: new Date('2026-01-15T08:00:00Z'),
    ...overrides,
  }
}

describe('offline-queue', () => {
  beforeEach(() => {
    // Create a completely fresh IndexedDB instance for each test
    globalThis.indexedDB = new IDBFactory()
    vi.clearAllMocks()
  })

  describe('enqueue', () => {
    it('should add a measurement to the queue', async () => {
      await enqueue(createResult())
      const items = await getAll()
      expect(items).toHaveLength(1)
      expect(items[0].result.employeeId).toBe('EMP001')
      expect(items[0].result.alcoholValue).toBe(0.0)
      expect(items[0].result.resultType).toBe('normal')
      expect(items[0].retryCount).toBe(0)
    })

    it('should serialize measuredAt as ISO string', async () => {
      await enqueue(createResult({ measuredAt: new Date('2026-02-14T10:00:00Z') }))
      const items = await getAll()
      expect(items[0].result.measuredAt).toBe('2026-02-14T10:00:00.000Z')
    })

    it('should store face photo as base64', async () => {
      const blob = new Blob(['fake-image-data'], { type: 'image/jpeg' })
      await enqueue(createResult(), blob)
      const items = await getAll()
      expect(items[0].facePhotoBase64).toBeTruthy()
      expect(items[0].facePhotoBase64).toContain('data:')
    })

    it('should add multiple items with auto-increment IDs', async () => {
      await enqueue(createResult({ employeeId: 'A' }))
      await enqueue(createResult({ employeeId: 'B' }))
      await enqueue(createResult({ employeeId: 'C' }))
      const items = await getAll()
      expect(items).toHaveLength(3)
      const ids = items.map(i => i.id)
      expect(new Set(ids).size).toBe(3)
    })
  })

  describe('getAll', () => {
    it('should return empty array when no items', async () => {
      const items = await getAll()
      expect(items).toEqual([])
    })
  })

  describe('remove', () => {
    it('should remove a specific item by ID', async () => {
      await enqueue(createResult({ employeeId: 'A' }))
      await enqueue(createResult({ employeeId: 'B' }))
      const items = await getAll()
      await remove(items[0].id)
      const remaining = await getAll()
      expect(remaining).toHaveLength(1)
      expect(remaining[0].result.employeeId).toBe('B')
    })
  })

  describe('pendingCount', () => {
    it('should return 0 when empty', async () => {
      expect(await pendingCount()).toBe(0)
    })

    it('should return correct count', async () => {
      await enqueue(createResult())
      await enqueue(createResult())
      expect(await pendingCount()).toBe(2)
    })
  })

  describe('flush', () => {
    it('should send all items via saveFn and remove them', async () => {
      await enqueue(createResult({ employeeId: 'A' }))
      await enqueue(createResult({ employeeId: 'B' }))

      const saveFn = vi.fn().mockResolvedValue(undefined)
      const result = await flush(saveFn)

      expect(saveFn).toHaveBeenCalledTimes(2)
      expect(result).toEqual({ sent: 2, failed: 0 })
      expect(await pendingCount()).toBe(0)
    })

    it('should increment retry count on failure', async () => {
      await enqueue(createResult())

      const saveFn = vi.fn().mockRejectedValue(new Error('network error'))
      const result = await flush(saveFn)

      expect(result).toEqual({ sent: 0, failed: 1 })
      const items = await getAll()
      expect(items[0].retryCount).toBe(1)
    })

    it('should skip items that exceeded max retries (5)', async () => {
      await enqueue(createResult())

      const saveFn = vi.fn().mockRejectedValue(new Error('fail'))
      // Exhaust retries
      for (let i = 0; i < 5; i++) {
        await flush(saveFn)
      }

      // 6th flush should skip the item
      saveFn.mockClear()
      const result = await flush(saveFn)
      expect(saveFn).not.toHaveBeenCalled()
      expect(result).toEqual({ sent: 0, failed: 1 })
    })

    it('should reconstruct MeasurementResult with Date object', async () => {
      await enqueue(createResult({ measuredAt: new Date('2026-01-15T08:00:00Z') }))

      const saveFn = vi.fn().mockResolvedValue(undefined)
      await flush(saveFn)

      const savedResult = saveFn.mock.calls[0][0]
      expect(savedResult.measuredAt).toBeInstanceOf(Date)
      expect(savedResult.measuredAt.toISOString()).toBe('2026-01-15T08:00:00.000Z')
    })

    it('should use updateFn path when activeMeasurementId is present (no photo)', async () => {
      await enqueue(
        createResult({ facePhotoUrl: 'https://example.com/photo.jpg' }),
        undefined,
        'measurement-123',
      )

      const saveFn = vi.fn().mockResolvedValue(undefined)
      const updateFn = vi.fn().mockResolvedValue(undefined)
      const result = await flush(saveFn, updateFn)

      expect(saveFn).not.toHaveBeenCalled()
      expect(updateFn).toHaveBeenCalledTimes(1)
      expect(updateFn.mock.calls[0][0]).toBe('measurement-123')
      expect(updateFn.mock.calls[0][1]).toMatchObject({
        status: 'completed',
        alcohol_value: 0.0,
        result_type: 'normal',
        face_photo_url: 'https://example.com/photo.jpg',
        // 通常点呼は全件が点呼記録の対象 (Refs #238)
        record_as_tenko: true,
      })
      expect(result).toEqual({ sent: 1, failed: 0 })
    })

    it('should use updateFn path with facePhotoBase64 and existing facePhotoUrl', async () => {
      const blob = new Blob(['photo-data'], { type: 'image/jpeg' })
      await enqueue(
        createResult({ facePhotoUrl: 'https://example.com/photo.jpg' }),
        blob,
        'measurement-456',
      )

      const saveFn = vi.fn().mockResolvedValue(undefined)
      const updateFn = vi.fn().mockResolvedValue(undefined)
      const result = await flush(saveFn, updateFn)

      // Should use updateFn since facePhotoUrl is present
      expect(updateFn).toHaveBeenCalledTimes(1)
      expect(saveFn).not.toHaveBeenCalled()
      expect(result).toEqual({ sent: 1, failed: 0 })
    })

    it('should fallback to saveFn when activeMeasurementId + facePhotoBase64 but no facePhotoUrl', async () => {
      const blob = new Blob(['photo-data'], { type: 'image/jpeg' })
      await enqueue(
        createResult(), // no facePhotoUrl
        blob,
        'measurement-789',
      )

      const saveFn = vi.fn().mockResolvedValue(undefined)
      const updateFn = vi.fn().mockResolvedValue(undefined)
      const result = await flush(saveFn, updateFn)

      // Falls back to saveFn because no facePhotoUrl
      expect(saveFn).toHaveBeenCalledTimes(1)
      expect(updateFn).not.toHaveBeenCalled()
      expect(result).toEqual({ sent: 1, failed: 0 })
    })

    it('should reconstruct medicalMeasuredAt as Date when present', async () => {
      await enqueue(createResult({
        medicalMeasuredAt: new Date('2026-01-15T09:00:00Z'),
        temperature: 36.5,
      }))

      const saveFn = vi.fn().mockResolvedValue(undefined)
      await flush(saveFn)

      const savedResult = saveFn.mock.calls[0][0]
      expect(savedResult.medicalMeasuredAt).toBeInstanceOf(Date)
      expect(savedResult.medicalMeasuredAt.toISOString()).toBe('2026-01-15T09:00:00.000Z')
    })

    it('should pass face photo blob to saveFn (traditional POST path)', async () => {
      const blob = new Blob(['photo'], { type: 'image/jpeg' })
      await enqueue(createResult(), blob)

      const saveFn = vi.fn().mockResolvedValue(undefined)
      await flush(saveFn)

      expect(saveFn).toHaveBeenCalledTimes(1)
      const passedBlob = saveFn.mock.calls[0][1]
      expect(passedBlob).toBeInstanceOf(Blob)
    })

    it('should upload linked video after successful send', async () => {
      const { getVideo, markVideoUploaded } = await import('~/utils/video-store')
      const { uploadBlowVideo } = await import('~/utils/api')

      const mockGetVideo = vi.mocked(getVideo)
      const mockMarkUploaded = vi.mocked(markVideoUploaded)
      const mockUploadVideo = vi.mocked(uploadBlowVideo)

      const videoBlob = new Blob(['video-data'], { type: 'video/webm' })
      mockGetVideo.mockResolvedValue({ id: 'vid-1', videoBlob, employeeId: 'EMP001', createdAt: new Date().toISOString() })
      mockUploadVideo.mockResolvedValue('https://example.com/video.webm')
      mockMarkUploaded.mockResolvedValue(undefined)

      await enqueue(
        createResult(),
        undefined,
        undefined,
        undefined,
        'vid-1',
      )

      const saveFn = vi.fn().mockResolvedValue(undefined)
      const updateFn = vi.fn().mockResolvedValue(undefined)
      await flush(saveFn, updateFn)

      // Wait for background uploadLinkedVideo to complete
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(mockGetVideo).toHaveBeenCalledWith('vid-1')
      expect(mockUploadVideo).toHaveBeenCalledWith(videoBlob)
      expect(mockMarkUploaded).toHaveBeenCalledWith('vid-1')
    })

    it('should skip video upload when video record not found', async () => {
      const { getVideo } = await import('~/utils/video-store')
      const { uploadBlowVideo } = await import('~/utils/api')

      vi.mocked(getVideo).mockResolvedValue(undefined)

      await enqueue(createResult(), undefined, undefined, undefined, 'vid-missing')

      const saveFn = vi.fn().mockResolvedValue(undefined)
      await flush(saveFn)

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(vi.mocked(uploadBlowVideo)).not.toHaveBeenCalled()
    })

    it('should skip video upload when videoStoreId is undefined', async () => {
      const { getVideo } = await import('~/utils/video-store')

      await enqueue(createResult()) // no videoStoreId

      const saveFn = vi.fn().mockResolvedValue(undefined)
      await flush(saveFn)

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(vi.mocked(getVideo)).not.toHaveBeenCalled()
    })

    it('should not crash when video upload fails', async () => {
      const { getVideo } = await import('~/utils/video-store')
      vi.mocked(getVideo).mockRejectedValue(new Error('video error'))

      await enqueue(
        createResult(),
        undefined,
        undefined,
        undefined,
        'vid-fail',
      )

      const saveFn = vi.fn().mockResolvedValue(undefined)
      const result = await flush(saveFn)

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(result).toEqual({ sent: 1, failed: 0 })
    })

    it('should skip video upload when video already uploaded', async () => {
      const { getVideo } = await import('~/utils/video-store')
      const { uploadBlowVideo } = await import('~/utils/api')

      vi.mocked(getVideo).mockResolvedValue({
        id: 'vid-2',
        videoBlob: new Blob([]),
        employeeId: 'EMP001',
        createdAt: new Date().toISOString(),
        uploadedAt: new Date().toISOString(),
      })

      await enqueue(createResult(), undefined, undefined, undefined, 'vid-2')

      const saveFn = vi.fn().mockResolvedValue(undefined)
      await flush(saveFn)

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(vi.mocked(uploadBlowVideo)).not.toHaveBeenCalled()
    })

    it('should not crash when updateFn rejects during video url update', async () => {
      const { getVideo, markVideoUploaded } = await import('~/utils/video-store')
      const { uploadBlowVideo } = await import('~/utils/api')

      vi.mocked(getVideo).mockResolvedValue({
        id: 'vid-err',
        videoBlob: new Blob(['data']),
        employeeId: 'EMP001',
        createdAt: new Date().toISOString(),
      })
      vi.mocked(uploadBlowVideo).mockResolvedValue('https://example.com/v.webm')
      vi.mocked(markVideoUploaded).mockResolvedValue(undefined)

      await enqueue(
        createResult({ facePhotoUrl: 'https://photo.jpg' }),
        undefined,
        'meas-err-1',
        undefined,
        'vid-err',
      )

      const saveFn = vi.fn().mockResolvedValue(undefined)
      // updateFn succeeds for measurement completion but rejects for video_url update
      const updateFn = vi.fn()
        .mockResolvedValueOnce(undefined) // measurement completion succeeds
        .mockRejectedValueOnce(new Error('update failed')) // video_url update fails

      const result = await flush(saveFn, updateFn)
      await new Promise(resolve => setTimeout(resolve, 50))

      // flush itself should succeed, video update error is caught
      expect(result).toEqual({ sent: 1, failed: 0 })
      // markVideoUploaded should still be called because uploadBlowVideo succeeded
      expect(vi.mocked(markVideoUploaded)).toHaveBeenCalledWith('vid-err')
    })

    it('should call updateFn for video url when measurementId is present', async () => {
      const { getVideo, markVideoUploaded } = await import('~/utils/video-store')
      const { uploadBlowVideo } = await import('~/utils/api')

      vi.mocked(getVideo).mockResolvedValue({
        id: 'vid-3',
        videoBlob: new Blob(['data']),
        employeeId: 'EMP001',
        createdAt: new Date().toISOString(),
      })
      vi.mocked(uploadBlowVideo).mockResolvedValue('https://example.com/v.webm')
      vi.mocked(markVideoUploaded).mockResolvedValue(undefined)

      await enqueue(
        createResult({ facePhotoUrl: 'https://photo.jpg' }),
        undefined,
        'meas-id-1',
        undefined,
        'vid-3',
      )

      const saveFn = vi.fn().mockResolvedValue(undefined)
      const updateFn = vi.fn().mockResolvedValue(undefined)
      await flush(saveFn, updateFn)

      await new Promise(resolve => setTimeout(resolve, 50))
      // updateFn called once for measurement completion, once for video_url
      expect(updateFn).toHaveBeenCalledWith('meas-id-1', { video_url: 'https://example.com/v.webm' })
    })
  })

  describe('getAllWithStatus', () => {
    it('should return all items including synced ones', async () => {
      const id1 = await enqueue(createResult({ employeeId: 'A' }))
      await enqueue(createResult({ employeeId: 'B' }))
      await markSynced(id1)

      const all = await getAllWithStatus()
      expect(all).toHaveLength(2)

      const pending = await getAll()
      expect(pending).toHaveLength(1)
      expect(pending[0].result.employeeId).toBe('B')
    })
  })

  describe('markSynced', () => {
    it('should set syncedAt on a pending item', async () => {
      const id = await enqueue(createResult())
      await markSynced(id)

      const all = await getAllWithStatus()
      expect(all[0].syncedAt).toBeTruthy()
    })

    it('should not throw for non-existent id', async () => {
      await expect(markSynced(9999)).resolves.not.toThrow()
    })
  })

  describe('clearAll', () => {
    it('should remove only unsent items', async () => {
      const id1 = await enqueue(createResult({ employeeId: 'A' }))
      await enqueue(createResult({ employeeId: 'B' }))
      await markSynced(id1)

      await clearAll()

      const all = await getAllWithStatus()
      // Only the synced one should remain
      expect(all).toHaveLength(1)
      expect(all[0].syncedAt).toBeTruthy()
    })

    it('should do nothing when no pending items', async () => {
      await expect(clearAll()).resolves.not.toThrow()
    })
  })

  describe('cleanupOld', () => {
    it('should delete synced items older than retention days', async () => {
      // Enqueue with syncedAt in the past
      const oldDate = new Date()
      oldDate.setDate(oldDate.getDate() - 10)
      const id = await enqueue(createResult(), undefined, undefined, oldDate.toISOString())

      const deleted = await cleanupOld(5)
      expect(deleted).toBe(1)

      const all = await getAllWithStatus()
      expect(all).toHaveLength(0)
    })

    it('should not delete recent synced items', async () => {
      const recentDate = new Date()
      await enqueue(createResult(), undefined, undefined, recentDate.toISOString())

      const deleted = await cleanupOld(5)
      expect(deleted).toBe(0)

      const all = await getAllWithStatus()
      expect(all).toHaveLength(1)
    })

    it('should not delete unsynced items', async () => {
      await enqueue(createResult())

      const deleted = await cleanupOld(0)
      expect(deleted).toBe(0)
    })

    it('should return 0 when no items to clean', async () => {
      const deleted = await cleanupOld(5)
      expect(deleted).toBe(0)
    })
  })

  describe('estimateDbSize', () => {
    it('should return 0 for empty database', async () => {
      const size = await estimateDbSize()
      expect(size).toEqual({ totalBytes: 0, recordCount: 0 })
    })

    it('should return positive size for non-empty database', async () => {
      await enqueue(createResult())
      await enqueue(createResult())

      const size = await estimateDbSize()
      expect(size.recordCount).toBe(2)
      expect(size.totalBytes).toBeGreaterThan(0)
    })
  })

  describe('enqueue with facePhotoBlob (base64 conversion)', () => {
    it('should convert blob to base64 data URL', async () => {
      const imageData = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]) // JPEG magic bytes
      const blob = new Blob([imageData], { type: 'image/jpeg' })
      const id = await enqueue(createResult(), blob)
      const items = await getAllWithStatus()
      const entry = items.find(i => i.id === id)!
      expect(entry.facePhotoBase64).toBeTruthy()
      expect(entry.facePhotoBase64).toMatch(/^data:/)
      expect(entry.facePhotoBase64).toContain('base64,')
    })

    it('should store undefined facePhotoBase64 when no blob provided', async () => {
      await enqueue(createResult())
      const items = await getAll()
      expect(items[0].facePhotoBase64).toBeUndefined()
    })
  })

  describe('incrementRetry (via flush failure)', () => {
    it('should increment retryCount for existing entry on flush error', async () => {
      await enqueue(createResult())
      const saveFn = vi.fn().mockRejectedValue(new Error('network'))

      await flush(saveFn)
      let items = await getAll()
      expect(items[0].retryCount).toBe(1)

      await flush(saveFn)
      items = await getAll()
      expect(items[0].retryCount).toBe(2)

      await flush(saveFn)
      items = await getAll()
      expect(items[0].retryCount).toBe(3)
    })
  })

  describe('flush with non-existent entry (incrementRetry no-op)', () => {
    it('should not crash when incrementRetry targets a deleted entry', async () => {
      // Enqueue then delete, but simulate flush failure to trigger incrementRetry on non-existent id
      const id = await enqueue(createResult())
      await remove(id)

      // Manually insert an entry with a specific id that we'll delete mid-flight
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('alc-offline-db', 2)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('pending-measurements', 'readwrite')
        tx.objectStore('pending-measurements').add({
          id: 99999,
          result: {
            employeeId: 'EMP-GHOST',
            alcoholValue: 0.0,
            resultType: 'normal' as const,
            deviceUseCount: 100,
            measuredAt: '2026-01-15T08:00:00.000Z',
          },
          createdAt: new Date().toISOString(),
          retryCount: 0,
        })
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => reject(tx.error)
      })

      // Delete the entry before flush tries to incrementRetry
      const saveFn = vi.fn().mockImplementation(async () => {
        // Delete the entry while flush is processing
        await remove(99999)
        throw new Error('fail')
      })
      const result = await flush(saveFn)
      // incrementRetry is called on id 99999 but the entry is already gone
      // Should not crash
      expect(result).toEqual({ sent: 0, failed: 1 })
    })
  })

  describe('flush with facePhotoBase64 (base64-to-blob conversion)', () => {
    it('should convert facePhotoBase64 back to Blob in traditional POST path', async () => {
      // Enqueue with a real blob so facePhotoBase64 is stored
      const blob = new Blob(['photo-data'], { type: 'image/jpeg' })
      await enqueue(createResult(), blob) // no activeMeasurementId → traditional POST path

      const saveFn = vi.fn().mockResolvedValue(undefined)
      const result = await flush(saveFn)

      expect(result).toEqual({ sent: 1, failed: 0 })
      expect(saveFn).toHaveBeenCalledTimes(1)
      const passedBlob = saveFn.mock.calls[0][1]
      expect(passedBlob).toBeInstanceOf(Blob)
      expect(passedBlob.type).toBe('image/jpeg')
    })

    it('should convert facePhotoBase64 to blob and fallback to saveFn when activeMeasurementId + no facePhotoUrl', async () => {
      const blob = new Blob(['face-photo'], { type: 'image/png' })
      await enqueue(createResult(), blob, 'meas-active-1') // activeMeasurementId but no facePhotoUrl

      const saveFn = vi.fn().mockResolvedValue(undefined)
      const updateFn = vi.fn().mockResolvedValue(undefined)
      const result = await flush(saveFn, updateFn)

      // Should fallback to saveFn (not updateFn) because no facePhotoUrl
      expect(saveFn).toHaveBeenCalledTimes(1)
      expect(updateFn).not.toHaveBeenCalled()
      expect(result).toEqual({ sent: 1, failed: 0 })

      // Verify the blob was reconstructed and passed
      const passedBlob = saveFn.mock.calls[0][1]
      expect(passedBlob).toBeInstanceOf(Blob)
    })

    it('should use updateFn when activeMeasurementId + facePhotoBase64 + facePhotoUrl present', async () => {
      const blob = new Blob(['photo'], { type: 'image/jpeg' })
      await enqueue(
        createResult({ facePhotoUrl: 'https://example.com/face.jpg' }),
        blob,
        'meas-with-url',
      )

      const saveFn = vi.fn().mockResolvedValue(undefined)
      const updateFn = vi.fn().mockResolvedValue(undefined)
      const result = await flush(saveFn, updateFn)

      // Should use updateFn because facePhotoUrl is available
      expect(updateFn).toHaveBeenCalledTimes(1)
      expect(saveFn).not.toHaveBeenCalled()
      expect(result).toEqual({ sent: 1, failed: 0 })
      expect(updateFn.mock.calls[0][1]).toMatchObject({
        face_photo_url: 'https://example.com/face.jpg',
      })
    })

    it('should handle malformed base64 string without comma (fallback branches in base64ToBlob)', async () => {
      // First, create the DB by enqueuing a dummy entry, then remove it
      const dummyId = await enqueue(createResult({ employeeId: 'DUMMY' }))
      await remove(dummyId)

      // Now directly insert an entry with a malformed facePhotoBase64 (no comma separator)
      // This triggers the || '' fallback branches in base64ToBlob (L73-75)
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('alc-offline-db', 2)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('pending-measurements', 'readwrite')
        tx.objectStore('pending-measurements').add({
          result: {
            employeeId: 'EMP001',
            alcoholValue: 0.0,
            resultType: 'normal' as const,
            deviceUseCount: 100,
            measuredAt: '2026-01-15T08:00:00.000Z',
          },
          facePhotoBase64: ',', // Split produces ['', ''] → parts[0] is '' → || '' fires, parts[1] is '' → || '' fires
          createdAt: new Date().toISOString(),
          retryCount: 0,
        })
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => reject(tx.error)
      })

      const saveFn = vi.fn().mockResolvedValue(undefined)
      const result = await flush(saveFn)

      expect(result).toEqual({ sent: 1, failed: 0 })
      expect(saveFn).toHaveBeenCalledTimes(1)
      // The blob should still be created (empty data, default mime)
      const passedBlob = saveFn.mock.calls[0][1]
      expect(passedBlob).toBeInstanceOf(Blob)
      expect(passedBlob.type).toBe('image/jpeg') // fallback mime
    })

    it('should handle base64 string with non-standard header (mime fallback)', async () => {
      // First, create the DB
      const dummyId = await enqueue(createResult({ employeeId: 'DUMMY' }))
      await remove(dummyId)

      // Insert entry with base64 that has a comma but no mime pattern in header
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('alc-offline-db', 2)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('pending-measurements', 'readwrite')
        tx.objectStore('pending-measurements').add({
          result: {
            employeeId: 'EMP002',
            alcoholValue: 0.0,
            resultType: 'normal' as const,
            deviceUseCount: 100,
            measuredAt: '2026-01-15T08:00:00.000Z',
          },
          facePhotoBase64: 'invalid-header,' + btoa('test'), // header has no :mime; pattern
          createdAt: new Date().toISOString(),
          retryCount: 0,
        })
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => reject(tx.error)
      })

      const saveFn = vi.fn().mockResolvedValue(undefined)
      const result = await flush(saveFn)

      expect(result).toEqual({ sent: 1, failed: 0 })
      const passedBlob = saveFn.mock.calls[0][1]
      expect(passedBlob).toBeInstanceOf(Blob)
      expect(passedBlob.type).toBe('image/jpeg') // mime fallback
    })

    it('should handle medicalMeasuredAt in fallback saveFn path with activeMeasurementId', async () => {
      const blob = new Blob(['photo'], { type: 'image/jpeg' })
      await enqueue(
        createResult({ medicalMeasuredAt: new Date('2026-03-15T10:00:00Z') }),
        blob,
        'meas-medical',
      )

      const saveFn = vi.fn().mockResolvedValue(undefined)
      const updateFn = vi.fn().mockResolvedValue(undefined)
      const result = await flush(saveFn, updateFn)

      expect(saveFn).toHaveBeenCalledTimes(1)
      const savedResult = saveFn.mock.calls[0][0]
      expect(savedResult.medicalMeasuredAt).toBeInstanceOf(Date)
      expect(savedResult.medicalMeasuredAt.toISOString()).toBe('2026-03-15T10:00:00.000Z')
      expect(result).toEqual({ sent: 1, failed: 0 })
    })
  })

  describe('v1→v2 migration (oldVersion=1)', () => {
    it('skips createObjectStore and adds syncedAt index', async () => {
      // First, manually create the DB at version 1 (store only, no index)
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('alc-offline-db', 1)
        req.onupgradeneeded = () => {
          req.result.createObjectStore('pending-measurements', { keyPath: 'id', autoIncrement: true })
        }
        req.onsuccess = () => { req.result.close(); resolve() }
        req.onerror = () => reject(req.error)
      })

      // Now the app's openDb() opens at version 2, triggering upgrade from 1→2
      // This exercises: (oldVersion < 1) = false branch
      const items = await getAll()
      expect(items).toEqual([])

      // Verify the index was created by enqueueing + marking synced
      const id = await enqueue(createResult(), undefined, undefined, new Date().toISOString())
      const all = await getAllWithStatus()
      expect(all).toHaveLength(1)
      expect(all[0].syncedAt).toBeTruthy()
    })
  })

  describe('enqueue extras', () => {
    it('should serialize medicalMeasuredAt as ISO string', async () => {
      await enqueue(createResult({
        medicalMeasuredAt: new Date('2026-03-15T12:00:00Z'),
        temperature: 36.7,
      }))
      const items = await getAll()
      expect(items[0].result.medicalMeasuredAt).toBe('2026-03-15T12:00:00.000Z')
      expect(items[0].result.temperature).toBe(36.7)
    })

    it('should store activeMeasurementId', async () => {
      await enqueue(createResult(), undefined, 'act-123')
      const items = await getAll()
      expect(items[0].result.activeMeasurementId).toBe('act-123')
    })

    it('should store videoStoreId', async () => {
      await enqueue(createResult(), undefined, undefined, undefined, 'vid-store-1')
      const items = await getAll()
      expect(items[0].result.videoStoreId).toBe('vid-store-1')
    })

    it('should store medical data fields', async () => {
      await enqueue(createResult({
        temperature: 36.5,
        systolic: 120,
        diastolic: 80,
        pulse: 72,
      }))
      const items = await getAll()
      expect(items[0].result.temperature).toBe(36.5)
      expect(items[0].result.systolic).toBe(120)
      expect(items[0].result.diastolic).toBe(80)
      expect(items[0].result.pulse).toBe(72)
    })
  })
})
