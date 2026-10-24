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
    ptzChannel: ref<unknown>(null),
    camAudioSender: ref<unknown>(null),
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

  it('getToken を渡されたら、管理者ログインの JWT ではなくその戻り値で繋ぐ (繋ぐたびに呼ぶ)', async () => {
    tokenRef.v = null
    const getToken = vi.fn(async () => 'seat-jwt')
    const w = await mountSuspended(CamLiveTile, { props: { roomId: 'cam-1', autoConnect: true, getToken } })
    await flushPromises()
    expect(rtc.instances[0]!.connect).toHaveBeenCalledWith(expect.any(String), 'cam-1', 'cam-room', 'seat-jwt')
    await w.find(t('disconnect')).trigger('click')
    await w.find(t('connect')).trigger('click')
    await flushPromises()
    expect(getToken).toHaveBeenCalledTimes(2)
  })

  it('getToken が投げたら繋がずにその文言を出す (Error でなければ汎用の文言)', async () => {
    const getToken = vi.fn().mockRejectedValueOnce(new Error('席の鍵が取れません')).mockRejectedValueOnce('x')
    const w = await mountSuspended(CamLiveTile, { props: { roomId: 'cam-1', getToken } })
    await w.find(t('connect')).trigger('click')
    await flushPromises()
    expect(w.find(t('error')).text()).toBe('席の鍵が取れません')
    expect(w.find(t('connect')).attributes('disabled')).toBeUndefined()
    await w.find(t('connect')).trigger('click')
    await flushPromises()
    expect(w.find(t('error')).text()).toBe('接続に必要な認証情報を取得できませんでした')
    expect(rtc.instances[0]!.connect).not.toHaveBeenCalled()
  })

  it('getToken が null を返したら繋がずに文言を出す', async () => {
    const w = await mountSuspended(CamLiveTile, { props: { roomId: 'cam-1', getToken: async () => null } })
    await w.find(t('connect')).trigger('click')
    await flushPromises()
    expect(rtc.instances[0]!.connect).not.toHaveBeenCalled()
    expect(w.find(t('error')).exists()).toBe(true)
    expect(w.find(t('connect')).attributes('disabled')).toBeUndefined()
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

describe('CamLiveTile の首振り (データチャネル ptz)', () => {
  class FakeChannel {
    readyState = 'open'
    send = vi.fn()
    listeners: Record<string, Array<(ev: any) => void>> = {}
    addEventListener(type: string, fn: (ev: any) => void) { (this.listeners[type] ??= []).push(fn) }
    removeEventListener(type: string, fn: (ev: any) => void) { this.listeners[type] = (this.listeners[type] ?? []).filter(f => f !== fn) }
    emit(data: unknown) { for (const fn of this.listeners.message ?? []) fn({ data: JSON.stringify(data) }) }
    sent() { return this.send.mock.calls.map(c => JSON.parse(c[0])) }
  }
  const CAPS = { type: 'ptz', event: 'caps', dirs: ['up', 'down', 'left', 'right'], home: true, presets: [1, 2], zoom: false }

  async function mountWithStream() {
    const w = await mountSuspended(CamLiveTile, { props: { roomId: 'cam-1', autoConnect: true } })
    await flushPromises()
    const inst = rtc.instances[0]!
    inst.remoteStream.value = new MediaStream()
    const ch = new FakeChannel()
    inst.ptzChannel.value = ch
    await nextTick()
    return { w, ch }
  }

  it('古い host (チャネルが来ない・caps が来ない) ではボタンを出さない', async () => {
    const w = await mountSuspended(CamLiveTile, { props: { roomId: 'cam-1', autoConnect: true } })
    await flushPromises()
    rtc.instances[0]!.remoteStream.value = new MediaStream()
    await nextTick()
    expect(w.find(t('ptz')).exists()).toBe(false)
    rtc.instances[0]!.ptzChannel.value = new FakeChannel()
    await nextTick()
    expect(w.find(t('ptz')).exists()).toBe(false)
  })

  it('caps が来たら方向・ホーム・プリセットを出し、押している間 move・離したら stop', async () => {
    const { w, ch } = await mountWithStream()
    ch.emit(CAPS)
    await nextTick()
    expect(w.find(t('ptz')).exists()).toBe(true)
    for (const id of ['up', 'down', 'left', 'right', 'home', 'preset-1', 'preset-2']) expect(w.find(t(`ptz-${id}`)).exists()).toBe(true)
    expect(w.find(t('ptz-zoom-in')).exists()).toBe(false)

    const left = w.find(t('ptz-left'))
    const capture = vi.fn()
    ;(left.element as any).setPointerCapture = capture
    await left.trigger('pointerdown', { pointerId: 7 })
    expect(capture).toHaveBeenCalledWith(7)
    expect(left.classes()).toContain('bg-blue-600/80')
    await left.trigger('pointerup')
    // setPointerCapture が無いブラウザでも動く
    await w.find(t('ptz-up')).trigger('pointerdown')
    await w.find(t('ptz-up')).trigger('pointercancel')
    await w.find(t('ptz-down')).trigger('pointerdown')
    await w.find(t('ptz-down')).trigger('lostpointercapture')
    await w.find(t('ptz-home')).trigger('pointerdown')
    await w.find(t('ptz-preset-2')).trigger('click')
    expect(ch.sent()).toEqual([
      { type: 'ptz', action: 'move', dir: 'left' },
      { type: 'ptz', action: 'stop' },
      { type: 'ptz', action: 'move', dir: 'up' },
      { type: 'ptz', action: 'stop' },
      { type: 'ptz', action: 'move', dir: 'down' },
      { type: 'ptz', action: 'stop' },
      { type: 'ptz', action: 'home' },
      { type: 'ptz', action: 'preset', preset: 2 },
    ])
  })

  it('caps に無いものは出さない。zoom があれば出す。失敗の文言を出す', async () => {
    const { w, ch } = await mountWithStream()
    ch.emit({ ...CAPS, dirs: ['left', 'right'], home: false, presets: [], zoom: true })
    await nextTick()
    expect(w.find(t('ptz-up')).exists()).toBe(false)
    expect(w.find(t('ptz-home')).exists()).toBe(false)
    expect(w.find(t('ptz-left')).exists()).toBe(true)
    expect(w.find(t('ptz-preset-1')).exists()).toBe(false)
    expect(w.find(t('ptz-zoom-in')).attributes('title')).toBe('ズームイン')
    expect(w.find(t('ptz-zoom-out')).attributes('title')).toBe('ズームアウト')
    await w.find(t('ptz-zoom-in')).trigger('click')
    await w.find(t('ptz-zoom-out')).trigger('click')
    expect(ch.sent()).toEqual([{ type: 'ptz', action: 'zoom', dir: 'in' }, { type: 'ptz', action: 'zoom', dir: 'out' }])
    expect(w.find(t('ptz-message')).exists()).toBe(false)
    ch.emit({ type: 'ptz', event: 'result', action: 'move', ok: false, message: 'カメラの認証に失敗しました' })
    await nextTick()
    expect(w.find(t('ptz-message')).text()).toBe('カメラの認証に失敗しました')
  })
})

describe('CamLiveTile の音声 (カメラのマイクとスピーカー)', () => {
  class FakeChannel {
    readyState = 'open'
    send = vi.fn()
    listeners: Record<string, Array<(ev: any) => void>> = {}
    addEventListener(type: string, fn: (ev: any) => void) { (this.listeners[type] ??= []).push(fn) }
    removeEventListener(type: string, fn: (ev: any) => void) { this.listeners[type] = (this.listeners[type] ?? []).filter(f => f !== fn) }
    emit(data: unknown) { for (const fn of this.listeners.message ?? []) fn({ data: JSON.stringify(data) }) }
    sent() { return this.send.mock.calls.map(c => JSON.parse(c[0])) }
  }
  const gum = vi.fn()
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: gum } })

  async function mountWithAudio(sender: unknown = { replaceTrack: vi.fn().mockResolvedValue(undefined) }) {
    const w = await mountSuspended(CamLiveTile, { props: { roomId: 'cam-1', autoConnect: true } })
    await flushPromises()
    const inst = rtc.instances[0]!
    inst.remoteStream.value = new MediaStream()
    inst.camAudioSender.value = sender
    const ch = new FakeChannel()
    inst.ptzChannel.value = ch
    await nextTick()
    return { w, ch }
  }

  it('音声の無い host ではどちらのボタンも出さない', async () => {
    const { w, ch } = await mountWithAudio(null)
    ch.emit({ type: 'talk', event: 'caps', speak: true })
    await nextTick()
    expect(w.find(t('sound')).exists()).toBe(false)
    expect(w.find(t('talk')).exists()).toBe(false)
  })

  it('カメラの音は既定でミュート、ボタンで鳴らす・消す', async () => {
    const { w } = await mountWithAudio()
    const video = () => w.find('video').element as HTMLVideoElement
    expect(video().muted).toBe(true)
    expect(w.find(t('sound')).text()).toContain('音なし')
    expect(w.find(t('talk')).exists()).toBe(false) // caps が来るまで出さない
    await w.find(t('sound')).trigger('click')
    expect(video().muted).toBe(false)
    expect(w.find(t('sound')).attributes('aria-pressed')).toBe('true')
    expect(w.find(t('sound')).text()).toContain('音あり')
    await w.find(t('sound')).trigger('click')
    expect(video().muted).toBe(true)
  })

  it('音ありの間だけ音量のスライダーを出し、video の音量に効かせてこのブラウザに覚える', async () => {
    localStorage.removeItem('alc_cam_volume')
    const { w } = await mountWithAudio()
    const video = () => w.find('video').element as HTMLVideoElement
    expect(video().volume).toBe(1) // 既定 100%
    expect(w.find(t('volume')).exists()).toBe(false)
    await w.find(t('sound')).trigger('click')
    const slider = w.find(t('volume'))
    expect((slider.element as HTMLInputElement).value).toBe('100')
    await slider.setValue('40')
    expect(video().volume).toBeCloseTo(0.4)
    expect(slider.attributes('title')).toBe('音量 40%')
    expect(localStorage.getItem('alc_cam_volume')).toBe('40')
    w.unmount()

    // 次に開いたタイルは覚えた音量。範囲外・読めない値は丸める / 既定に戻す
    rtc.instances.length = 0
    const again = await mountWithAudio()
    expect((again.w.find('video').element as HTMLVideoElement).volume).toBeCloseTo(0.4)
    again.w.unmount()
    for (const [saved, want] of [['250', 1], ['abc', 1], ['-5', 0]] as const) {
      localStorage.setItem('alc_cam_volume', saved)
      rtc.instances.length = 0
      const m = await mountWithAudio()
      expect((m.w.find('video').element as HTMLVideoElement).volume).toBeCloseTo(want)
      m.w.unmount()
    }
    localStorage.removeItem('alc_cam_volume')
  })

  it('localStorage が使えなくても音量は既定 100% で、変えれば効く', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    const { w } = await mountWithAudio()
    const video = w.find('video').element as HTMLVideoElement
    expect(video.volume).toBe(1)
    await w.find(t('sound')).trigger('click')
    await w.find(t('volume')).setValue('20')
    expect(video.volume).toBeCloseTo(0.2)
    get.mockRestore()
    set.mockRestore()
  })

  it('押して話す: 押している間だけ start、離したら stop。話している・他の人・失敗の表示', async () => {
    const { w, ch } = await mountWithAudio()
    ch.emit({ type: 'talk', event: 'caps', speak: true })
    await nextTick()
    const btn = () => w.find(t('talk'))
    expect(btn().text()).toContain('押して話す')
    const track = { stop: vi.fn() }
    gum.mockResolvedValue({ getTracks: () => [track], getAudioTracks: () => [track] })
    await btn().trigger('pointerdown')
    expect(btn().text()).toContain('接続中...')
    await flushPromises()
    ch.emit({ type: 'talk', event: 'state', talking: true, mine: true })
    await nextTick()
    expect(btn().text()).toContain('話しています')
    await btn().trigger('pointerup')
    expect(ch.sent()).toEqual([{ type: 'talk', action: 'start' }, { type: 'talk', action: 'stop' }])

    ch.emit({ type: 'talk', event: 'state', talking: true, mine: false })
    await nextTick()
    expect(w.find(t('talk-others')).text()).toBe('他の人が話しています')
    ch.emit({ type: 'talk', event: 'result', ok: false, message: '他の人がカメラで通話中です' })
    await nextTick()
    expect(w.find(t('talk-message')).text()).toBe('他の人がカメラで通話中です')
    for (const ev of ['pointercancel', 'lostpointercapture']) {
      await btn().trigger('pointerdown')
      await flushPromises()
      await btn().trigger(ev)
    }
    expect(ch.sent().filter(m => m.action === 'stop')).toHaveLength(3)
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
