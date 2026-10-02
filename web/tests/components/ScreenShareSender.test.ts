import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import ScreenShareSender from '~/components/ScreenShareSender.vue'

// 画面共有を始める浮きボタン。運行管理者が「画面共有を終了」を押して止まった直後だけ、
// その旨を出す (Refs ippoan/alc-app#387)。止める処理と時間は useScreenShare の側

const state = {
  isSharing: ref(false),
  endedByAdmin: ref(false),
  error: ref<string | null>(null),
}
const startSharingMock = vi.fn()
mockNuxtImport('useScreenShare', () => () => ({
  isSharing: state.isSharing,
  roomId: ref<string | null>(null),
  error: state.error,
  isPeerConnected: ref(false),
  isConnected: ref(false),
  isMuted: ref(false),
  endedByAdmin: state.endedByAdmin,
  remoteStream: ref(null),
  startSharing: startSharingMock,
  stopSharing: vi.fn(),
  toggleMute: vi.fn(),
}))

// 「機体を使用中」の申告 (Refs ippoan/alc-app#425)。渡された source をそのまま取っておく
const declareDeviceBusyMock = vi.fn()
mockNuxtImport('useKioskScreen', () => () => ({ declareDeviceBusy: declareDeviceBusyMock }))

const notice = (w: Awaited<ReturnType<typeof mountSuspended>>) => w.find('[data-testid="screen-share-ended-by-admin"]')

beforeEach(() => {
  vi.clearAllMocks()
  state.isSharing.value = false
  state.endedByAdmin.value = false
  state.error.value = null
})

describe('ScreenShareSender — 運行管理者が終了したとき', () => {
  it('ふだんは出ない', async () => {
    const w = await mountSuspended(ScreenShareSender)
    expect(notice(w).exists()).toBe(false)
    expect(w.text()).toContain('画面共有')
    w.unmount()
  })

  it('★ 運行管理者の終了で止まった直後は「管理者が画面共有を終了しました」を出し、消えたら元に戻る', async () => {
    const w = await mountSuspended(ScreenShareSender)

    state.endedByAdmin.value = true
    await w.vm.$nextTick()
    expect(notice(w).text()).toBe('管理者が画面共有を終了しました')
    // 共有を始めるボタンは出たまま (もう一度始められる)
    await w.findAll('button').find(b => b.text() === '画面共有')!.trigger('click')
    expect(startSharingMock).toHaveBeenCalledTimes(1)

    state.endedByAdmin.value = false
    await w.vm.$nextTick()
    expect(notice(w).exists()).toBe(false)
    w.unmount()
  })

  it('共有中のパネルには出さない', async () => {
    state.isSharing.value = true
    state.endedByAdmin.value = true
    const w = await mountSuspended(ScreenShareSender)
    expect(notice(w).exists()).toBe(false)
    w.unmount()
  })
})

describe('ScreenShareSender — 画面共有の最中は端末の更新を始めさせない (Refs ippoan/alc-app#425)', () => {
  it('★ 共有している間だけ「機体を使用中」を申告する (申告は 1 つ)', async () => {
    const w = await mountSuspended(ScreenShareSender)
    expect(declareDeviceBusyMock).toHaveBeenCalledTimes(1)
    const source = declareDeviceBusyMock.mock.calls[0]![0] as () => boolean
    expect(source()).toBe(false)
    state.isSharing.value = true
    expect(source()).toBe(true)
    state.isSharing.value = false
    expect(source()).toBe(false)
    w.unmount()
  })
})
