// 拠点カメラ 1 台ぶんのライブ表示タイルと、全カメラのグリッド (カメラ一覧タブ)。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import CamLiveTile from '~/components/CamLiveTile.vue'
import CamLiveGrid from '~/components/CamLiveGrid.vue'
import TenkoCameraView from '~/components/TenkoCameraView.vue'

const api = vi.hoisted(() => ({ listCamClipsCameras: vi.fn() }))
vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  ...api,
}))

const rtc = vi.hoisted(() => ({ instances: [] as Array<Record<string, any>> }))
const tokenRef = vi.hoisted(() => ({ v: 'jwt' as string | null }))
mockNuxtImport('useAuth', () => () => ({ accessToken: ref(tokenRef.v) }))
mockNuxtImport('useWebRtc', () => () => {
  const inst = {
    isConnected: ref(false),
    isPeerConnected: ref(false),
    remoteStream: ref<unknown>(null),
    error: ref<string | null>(null),
    connect: vi.fn(async () => { inst.isConnected.value = true }),
    disconnect: vi.fn(),
  }
  rtc.instances.push(inst)
  return inst
})

const t = (id: string) => `[data-testid="cam-tile-${id}"]`

beforeEach(() => {
  vi.clearAllMocks()
  rtc.instances.length = 0
  tokenRef.v = 'jwt'
  api.listCamClipsCameras.mockResolvedValue({
    can_edit_destination: false,
    cameras: [{ id: 'cam-1', name: '正門' }, { id: 'cam-2', name: '裏門' }],
  })
})

describe('CamLiveTile', () => {
  it('autoConnect で cam-room に roomId で繋ぎ、切るボタンで切れる', async () => {
    const w = await mountSuspended(CamLiveTile, { props: { roomId: 'cam-1', label: '正門', autoConnect: true } })
    await flushPromises()
    expect(rtc.instances[0]!.connect).toHaveBeenCalledWith(expect.any(String), 'cam-1', 'cam-room', 'jwt')
    expect(w.find(t('label')).text()).toBe('正門')
    expect(w.find(t('status')).text()).toBe('カメラ接続待ち...')
    rtc.instances[0]!.isPeerConnected.value = true
    await nextTick()
    expect(w.find(t('status')).text()).toBe('受信中')
    await w.find(t('disconnect')).trigger('click')
    expect(rtc.instances[0]!.disconnect).toHaveBeenCalled()
    expect(w.find(t('status')).text()).toBe('停止中')
    expect(w.emitted('update:active')).toEqual([[true], [false]])
  })

  it('label が無ければ roomId を出し、接続ボタンで繋ぐ', async () => {
    const w = await mountSuspended(CamLiveTile, { props: { roomId: 'cam-9' } })
    expect(w.find(t('label')).text()).toBe('cam-9')
    expect(rtc.instances[0]!.connect).not.toHaveBeenCalled()
    await w.find(t('connect')).trigger('click')
    await flushPromises()
    expect(rtc.instances[0]!.connect).toHaveBeenCalledTimes(1)
  })

  it('繋ぐ途中に失敗したら文言を出す', async () => {
    const w = await mountSuspended(CamLiveTile, { props: { roomId: 'cam-1' } })
    rtc.instances[0]!.connect.mockRejectedValueOnce(new Error('x'))
    await w.find(t('connect')).trigger('click')
    await flushPromises()
    expect(w.find(t('error')).text()).toBe('接続に失敗しました')
    expect(w.find(t('connect')).exists()).toBe(true)
  })

  it('signaling に弾かれたら (409 等) 分かる文言を出して枠を畳む', async () => {
    const w = await mountSuspended(CamLiveTile, { props: { roomId: 'cam-1', autoConnect: true } })
    await flushPromises()
    rtc.instances[0]!.isConnected.value = false
    rtc.instances[0]!.error.value = 'シグナリングサーバー接続エラー'
    await flushPromises()
    expect(w.find(t('error')).text()).toContain('他の人が視聴中')
    expect(w.find(t('connect')).exists()).toBe(true)
    // 繋がった後の別のエラーは、そのまま出して枠は畳まない
    await w.find(t('connect')).trigger('click')
    await flushPromises()
    rtc.instances[0]!.error.value = 'P2P 接続が切断されました'
    await flushPromises()
    expect(w.find(t('error')).text()).toBe('P2P 接続が切断されました')
    expect(w.find(t('disconnect')).exists()).toBe(true)
  })

  it('トークンが無ければ繋がずに文言を出す', async () => {
    tokenRef.v = null
    const w = await mountSuspended(CamLiveTile, { props: { roomId: 'cam-1' } })
    await w.find(t('connect')).trigger('click')
    expect(rtc.instances[0]!.connect).not.toHaveBeenCalled()
    expect(w.find(t('error')).text()).toContain('再ログイン')
  })

  it('映像が届いたら video に付け、全画面を切り替え、unmount で切る', async () => {
    const w = await mountSuspended(CamLiveTile, { props: { roomId: 'cam-1', autoConnect: true }, attachTo: document.body })
    await flushPromises()
    const stream = new MediaStream()
    rtc.instances[0]!.remoteStream.value = stream
    await flushPromises()
    expect((w.find('video').element as HTMLVideoElement).srcObject).toBe(stream)
    const container = w.find('.group').element as HTMLElement
    container.requestFullscreen = vi.fn()
    document.exitFullscreen = vi.fn() as any
    await w.find(t('fullscreen')).trigger('click')
    expect(container.requestFullscreen).toHaveBeenCalled()
    Object.defineProperty(document, 'fullscreenElement', { value: container, configurable: true })
    document.dispatchEvent(new Event('fullscreenchange'))
    await nextTick()
    expect(w.find(t('fullscreen')).attributes('title')).toBe('全画面解除')
    await w.find(t('fullscreen')).trigger('click')
    expect(document.exitFullscreen).toHaveBeenCalled()
    Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true })
    document.dispatchEvent(new Event('fullscreenchange'))
    w.unmount()
    expect(rtc.instances[0]!.disconnect).toHaveBeenCalled()
  })

  it('autoConnect が false に戻ると切る', async () => {
    const w = await mountSuspended(CamLiveTile, { props: { roomId: 'cam-1', autoConnect: true } })
    await flushPromises()
    await w.setProps({ autoConnect: false })
    expect(rtc.instances[0]!.disconnect).toHaveBeenCalled()
    await w.setProps({ autoConnect: true })
    await flushPromises()
    expect(rtc.instances[0]!.connect).toHaveBeenCalledTimes(2)
  })
})

describe('CamLiveGrid', () => {
  it('カメラ全部をタイルにして、それぞれ camera.id で繋ぐ。外れたら全部切る', async () => {
    const w = await mountSuspended(CamLiveGrid)
    await flushPromises()
    expect(w.findAll(t('label')).map(l => l.text())).toEqual(['正門', '裏門'])
    expect(rtc.instances.map(i => i.connect.mock.calls[0][1])).toEqual(['cam-1', 'cam-2'])
    w.unmount()
    expect(rtc.instances.every(i => i.disconnect.mock.calls.length > 0)).toBe(true)
  })
  it('0 件・失敗の文言', async () => {
    api.listCamClipsCameras.mockResolvedValueOnce({ can_edit_destination: false, cameras: [] })
    let w = await mountSuspended(CamLiveGrid)
    await flushPromises()
    expect(w.find('[data-testid="cam-grid-empty"]').exists()).toBe(true)
    api.listCamClipsCameras.mockRejectedValueOnce(new Error('boom'))
    w = await mountSuspended(CamLiveGrid)
    await flushPromises()
    expect(w.find('[data-testid="cam-grid-error"]').exists()).toBe(true)
  })
})

describe('TenkoCameraView', () => {
  it('site_id を入れて接続するとタイルが出て、視聴終了で消える', async () => {
    localStorage.removeItem('alc_camera_site_id')
    const w = await mountSuspended(TenkoCameraView)
    await w.find('input').setValue('  site-1 ')
    await w.find('input').trigger('keyup.enter')
    await flushPromises()
    expect(rtc.instances[0]!.connect).toHaveBeenCalledWith(expect.any(String), 'site-1', 'cam-room', 'jwt')
    expect(localStorage.getItem('alc_camera_site_id')).toBe('site-1')
    await w.find('button.bg-red-100').trigger('click')
    expect(w.find(t('label')).exists()).toBe(false)
    // 保存済みの値が次回の初期値になる。空では何も起きない
    const w2 = await mountSuspended(TenkoCameraView)
    expect((w2.find('input').element as HTMLInputElement).value).toBe('site-1')
    await w2.find('input').setValue('')
    await w2.find('input').trigger('keyup.enter')
    expect(w2.find(t('label')).exists()).toBe(false)
  })
})
