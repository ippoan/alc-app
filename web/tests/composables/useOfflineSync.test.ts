import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import type { MeasurementResult } from '~/types'
import { withSetup } from '../helpers/with-setup'

// Mock the API and offline-queue modules
vi.mock('~/utils/api', () => ({
  saveMeasurement: vi.fn(),
  updateMeasurement: vi.fn(),
}))

vi.mock('~/utils/offline-queue', () => ({
  enqueue: vi.fn().mockResolvedValue(undefined),
  flush: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
  pendingCount: vi.fn().mockResolvedValue(0),
  getAllWithStatus: vi.fn().mockResolvedValue([]),
  remove: vi.fn().mockResolvedValue(undefined),
  clearAll: vi.fn().mockResolvedValue(undefined),
  cleanupOld: vi.fn().mockResolvedValue(undefined),
}))

// 故障の自動記録 (記録の中身は tests/utils/equipment-failure-report.test.ts)
vi.mock('~/utils/equipment-failure-report', () => ({
  reportApiFailure: vi.fn(),
  reportFailure: vi.fn(),
}))

const envMock = vi.hoisted(() => ({
  isClient: true,
}))
vi.mock('~/utils/env', () => envMock)

import { useOfflineSync } from '~/composables/useOfflineSync'
import { saveMeasurement, updateMeasurement } from '~/utils/api'
import { enqueue, flush, getAllWithStatus, remove, clearAll, cleanupOld } from '~/utils/offline-queue'
import { reportApiFailure, reportFailure } from '~/utils/equipment-failure-report'

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

describe('useOfflineSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true })
  })

  describe('save', () => {
    it('should call saveMeasurement directly when online', async () => {
      vi.mocked(saveMeasurement).mockResolvedValueOnce({
        id: '123',
        tenant_id: 'test',
        employee_id: 'EMP001',
        alcohol_value: 0.0,
        result_type: 'normal',
        device_use_count: 100,
        measured_at: '2026-01-15T08:00:00Z',
        created_at: '2026-01-15T08:00:01Z',
      })

      const { save } = useOfflineSync()
      const status = await save(createResult())

      expect(status).toBe('saved')
      expect(saveMeasurement).toHaveBeenCalledTimes(1)
      // save() now also enqueues locally on success (for local record)
      expect(enqueue).toHaveBeenCalledTimes(1)
    })

    it('should enqueue when API call fails', async () => {
      vi.mocked(saveMeasurement).mockRejectedValueOnce(new Error('network error'))

      const { save } = useOfflineSync()
      const status = await save(createResult())

      expect(status).toBe('queued')
      expect(enqueue).toHaveBeenCalledTimes(1)
      // 通信・サーバーの失敗は故障として記録する
      expect(reportApiFailure).toHaveBeenCalledWith(
        expect.any(Error), '測定結果の送信', { type: 'measurement_recording_failed' },
      )
    })

    it('正常に送れたときは故障を記録しない', async () => {
      vi.mocked(saveMeasurement).mockResolvedValueOnce({} as never)
      const { save } = useOfflineSync()
      await save(createResult())
      expect(reportApiFailure).not.toHaveBeenCalled()
    })
  })

  describe('syncQueue', () => {
    it('should flush pending items', async () => {
      vi.mocked(flush).mockResolvedValueOnce({ sent: 3, failed: 0 })

      const { syncQueue, lastSyncResult } = useOfflineSync()
      await syncQueue()

      expect(flush).toHaveBeenCalledWith(saveMeasurement, updateMeasurement)
      expect(lastSyncResult.value).toEqual({ sent: 3, failed: 0 })
    })

    it('★ 送り直せなかった測定が残ったら database_sync_error で記録する。全部送れたら記録しない', async () => {
      vi.mocked(flush).mockResolvedValueOnce({ sent: 1, failed: 2 })
      const { syncQueue } = useOfflineSync()
      await syncQueue()
      expect(reportFailure).toHaveBeenCalledWith(expect.objectContaining({
        type: 'database_sync_error', device: 'オフラインキュー',
      }))

      vi.mocked(reportFailure).mockClear()
      vi.mocked(flush).mockResolvedValueOnce({ sent: 2, failed: 0 })
      await syncQueue()
      expect(reportFailure).not.toHaveBeenCalled()
    })

    it('should not sync when already syncing', async () => {
      let resolveFlush!: () => void
      vi.mocked(flush).mockReturnValue(
        new Promise(resolve => {
          resolveFlush = () => resolve({ sent: 1, failed: 0 })
        }),
      )

      const { syncQueue } = useOfflineSync()
      const p1 = syncQueue()
      await syncQueue()

      expect(flush).toHaveBeenCalledTimes(1)
      resolveFlush()
      await p1
    })

    it('should not sync when isSyncing is true (guard)', async () => {
      let resolveFlush2!: () => void
      vi.mocked(flush)
        .mockReturnValueOnce(
          new Promise(resolve => {
            resolveFlush2 = () => resolve({ sent: 2, failed: 0 })
          }),
        )

      const { syncQueue, isSyncing } = useOfflineSync()
      const p1 = syncQueue()
      expect(isSyncing.value).toBe(true)

      // Second sync should be blocked
      await syncQueue()
      expect(flush).toHaveBeenCalledTimes(1)

      resolveFlush2()
      await p1
      expect(isSyncing.value).toBe(false)
    })

    it('should not sync when offline', async () => {
      Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true })

      const { syncQueue, isOnline } = useOfflineSync()
      // Force isOnline to false (navigator.onLine is read at construction in import.meta.client block)
      // We need to use withSetup to trigger the import.meta.client block
      const [result, app] = withSetup(() => useOfflineSync())
      // The composable reads navigator.onLine in import.meta.client block
      // but since the direct call doesn't go through onMounted, manually test:
      // For direct call, isOnline defaults to true, so we need the mounted path
      app.unmount()

      // Test via the non-mounted path: create a new instance while offline
      Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true })
      const [offlineResult, offlineApp] = withSetup(() => useOfflineSync())
      // isOnline should be false because navigator.onLine is false
      expect(offlineResult.isOnline.value).toBe(false)
      await offlineResult.syncQueue()
      // flush should not be called because isOnline is false
      expect(flush).not.toHaveBeenCalled()
      offlineApp.unmount()
    })
  })

  describe('save (offline)', () => {
    it('should enqueue when offline without calling API', async () => {
      Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true })
      const [result, app] = withSetup(() => useOfflineSync())

      expect(result.isOnline.value).toBe(false)

      const status = await result.save(createResult(), undefined, 'active-1', 'video-1')

      expect(status).toBe('queued')
      expect(saveMeasurement).not.toHaveBeenCalled()
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ employeeId: 'EMP001' }),
        undefined,
        'active-1',
        undefined,
        'video-1',
      )

      app.unmount()
    })

    it('should pass facePhotoBlob when enqueuing offline', async () => {
      Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true })
      const [result, app] = withSetup(() => useOfflineSync())

      const blob = new Blob(['photo'], { type: 'image/jpeg' })
      await result.save(createResult(), blob)

      expect(enqueue).toHaveBeenCalledWith(
        expect.anything(),
        blob,
        undefined,
        undefined,
        undefined,
      )

      app.unmount()
    })
  })

  describe('removeItem', () => {
    it('should call remove and refreshQueue', async () => {
      const { removeItem } = useOfflineSync()
      await removeItem(42)

      expect(remove).toHaveBeenCalledWith(42)
      expect(getAllWithStatus).toHaveBeenCalled()
    })
  })

  describe('clearQueue', () => {
    it('should call clearAll and refreshQueue', async () => {
      const { clearQueue } = useOfflineSync()
      await clearQueue()

      expect(clearAll).toHaveBeenCalled()
      expect(getAllWithStatus).toHaveBeenCalled()
    })
  })

  describe('refreshQueue', () => {
    it('should update pending count and queueItems from getAllWithStatus', async () => {
      const items = [
        { id: 1, result: createResult(), syncedAt: undefined },
        { id: 2, result: createResult(), syncedAt: '2026-01-15T09:00:00Z' },
        { id: 3, result: createResult(), syncedAt: undefined },
      ]
      vi.mocked(getAllWithStatus).mockResolvedValueOnce(items as any)

      const { refreshQueue, pending, queueItems, allItems } = useOfflineSync()
      await refreshQueue()

      expect(allItems.value).toHaveLength(3)
      expect(queueItems.value).toHaveLength(2) // only unsynced
      expect(pending.value).toBe(2)
    })

    it('should handle getAllWithStatus error gracefully', async () => {
      vi.mocked(getAllWithStatus).mockRejectedValueOnce(new Error('IndexedDB error'))

      const { refreshQueue, pending } = useOfflineSync()
      // Should not throw
      await refreshQueue()
      // pending stays at default (0)
      expect(pending.value).toBe(0)
    })
  })

  describe('getRetentionDays / setRetentionDays', () => {
    it('should return default when nothing stored', () => {
      const { getRetentionDays } = useOfflineSync()
      expect(getRetentionDays()).toBe(730)
    })

    it('should return stored value', () => {
      localStorage.setItem('alc-retention-days', '365')
      const { getRetentionDays } = useOfflineSync()
      expect(getRetentionDays()).toBe(365)
    })

    it('should return default for invalid stored value', () => {
      localStorage.setItem('alc-retention-days', 'not-a-number')
      const { getRetentionDays } = useOfflineSync()
      expect(getRetentionDays()).toBe(730)
    })

    it('should set retention days in localStorage', () => {
      const { setRetentionDays } = useOfflineSync()
      setRetentionDays(180)
      expect(localStorage.getItem('alc-retention-days')).toBe('180')
    })
  })

  describe('SSR (isClient=false)', () => {
    afterEach(() => {
      envMock.isClient = true
    })

    it('getRetentionDays returns default when isClient=false', () => {
      envMock.isClient = false
      const { getRetentionDays } = useOfflineSync()
      expect(getRetentionDays()).toBe(730)
    })

    it('setRetentionDays is no-op when isClient=false', () => {
      envMock.isClient = false
      localStorage.setItem('alc-retention-days', '365')
      const { setRetentionDays } = useOfflineSync()
      setRetentionDays(90)
      // Should not have changed because setRetentionDays is a no-op
      expect(localStorage.getItem('alc-retention-days')).toBe('365')
    })
  })

  describe('onMounted lifecycle (withSetup)', () => {
    it('should add online/offline listeners and call cleanupOld + refreshQueue on mount', async () => {
      const addSpy = vi.spyOn(window, 'addEventListener')
      const removeSpy = vi.spyOn(window, 'removeEventListener')

      const [result, app] = withSetup(() => useOfflineSync())

      // Wait for onMounted async operations
      await vi.waitFor(() => {
        expect(cleanupOld).toHaveBeenCalledWith(730)
      })
      expect(getAllWithStatus).toHaveBeenCalled()

      // Verify event listeners were added
      expect(addSpy).toHaveBeenCalledWith('online', expect.any(Function))
      expect(addSpy).toHaveBeenCalledWith('offline', expect.any(Function))

      // Unmount should remove listeners
      app.unmount()
      expect(removeSpy).toHaveBeenCalledWith('online', expect.any(Function))
      expect(removeSpy).toHaveBeenCalledWith('offline', expect.any(Function))

      addSpy.mockRestore()
      removeSpy.mockRestore()
    })

    it('should handle cleanupOld error in onMounted gracefully', async () => {
      vi.mocked(cleanupOld).mockRejectedValueOnce(new Error('cleanup failed'))

      const [result, app] = withSetup(() => useOfflineSync())

      // Should still call refreshQueue despite cleanupOld failure
      await vi.waitFor(() => {
        expect(getAllWithStatus).toHaveBeenCalled()
      })

      app.unmount()
    })

    it('should sync queue when online event fires', async () => {
      vi.mocked(flush).mockResolvedValue({ sent: 1, failed: 0 })

      const [result, app] = withSetup(() => useOfflineSync())
      await vi.waitFor(() => {
        expect(cleanupOld).toHaveBeenCalled()
      })

      // Simulate going offline then online
      window.dispatchEvent(new Event('offline'))
      expect(result.isOnline.value).toBe(false)

      window.dispatchEvent(new Event('online'))
      expect(result.isOnline.value).toBe(true)

      // syncQueue should be called (flush)
      await vi.waitFor(() => {
        expect(flush).toHaveBeenCalled()
      })

      app.unmount()
    })

    it('should set isOnline to false when offline event fires', async () => {
      const [result, app] = withSetup(() => useOfflineSync())
      await vi.waitFor(() => {
        expect(cleanupOld).toHaveBeenCalled()
      })

      window.dispatchEvent(new Event('offline'))
      expect(result.isOnline.value).toBe(false)

      app.unmount()
    })

    it('should use stored retention days for cleanupOld', async () => {
      localStorage.setItem('alc-retention-days', '90')

      const [result, app] = withSetup(() => useOfflineSync())

      await vi.waitFor(() => {
        expect(cleanupOld).toHaveBeenCalledWith(90)
      })

      app.unmount()
    })
  })
})
