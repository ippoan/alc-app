// 遠隔点呼の通話中に出す拠点カメラ (乗務員の端末が申告した端末 ID に紐づくカメラ)。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import TenkoSiteCameras from '~/components/TenkoSiteCameras.vue'
import { MANAGER_DEVICE_AUTH_FAILED_MESSAGE } from '~/utils/api'

const api = vi.hoisted(() => ({ listCamClipsCamerasForTenko: vi.fn() }))
vi.mock('~/utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  ...api,
}))

const auth = vi.hoisted(() => ({ adminJwt: null as string | null, getManagerJwt: vi.fn() }))
mockNuxtImport('useAuth', () => () => ({ accessToken: ref(auth.adminJwt) }))
mockNuxtImport('useManagerDeviceToken', () => () => ({ getManagerJwt: auth.getManagerJwt }))

const CAMERAS = [
  { id: 'cam-1', name: '正門', device_ids: ['kiosk-1'] },
  { id: 'cam-2', name: '裏門', device_ids: ['kiosk-2'] },
  { id: 'cam-3', name: '車庫', device_ids: ['kiosk-1', 'kiosk-3'] },
]

const stubs = { CamLiveTile: { name: 'CamLiveTile', props: ['roomId', 'label', 'autoConnect', 'getToken'], template: '<div data-testid="tile" :data-room="roomId" :data-auto="autoConnect">{{ label }}</div>' } }
const mount = (deviceId: string) => mountSuspended(TenkoSiteCameras, { props: { deviceId }, global: { stubs } })
const t = (id: string) => `[data-testid="site-cameras-${id}"]`

/** 外から解決できる Promise (取得を待っている途中の状態を作る)。 */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
  auth.adminJwt = null
  auth.getManagerJwt.mockResolvedValue('seat-jwt')
  api.listCamClipsCamerasForTenko.mockResolvedValue({ cameras: CAMERAS })
})

describe('TenkoSiteCameras', () => {
  it('端末 ID を device_ids に含むカメラを全部、roomId = camera.id で自動接続して出す', async () => {
    const w = await mount('kiosk-1')
    await flushPromises()
    const tiles = w.findAll('[data-testid="tile"]')
    expect(tiles.map(x => x.attributes('data-room'))).toEqual(['cam-1', 'cam-3'])
    expect(tiles.map(x => x.text())).toEqual(['正門', '車庫'])
    expect(tiles[0]!.attributes('data-auto')).toBe('true')
    expect(w.find(t('empty')).exists()).toBe(false)
  })

  it('取得中は「読み込み中」', async () => {
    const d = deferred<{ cameras: typeof CAMERAS }>()
    api.listCamClipsCamerasForTenko.mockReturnValueOnce(d.promise)
    const w = await mount('kiosk-1')
    expect(w.find(t('loading')).exists()).toBe(true)
    d.resolve({ cameras: CAMERAS })
    await flushPromises()
    expect(w.find(t('loading')).exists()).toBe(false)
  })

  it('紐づくカメラが 0 台なら「この端末に紐づくカメラはありません」', async () => {
    const w = await mount('kiosk-9')
    await flushPromises()
    expect(w.find(t('empty')).text()).toBe('この端末に紐づくカメラはありません')
    expect(w.findAll('[data-testid="tile"]')).toHaveLength(0)
  })

  it('取得に失敗したら文言を出し、タイルは出さない', async () => {
    api.listCamClipsCamerasForTenko.mockRejectedValueOnce(new Error('boom'))
    const w = await mount('kiosk-1')
    await flushPromises()
    expect(w.find(t('error')).text()).toBeTruthy()
    expect(w.findAll('[data-testid="tile"]')).toHaveLength(0)
  })

  it('端末 ID が変わったら引き直す。古い取得の結果 (成功・失敗とも) は捨てる', async () => {
    const first = deferred<{ cameras: typeof CAMERAS }>()
    const second = deferred<{ cameras: typeof CAMERAS }>()
    api.listCamClipsCamerasForTenko.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const w = await mount('kiosk-1')
    await w.setProps({ deviceId: 'kiosk-2' })
    expect(api.listCamClipsCamerasForTenko).toHaveBeenCalledTimes(2)

    first.resolve({ cameras: CAMERAS })
    await flushPromises()
    expect(w.find(t('loading')).exists()).toBe(true)
    second.resolve({ cameras: CAMERAS })
    await flushPromises()
    expect(w.findAll('[data-testid="tile"]').map(x => x.attributes('data-room'))).toEqual(['cam-2'])

    const third = deferred<{ cameras: typeof CAMERAS }>()
    const fourth = deferred<{ cameras: typeof CAMERAS }>()
    api.listCamClipsCamerasForTenko.mockReturnValueOnce(third.promise).mockReturnValueOnce(fourth.promise)
    await w.setProps({ deviceId: 'kiosk-3' })
    await w.setProps({ deviceId: 'kiosk-1' })
    third.reject(new Error('stale'))
    await flushPromises()
    expect(w.find(t('error')).exists()).toBe(false)
    fourth.resolve({ cameras: CAMERAS })
    await flushPromises()
    expect(w.findAll('[data-testid="tile"]').map(x => x.attributes('data-room'))).toEqual(['cam-1', 'cam-3'])
  })

  describe('cam-room に付けるトークン (カメラ一覧と同じ規則)', () => {
    async function tileGetToken() {
      const w = await mount('kiosk-1')
      await flushPromises()
      return w.findComponent({ name: 'CamLiveTile' }).props('getToken') as () => Promise<string>
    }

    it('管理者ログインが無ければ運行管理者席の鍵', async () => {
      await expect((await tileGetToken())()).resolves.toBe('seat-jwt')
      expect(auth.getManagerJwt).toHaveBeenCalledTimes(1)
    })

    it('管理者ログインがあればその JWT (席の鍵は取らない)', async () => {
      auth.adminJwt = 'admin-jwt'
      await expect((await tileGetToken())()).resolves.toBe('admin-jwt')
      expect(auth.getManagerJwt).not.toHaveBeenCalled()
    })

    it('席の鍵が取れなければ、席の端末を確かめる文言で投げる', async () => {
      auth.getManagerJwt.mockResolvedValue(null)
      await expect((await tileGetToken())()).rejects.toThrow(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)
    })
  })
})
