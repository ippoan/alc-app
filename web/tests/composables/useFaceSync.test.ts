import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock api module
const mockGetFaceData = vi.fn()
const mockUpdateEmployeeFace = vi.fn()
vi.mock('~/utils/api', () => ({
  getFaceData: (...args: any[]) => mockGetFaceData(...args),
  updateEmployeeFace: (...args: any[]) => mockUpdateEmployeeFace(...args),
}))

// Mock face-db module
const mockGetAllDescriptorsWithTimestamp = vi.fn()
const mockBulkSaveFaceDescriptors = vi.fn()
vi.mock('~/utils/face-db', () => ({
  getAllDescriptorsWithTimestamp: (...args: any[]) => mockGetAllDescriptorsWithTimestamp(...args),
  bulkSaveFaceDescriptors: (...args: any[]) => mockBulkSaveFaceDescriptors(...args),
}))

import { withSetup } from '../helpers/with-setup'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

// Mock useAuth (Nuxt auto-import)
const { useAuthMock } = vi.hoisted(() => ({
  useAuthMock: vi.fn(() => ({
    deviceTenantId: { value: 'test-tenant' },
    accessToken: { value: 'test-token' },
  })),
}))
mockNuxtImport('useAuth', () => useAuthMock)

// useFaceSync must be imported AFTER mocks are set up
let useFaceSync: typeof import('~/composables/useFaceSync').useFaceSync

const UUID_1 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const UUID_2 = '11111111-2222-3333-4444-555555555555'

describe('useFaceSync', () => {
  beforeEach(async () => {
    mockGetFaceData.mockReset()
    mockUpdateEmployeeFace.mockReset()
    mockGetAllDescriptorsWithTimestamp.mockReset()
    mockBulkSaveFaceDescriptors.mockReset()
    // **同期の間引きは localStorage に刻まれる。** 消さないと 2 件目以降の
    // test が「さっき同期したばかり」と判断されて何もしない
    localStorage.clear()

    // Re-import to reset globalSyncing module state
    vi.resetModules()
    const mod = await import('~/composables/useFaceSync')
    useFaceSync = mod.useFaceSync
  })

  it('should download when server data is newer than local', async () => {
    mockGetFaceData.mockResolvedValue([
      { id: UUID_1, face_embedding: [0.1, 0.2], face_embedding_at: '2026-03-05T10:00:00Z' },
    ])
    mockGetAllDescriptorsWithTimestamp.mockResolvedValue([
      { employeeId: UUID_1, descriptor: new Float32Array([0.0, 0.0]), updatedAt: new Date('2026-03-04T10:00:00Z').getTime() },
    ])
    mockBulkSaveFaceDescriptors.mockResolvedValue(undefined)

    const { sync } = useFaceSync()
    await sync()

    expect(mockBulkSaveFaceDescriptors).toHaveBeenCalledWith([
      { employeeId: UUID_1, descriptor: [0.1, 0.2], updatedAt: new Date('2026-03-05T10:00:00Z').getTime() },
    ])
    // Should NOT upload since server already has data
    expect(mockUpdateEmployeeFace).not.toHaveBeenCalled()
  })

  it('should not upload when server already has approved data', async () => {
    mockGetFaceData.mockResolvedValue([
      { id: UUID_1, face_embedding: [0.1, 0.2], face_embedding_at: '2026-03-04T10:00:00Z' },
    ])
    // Local has same timestamp → no download, but serverMap.has(empId) → no upload either
    mockGetAllDescriptorsWithTimestamp.mockResolvedValue([
      { employeeId: UUID_1, descriptor: new Float32Array([0.1, 0.2]), updatedAt: new Date('2026-03-04T10:00:00Z').getTime() },
    ])

    const { sync } = useFaceSync()
    await sync()

    expect(mockBulkSaveFaceDescriptors).not.toHaveBeenCalled()
    expect(mockUpdateEmployeeFace).not.toHaveBeenCalled()
  })

  it('should upload when local data exists but server has none', async () => {
    mockGetFaceData.mockResolvedValue([])
    mockGetAllDescriptorsWithTimestamp.mockResolvedValue([
      { employeeId: UUID_1, descriptor: new Float32Array([0.5, 0.6]), updatedAt: Date.now() },
    ])
    mockUpdateEmployeeFace.mockResolvedValue(undefined)

    const { sync } = useFaceSync()
    await sync()

    expect(mockUpdateEmployeeFace).toHaveBeenCalledTimes(1)
    const [id, photo, desc] = mockUpdateEmployeeFace.mock.calls[0]
    expect(id).toBe(UUID_1)
    expect(photo).toBeUndefined()
    expect(desc[0]).toBeCloseTo(0.5)
    expect(desc[1]).toBeCloseTo(0.6)
  })

  it('should download new entry when local has no record', async () => {
    mockGetFaceData.mockResolvedValue([
      { id: UUID_1, face_embedding: [0.1, 0.2], face_embedding_at: '2026-03-05T10:00:00Z', face_model_version: 'v1' },
    ])
    mockGetAllDescriptorsWithTimestamp.mockResolvedValue([])
    mockBulkSaveFaceDescriptors.mockResolvedValue(undefined)

    const { sync } = useFaceSync()
    await sync()

    expect(mockBulkSaveFaceDescriptors).toHaveBeenCalledWith([
      expect.objectContaining({ employeeId: UUID_1, modelVersion: 'v1' }),
    ])
  })

  it('should skip upload for non-UUID employee IDs', async () => {
    mockGetFaceData.mockResolvedValue([])
    mockGetAllDescriptorsWithTimestamp.mockResolvedValue([
      { employeeId: 'not-a-uuid', descriptor: new Float32Array([0.1]), updatedAt: Date.now() },
    ])

    const { sync } = useFaceSync()
    await sync()

    expect(mockUpdateEmployeeFace).not.toHaveBeenCalled()
  })

  it('should prevent concurrent sync calls via globalSyncing guard', async () => {
    // Make getFaceData slow so we can test concurrency
    let resolveFirst: () => void
    const firstCallPromise = new Promise<void>(r => { resolveFirst = r })
    mockGetFaceData
      .mockImplementationOnce(() => firstCallPromise.then(() => []))
      .mockResolvedValueOnce([])
    mockGetAllDescriptorsWithTimestamp.mockResolvedValue([])

    const { sync } = useFaceSync()

    // Start two syncs concurrently
    const p1 = sync()
    const p2 = sync() // Should be blocked by globalSyncing

    // Resolve the first call
    resolveFirst!()
    await Promise.all([p1, p2])

    // getFaceData should only be called once (second sync was blocked)
    expect(mockGetFaceData).toHaveBeenCalledTimes(1)
  })

  it('should handle sync errors gracefully', async () => {
    mockGetFaceData.mockRejectedValue(new Error('network error'))

    const { sync, syncError } = useFaceSync()
    await sync()

    expect(syncError.value).toBe('network error')
  })

  it('should handle non-Error sync errors', async () => {
    mockGetFaceData.mockRejectedValue('unknown')

    const { sync, syncError } = useFaceSync()
    await sync()

    expect(syncError.value).toBe('顔データ同期エラー')
  })

  it('onMounted で認証済みなら sync が呼ばれる', async () => {
    mockGetFaceData.mockResolvedValue([])
    mockGetAllDescriptorsWithTimestamp.mockResolvedValue([])
    useAuthMock.mockReturnValue({
      deviceTenantId: { value: 'tenant-001' },
      accessToken: { value: 'token-001' },
    })

    const [result, app] = withSetup(() => useFaceSync())

    await vi.waitFor(() => {
      expect(mockGetFaceData).toHaveBeenCalled()
    })

    app.unmount()
  })

  it('onMounted で認証未準備なら sync がスキップされる', async () => {
    useAuthMock.mockReturnValue({
      deviceTenantId: { value: null },
      accessToken: { value: null },
    })

    const [result, app] = withSetup(() => useFaceSync())

    // sync は呼ばれないはず
    await new Promise(r => setTimeout(r, 50))
    expect(mockGetFaceData).not.toHaveBeenCalled()

    app.unmount()
  })

  it('should handle upload failure gracefully', async () => {
    mockGetFaceData.mockResolvedValue([])
    mockGetAllDescriptorsWithTimestamp.mockResolvedValue([
      { employeeId: UUID_1, descriptor: new Float32Array([0.5, 0.6]), updatedAt: Date.now() },
    ])
    mockUpdateEmployeeFace.mockRejectedValue(new Error('upload failed'))

    const { sync, syncError } = useFaceSync()
    await sync()

    // upload 失敗は個別 catch されるので syncError にはならない
    expect(syncError.value).toBeNull()
    expect(mockUpdateEmployeeFace).toHaveBeenCalledTimes(1)
  })

  it('should download new entries and upload only entries not on server', async () => {
    // Server has UUID_1, local has UUID_1 (older) + UUID_2 (server doesn't have)
    mockGetFaceData.mockResolvedValue([
      { id: UUID_1, face_embedding: [0.9, 0.8], face_embedding_at: '2026-03-05T10:00:00Z' },
    ])
    mockGetAllDescriptorsWithTimestamp.mockResolvedValue([
      { employeeId: UUID_1, descriptor: new Float32Array([0.1, 0.2]), updatedAt: new Date('2026-03-01T00:00:00Z').getTime() },
      { employeeId: UUID_2, descriptor: new Float32Array([0.3, 0.4]), updatedAt: Date.now() },
    ])
    mockBulkSaveFaceDescriptors.mockResolvedValue(undefined)
    mockUpdateEmployeeFace.mockResolvedValue(undefined)

    const { sync } = useFaceSync()
    await sync()

    // UUID_1 should be downloaded (server is newer)
    expect(mockBulkSaveFaceDescriptors).toHaveBeenCalledWith([
      expect.objectContaining({ employeeId: UUID_1, descriptor: [0.9, 0.8] }),
    ])
    // UUID_2 should be uploaded (not on server)
    expect(mockUpdateEmployeeFace).toHaveBeenCalledTimes(1)
    const [id, photo, desc] = mockUpdateEmployeeFace.mock.calls[0]
    expect(id).toBe(UUID_2)
    expect(photo).toBeUndefined()
    expect(desc[0]).toBeCloseTo(0.3)
    expect(desc[1]).toBeCloseTo(0.4)
  })

  // -------------------------------------------------------------------------
  // 全件ダウンロードの間引き (Refs ippoan/rust-alc-api#644)
  //
  // getFaceData() は承認済み**全社員ぶん**の embedding を返す。カードをかざす
  // たびに待っていたため、読み取りから choice まで実測 1.5〜6.2 秒かかっていた。
  // -------------------------------------------------------------------------

  it('★ 直前に同期していれば何も取りに行かない (全件ダウンロードの間引き)', async () => {
    mockGetFaceData.mockResolvedValue([])
    mockGetAllDescriptorsWithTimestamp.mockResolvedValue([])

    const { sync } = useFaceSync()
    await sync()
    expect(mockGetFaceData).toHaveBeenCalledTimes(1)

    // 2 回目は間引かれる
    await sync()
    await sync()
    expect(mockGetFaceData).toHaveBeenCalledTimes(1)
  })

  it('★ force を付けた呼び出しは間引かれない (管理者の入口はここを使う)', async () => {
    mockGetFaceData.mockResolvedValue([])
    mockGetAllDescriptorsWithTimestamp.mockResolvedValue([])

    const { sync } = useFaceSync()
    await sync()
    await sync({ force: true })

    expect(mockGetFaceData).toHaveBeenCalledTimes(2)
  })

  it('★ 間引きはリロードを跨ぐ (localStorage に刻む)', async () => {
    mockGetFaceData.mockResolvedValue([])
    mockGetAllDescriptorsWithTimestamp.mockResolvedValue([])

    const first = useFaceSync()
    await first.sync()
    expect(mockGetFaceData).toHaveBeenCalledTimes(1)

    // module 状態を捨てる = リロード相当。localStorage は残る
    vi.resetModules()
    const mod = await import('~/composables/useFaceSync')
    await mod.useFaceSync().sync()

    expect(mockGetFaceData).toHaveBeenCalledTimes(1)
  })

  it('★ 間引く間隔を過ぎれば取りに行く', async () => {
    mockGetFaceData.mockResolvedValue([])
    mockGetAllDescriptorsWithTimestamp.mockResolvedValue([])

    const { sync } = useFaceSync()
    await sync()
    expect(mockGetFaceData).toHaveBeenCalledTimes(1)

    // 6 分前に同期したことにする (下限は 5 分)
    localStorage.setItem('alc.faceSync.lastSyncAt', String(Date.now() - 6 * 60 * 1000))
    await sync()

    expect(mockGetFaceData).toHaveBeenCalledTimes(2)
  })

  it('★ 失敗した同期は刻まない (次の呼び出しでやり直せる)', async () => {
    mockGetFaceData.mockRejectedValueOnce(new Error('offline'))
    const { sync, syncError } = useFaceSync()
    await sync()
    expect(syncError.value).toBe('offline')

    // 失敗を刻んでいたらここが間引かれて 1 回のままになる
    mockGetFaceData.mockResolvedValue([])
    mockGetAllDescriptorsWithTimestamp.mockResolvedValue([])
    await sync()

    expect(mockGetFaceData).toHaveBeenCalledTimes(2)
  })

  it('刻まれた値が数値でなければ「未同期」に倒す (取りに行く側 = 安全側)', async () => {
    localStorage.setItem('alc.faceSync.lastSyncAt', 'broken')
    mockGetFaceData.mockResolvedValue([])
    mockGetAllDescriptorsWithTimestamp.mockResolvedValue([])

    await useFaceSync().sync()

    expect(mockGetFaceData).toHaveBeenCalledTimes(1)
  })

  it('localStorage が読めない環境でも同期できる (private window 等)', async () => {
    const getItem = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    mockGetFaceData.mockResolvedValue([])
    mockGetAllDescriptorsWithTimestamp.mockResolvedValue([])

    await useFaceSync().sync()

    expect(mockGetFaceData).toHaveBeenCalledTimes(1)
    getItem.mockRestore()
  })

  it('localStorage が書けない環境でも同期は成立する (握り潰す)', async () => {
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    mockGetFaceData.mockResolvedValue([])
    mockGetAllDescriptorsWithTimestamp.mockResolvedValue([])

    const { sync, syncError } = useFaceSync()
    await sync()

    expect(mockGetFaceData).toHaveBeenCalledTimes(1)
    expect(syncError.value).toBeNull()
    setItem.mockRestore()
  })
})
