import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import TenkoRemoteAdminView from '~/components/TenkoRemoteAdminView.vue'

// 遠隔点呼モニターの一覧に出す部屋 (Refs ippoan/alc-app#387)。
// 部屋の一覧は IT点呼 (`it-`)・画面共有 (`screen-`)・それ以外の 3 つに分かれ、ここは「それ以外」だけ。
// 画面共有の部屋が出ると、顔認証付きで通話を始められてしまう

vi.mock('~/utils/api', () => ({
  getEmployeeByCode: vi.fn(),
  getEmployeeById: vi.fn(),
  getEmployees: vi.fn(async () => []),
  getTenkoSession: vi.fn(),
  getDeviceSettings: vi.fn(async () => null),
  getDriverInfo: vi.fn(async () => null),
}))

const activeRoomsRef = ref<string[]>([])
mockNuxtImport('useActiveRooms', () => () => ({
  activeRooms: activeRoomsRef,
  start: vi.fn(),
  stop: vi.fn(),
  setJoined: vi.fn(),
  reload: vi.fn(async () => true),
}))

mockNuxtImport('useWebRtc', () => () => ({
  isConnected: ref(false),
  isPeerConnected: ref(false),
  remoteStream: ref(null),
  error: ref(null),
  connect: vi.fn(),
  startStreaming: vi.fn(),
  disconnect: vi.fn(),
}))

mockNuxtImport('useCamera', () => () => ({
  stream: ref(null),
  videoRef: ref(null),
  isActive: ref(false),
  start: vi.fn(),
  stop: vi.fn(),
}))

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  activeRoomsRef.value = []
  localStorage.clear()
})

describe('TenkoRemoteAdminView — 一覧に出す部屋', () => {
  it('★ screen- と it- の部屋は出ない。遠隔点呼の部屋とテスト着信は出る', async () => {
    activeRoomsRef.value = ['session-1', 'screen-abc', 'it-session-2', 'test-call-9']
    const w = await mountSuspended(TenkoRemoteAdminView)
    await flush()
    await w.vm.$nextTick()

    expect(w.text()).toContain('session-1')
    expect(w.text()).toContain('test-call-9')
    expect(w.text()).not.toContain('screen-abc')
    expect(w.text()).not.toContain('it-session-2')
    expect(w.text()).toContain('(2台)')
    w.unmount()
  })

  it('画面共有の部屋だけなら、一覧は空', async () => {
    activeRoomsRef.value = ['screen-abc']
    const w = await mountSuspended(TenkoRemoteAdminView)
    await flush()
    await w.vm.$nextTick()

    expect(w.text()).toContain('(0台)')
    expect(w.text()).not.toContain('screen-abc')
    w.unmount()
  })
})

// 席の警告デバイスの更新を始めてよいかの材料 (Refs ippoan/alc-app#425)。リロードの申告とは別の集合
describe('TenkoRemoteAdminView — 「機体を使用中」の申告', () => {
  it('★ 待機中は申告せず、部屋を押して本人確認に入ったら申告する。unmount で下りる', async () => {
    activeRoomsRef.value = ['session-1']
    const w = await mountSuspended(TenkoRemoteAdminView)
    await flush()
    await w.vm.$nextTick()
    const { isDeviceBusy } = useKioskScreen()
    expect(isDeviceBusy.value).toBe(false)

    await w.findAll('div').find(d => d.classes().includes('cursor-pointer') && d.text().includes('session-1'))!.trigger('click')
    expect(isDeviceBusy.value).toBe(true)

    w.unmount()
    expect(isDeviceBusy.value).toBe(false)
  })
})
