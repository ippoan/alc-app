import { describe, it, expect, vi, beforeEach } from 'vitest'
import { defineComponent, onMounted, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import TenkoRemoteAdminView from '~/components/TenkoRemoteAdminView.vue'

// 通話中、乗務員の端末が申告した端末 ID が分かったら拠点カメラを出す。通話を終えたら外す

vi.mock('~/utils/api', () => ({
  getEmployeeByCode: vi.fn(),
  getEmployeeById: vi.fn(async () => ({ name: '管理者' })),
  getEmployees: vi.fn(async () => []),
  getTenkoSession: vi.fn(async () => { throw new Error('no session') }),
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

const peerDeviceId = ref<string | null>(null)
mockNuxtImport('useWebRtc', () => () => ({
  isConnected: ref(true),
  isPeerConnected: ref(true),
  remoteStream: ref(null),
  error: ref(null),
  peerDeviceId,
  ptzChannel: ref(null),
  connect: vi.fn(async () => {}),
  startStreaming: vi.fn(),
  disconnect: vi.fn(() => { peerDeviceId.value = null }),
}))

mockNuxtImport('useCamera', () => () => ({
  stream: ref(null),
  videoRef: ref(null),
  isActive: ref(false),
  start: vi.fn(async () => {}),
  stop: vi.fn(),
}))

// 顔認証はすぐ通ったことにする
const FaceAuthStub = defineComponent({
  emits: ['result'],
  setup(_, { emit }) { onMounted(() => emit('result', { verified: true })) },
  render: () => null,
})
const stubs = {
  FaceAuth: FaceAuthStub,
  TenkoVideoCall: { template: '<div />' },
  TenkoSiteCameras: { props: ['deviceId'], template: '<div data-testid="site-cameras-stub">{{ deviceId }}</div>' },
}

beforeEach(() => {
  activeRoomsRef.value = ['session-1']
  peerDeviceId.value = null
  localStorage.clear()
})

async function mountInCall() {
  useManagerAuth().setManagerId('mgr-1')
  const w = await mountSuspended(TenkoRemoteAdminView, { global: { stubs } })
  await flushPromises()
  await w.findAll('div').find(d => d.classes().includes('cursor-pointer') && d.text().includes('session-1'))!.trigger('click')
  await flushPromises()
  return w
}

describe('TenkoRemoteAdminView — 拠点カメラ', () => {
  it('★ 端末 ID が分かるまでは出さず、分かったらその ID で出す。通話終了で外れる', async () => {
    const w = await mountInCall()
    expect(w.text()).toContain('通話終了')
    expect(w.find('[data-testid="site-cameras-stub"]').exists()).toBe(false)

    peerDeviceId.value = 'kiosk-1'
    await flushPromises()
    expect(w.find('[data-testid="site-cameras-stub"]').text()).toBe('kiosk-1')

    await w.findAll('button').find(b => b.text() === '通話終了')!.trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="site-cameras-stub"]').exists()).toBe(false)
    w.unmount()
  })
})
