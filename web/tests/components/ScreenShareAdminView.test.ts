import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import ScreenShareAdminView from '~/components/ScreenShareAdminView.vue'

// 画面共有を見る部品 (Refs ippoan/alc-app#387)。運行管理者タブと IT点呼 の受け画面が置く。
// - 視聴を始めた時点で、その部屋だけを着信から外す (markHandled)。setJoined は使わない
// - 「視聴をやめる」= 自分が抜けるだけ / 「画面共有を終了」= 共有している側を止めさせる

// --- composable のモック ---

const activeRoomsRef = ref<string[]>([])
const startWatchingMock = vi.fn()
const stopWatchingMock = vi.fn()
const setJoinedMock = vi.fn()
const markHandledMock = vi.fn()
const reloadRoomsMock = vi.fn(async () => true)
mockNuxtImport('useActiveRooms', () => () => ({
  activeRooms: activeRoomsRef,
  start: startWatchingMock,
  stop: stopWatchingMock,
  setJoined: setJoinedMock,
  markHandled: markHandledMock,
  reload: reloadRoomsMock,
}))

const connectMock = vi.fn(async (..._args: unknown[]) => {})
const startStreamingMock = vi.fn(async (..._args: unknown[]) => {})
const disconnectMock = vi.fn()
const sendEndShareMock = vi.fn()
const remoteStreamRef = ref<unknown>(null)
const webRtcRoles: string[] = []
mockNuxtImport('useWebRtc', () => (role: string) => {
  webRtcRoles.push(role)
  return {
    isConnected: ref(false),
    isPeerConnected: ref(false),
    remoteStream: remoteStreamRef,
    error: ref(null),
    connect: connectMock,
    startStreaming: startStreamingMock,
    sendEndShare: sendEndShareMock,
    disconnect: disconnectMock,
  }
})

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

type Wrapper = Awaited<ReturnType<typeof mountView>>

async function mountView(props: { 'disabled'?: boolean, 'onUpdate:viewing'?: (viewing: boolean) => void } = {}) {
  const wrapper = await mountSuspended(ScreenShareAdminView, { props })
  await flush()
  await wrapper.vm.$nextTick()
  return wrapper
}

const rooms = (w: Wrapper) => w.findAll('[data-testid="screen-room"]')
const stopButton = (w: Wrapper) => w.find('[data-testid="screen-stop-viewing"]')
const endButton = (w: Wrapper) => w.find('[data-testid="screen-end-share"]')
const endError = (w: Wrapper) => w.find('[data-testid="screen-end-error"]')
const viewingEvents = (w: Wrapper) => (w.emitted('update:viewing') ?? []).map(e => e[0])

async function click(el: { trigger: (e: string) => Promise<unknown> }, w: Wrapper) {
  await el.trigger('click')
  await flush()
  await w.vm.$nextTick()
}

function makeMic() {
  const track = { kind: 'audio', enabled: true, stop: vi.fn() }
  return { track, stream: { getTracks: () => [track], getAudioTracks: () => [track] } }
}

beforeEach(() => {
  vi.clearAllMocks()
  webRtcRoles.length = 0
  activeRoomsRef.value = []
  remoteStreamRef.value = null
  connectMock.mockImplementation(async () => {})
  reloadRoomsMock.mockImplementation(async () => true)
  // 既定: マイクは断られたことにする (視聴だけで続ける経路)
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn(async () => { throw new Error('denied') }) },
    configurable: true,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ScreenShareAdminView — 一覧', () => {
  it('一覧には screen- で始まる部屋だけが出る (admin の役で繋ぐ)', async () => {
    activeRoomsRef.value = ['session-9', 'screen-a', 'it-session-1', 'screen-b']
    const w = await mountView()

    expect(webRtcRoles).toEqual(['admin'])
    expect(rooms(w)).toHaveLength(2)
    expect(w.text()).toContain('(2件)')
    expect(w.text()).toContain('screen-a')
    expect(w.text()).toContain('screen-b')
    expect(w.text()).not.toContain('session-9')
    expect(w.text()).not.toContain('it-session-1')
    w.unmount()
  })

  it('部屋が無ければその旨を出す。取得に失敗したらエラー文', async () => {
    reloadRoomsMock.mockImplementation(async () => false)
    const w = await mountView()

    expect(w.text()).toContain('画面共有中の運行者はいません')
    expect(w.text()).toContain('画面共有一覧の取得に失敗しました')

    reloadRoomsMock.mockImplementation(async () => true)
    await click(w.findAll('button').find(b => b.text() === '更新')!, w)
    expect(w.text()).not.toContain('画面共有一覧の取得に失敗しました')
    w.unmount()
  })

  it('部屋の監視は mount で 1 回始め、unmount で 1 回だけ止める', async () => {
    const w = await mountView()
    expect(startWatchingMock).toHaveBeenCalledTimes(1)
    w.unmount()
    expect(stopWatchingMock).toHaveBeenCalledTimes(1)
  })
})

describe('ScreenShareAdminView — 視聴', () => {
  it('★ 見始めると、その部屋だけを markHandled に入れる (1 回)。setJoined は呼ばない', async () => {
    activeRoomsRef.value = ['screen-a', 'screen-b', 'it-session-1']
    const w = await mountView()

    await click(rooms(w)[1]!, w)

    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(connectMock.mock.calls[0]![1]).toBe('screen-b')
    expect(markHandledMock).toHaveBeenCalledTimes(1)
    expect(markHandledMock).toHaveBeenCalledWith('screen-b')
    expect(setJoinedMock).not.toHaveBeenCalled()
    expect(viewingEvents(w)).toEqual([true])
    expect(stopButton(w).text()).toBe('視聴をやめる')
    expect(endButton(w).text()).toBe('画面共有を終了')

    w.unmount()
    expect(setJoinedMock).not.toHaveBeenCalled()
  })

  it('マイクが取れたら声を送り、ミュートを切り替えられる', async () => {
    const mic = makeMic()
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn(async () => mic.stream) },
      configurable: true,
    })
    activeRoomsRef.value = ['screen-a']
    const w = await mountView()
    await click(rooms(w)[0]!, w)

    expect(startStreamingMock).toHaveBeenCalledWith(mic.stream)
    const mute = w.findAll('button').find(b => b.text() === 'マイクON')!
    await click(mute, w)
    expect(mic.track.enabled).toBe(false)
    expect(w.text()).toContain('ミュート中')

    await click(stopButton(w), w)
    expect(mic.track.stop).toHaveBeenCalled()
    w.unmount()
  })

  it('マイクが無いときのミュートは何もしない', async () => {
    activeRoomsRef.value = ['screen-a']
    const w = await mountView()
    await click(rooms(w)[0]!, w)

    const mute = w.findAll('button').find(b => b.text() === 'マイク未接続')!
    expect(mute.attributes('disabled')).toBeDefined()
    // disabled を越えて呼ばれても変わらない
    ;(mute.element as HTMLButtonElement).disabled = false
    await click(mute, w)
    expect(w.text()).toContain('マイク未接続')
    w.unmount()
  })

  it('接続に失敗したらエラー文を出し、印も付けず、視聴中にもならない', async () => {
    const mic = makeMic()
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn(async () => mic.stream) },
      configurable: true,
    })
    connectMock.mockImplementation(async () => { throw new Error('ws failed') })
    activeRoomsRef.value = ['screen-a']
    const w = await mountView()

    await click(rooms(w)[0]!, w)

    expect(w.text()).toContain('接続に失敗しました')
    expect(mic.track.stop).toHaveBeenCalled()
    expect(markHandledMock).not.toHaveBeenCalled()
    expect(viewingEvents(w)).toEqual([])
    expect(stopButton(w).exists()).toBe(false)
    w.unmount()
  })

  it('見ている最中に別の部屋を押すと、前の視聴を閉じてから切り替える', async () => {
    activeRoomsRef.value = ['screen-a', 'screen-b']
    const w = await mountView()
    await click(rooms(w)[0]!, w)
    disconnectMock.mockClear()

    await click(rooms(w)[1]!, w)

    expect(disconnectMock).toHaveBeenCalled()
    expect(connectMock.mock.calls.map(c => c[1])).toEqual(['screen-a', 'screen-b'])
    expect(markHandledMock.mock.calls.map(c => c[0])).toEqual(['screen-a', 'screen-b'])
    expect(viewingEvents(w)).toEqual([true, false, true])
    w.unmount()
  })

  it('届いた映像を video に流す', async () => {
    activeRoomsRef.value = ['screen-a']
    const w = await mountView()

    // 見ていないあいだ (video が無い) は何もしない
    remoteStreamRef.value = new MediaStream()
    await w.vm.$nextTick()

    await click(rooms(w)[0]!, w)
    const stream = new MediaStream()
    remoteStreamRef.value = stream
    await w.vm.$nextTick()

    expect((w.find('video').element as HTMLVideoElement).srcObject).toBe(stream)
    w.unmount()
  })
})

describe('ScreenShareAdminView — 視聴をやめる / 画面共有を終了', () => {
  it('「視聴をやめる」は自分が抜けるだけ (終了の合図は送らない)。一覧には残り、もう一度見られる', async () => {
    activeRoomsRef.value = ['screen-a']
    const w = await mountView()
    await click(rooms(w)[0]!, w)
    disconnectMock.mockClear()

    await click(stopButton(w), w)

    expect(disconnectMock).toHaveBeenCalled()
    expect(sendEndShareMock).not.toHaveBeenCalled()
    expect(viewingEvents(w)).toEqual([true, false])
    expect(stopButton(w).exists()).toBe(false)
    expect(rooms(w)).toHaveLength(1)

    await click(rooms(w)[0]!, w)
    expect(viewingEvents(w)).toEqual([true, false, true])
    w.unmount()
  })

  it('★「画面共有を終了」で終了の合図を送る。部屋が消えたら視聴を閉じ、失敗の文は出ない', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const flushFake = () => vi.advanceTimersByTimeAsync(0)
    activeRoomsRef.value = ['screen-a', 'screen-b']
    const w = await mountSuspended(ScreenShareAdminView)
    await flushFake()
    await rooms(w)[0]!.trigger('click')
    await flushFake()

    await endButton(w).trigger('click')
    expect(sendEndShareMock).toHaveBeenCalledTimes(1)
    // 待っているあいだは押し直せない
    expect(endButton(w).text()).toBe('終了しています...')
    expect(endButton(w).attributes('disabled')).toBeDefined()

    // 共有している側が止まり、部屋が一覧から消えた
    activeRoomsRef.value = ['screen-b']
    await flushFake()
    expect(stopButton(w).exists()).toBe(false)
    expect(viewingEvents(w)).toEqual([true, false])

    // 時間が過ぎても失敗の文は出ない (待ちは片付いている)
    await vi.advanceTimersByTimeAsync(10000)
    expect(endError(w).exists()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    w.unmount()
  })

  it('★ 数秒たっても部屋が消えなければ「終了できませんでした」を出し、押し直せる', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const flushFake = () => vi.advanceTimersByTimeAsync(0)
    activeRoomsRef.value = ['screen-a']
    const w = await mountSuspended(ScreenShareAdminView)
    await flushFake()
    await rooms(w)[0]!.trigger('click')
    await flushFake()

    await endButton(w).trigger('click')
    await vi.advanceTimersByTimeAsync(4999)
    expect(endError(w).exists()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(endError(w).text()).toBe('終了できませんでした。もう一度お試しください')
    expect(endButton(w).text()).toBe('画面共有を終了')
    expect(endButton(w).attributes('disabled')).toBeUndefined()
    // 視聴は続いている
    expect(viewingEvents(w)).toEqual([true])

    // 押し直すと文が消え、もう一度送る
    await endButton(w).trigger('click')
    expect(endError(w).exists()).toBe(false)
    expect(sendEndShareMock).toHaveBeenCalledTimes(2)
    w.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('見ていない部屋が消えても、視聴は続く', async () => {
    activeRoomsRef.value = ['screen-a', 'screen-b']
    const w = await mountView()
    await click(rooms(w)[0]!, w)

    activeRoomsRef.value = ['screen-a']
    await w.vm.$nextTick()

    expect(stopButton(w).exists()).toBe(true)
    expect(viewingEvents(w)).toEqual([true])
    w.unmount()
  })
})

describe('ScreenShareAdminView — disabled / 後始末', () => {
  it('disabled の間は押しても見始めない (その旨を行に出す)', async () => {
    activeRoomsRef.value = ['screen-a']
    const w = await mountView({ disabled: true })

    expect(rooms(w)[0]!.text()).toContain('いまは視聴できません')
    expect(rooms(w)[0]!.text()).not.toContain('クリックして視聴')
    await click(rooms(w)[0]!, w)

    expect(connectMock).not.toHaveBeenCalled()
    expect(markHandledMock).not.toHaveBeenCalled()
    expect(viewingEvents(w)).toEqual([])

    await w.setProps({ disabled: false })
    expect(rooms(w)[0]!.text()).toContain('クリックして視聴')
    await click(rooms(w)[0]!, w)
    expect(connectMock).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('見ている最中に画面が消えたら、接続を切り「もう見ていない」を知らせる', async () => {
    activeRoomsRef.value = ['screen-a']
    // unmount の後は emitted() の記録が取り直されるので、listener で受ける
    const onViewing = vi.fn()
    const w = await mountView({ 'onUpdate:viewing': onViewing })
    await click(rooms(w)[0]!, w)
    disconnectMock.mockClear()

    w.unmount()

    expect(disconnectMock).toHaveBeenCalled()
    expect(onViewing.mock.calls.map(c => c[0])).toEqual([true, false])
    expect(sendEndShareMock).not.toHaveBeenCalled()
  })

  it('全画面の切り替えを追い、unmount で listener を外す', async () => {
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    activeRoomsRef.value = ['screen-a']
    const w = await mountView()
    const listener = add.mock.calls.find(c => c[0] === 'fullscreenchange')![1] as () => void

    // 見ていないあいだ (枠が無い) の全画面の操作は何もしない
    await click(rooms(w)[0]!, w)
    const fullscreenButton = w.find('button[title="全画面表示"]')
    const container = fullscreenButton.element.parentElement as HTMLElement
    container.requestFullscreen = vi.fn(async () => {})
    document.exitFullscreen = vi.fn(async () => {})

    Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true })
    await fullscreenButton.trigger('click')
    expect(container.requestFullscreen).toHaveBeenCalledTimes(1)

    Object.defineProperty(document, 'fullscreenElement', { value: container, configurable: true })
    listener()
    await w.vm.$nextTick()
    expect(w.find('button[title="全画面解除"]').exists()).toBe(true)
    await w.find('button[title="全画面解除"]').trigger('click')
    expect(document.exitFullscreen).toHaveBeenCalledTimes(1)

    Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true })
    listener()
    await w.vm.$nextTick()
    expect(w.find('button[title="全画面表示"]').exists()).toBe(true)

    w.unmount()
    expect(remove).toHaveBeenCalledWith('fullscreenchange', listener)
    add.mockRestore()
    remove.mockRestore()
  })
})

// 席の警告デバイスの更新を始めてよいかの材料 (Refs ippoan/alc-app#425)
describe('ScreenShareAdminView — 「機体を使用中」の申告', () => {
  it('★ 画面共有を見ている間だけ申告する (見始める → やめる)。unmount でも下りる', async () => {
    activeRoomsRef.value = ['screen-a']
    const w = await mountView()
    const { isDeviceBusy } = useKioskScreen()
    expect(isDeviceBusy.value).toBe(false)

    await click(rooms(w)[0]!, w)
    expect(isDeviceBusy.value).toBe(true)
    await click(stopButton(w), w)
    expect(isDeviceBusy.value).toBe(false)

    await click(rooms(w)[0]!, w)
    expect(isDeviceBusy.value).toBe(true)
    w.unmount()
    expect(isDeviceBusy.value).toBe(false)
  })
})
