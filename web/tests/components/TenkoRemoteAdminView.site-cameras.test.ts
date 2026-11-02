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

// 通話前の指静脈の確認はすぐ運行管理者が特定できたことにする
const VeinConfirmStub = defineComponent({
  props: { onEmployee: { type: Function, required: true } },
  setup(props) { onMounted(() => { void props.onEmployee({ id: 'mgr-1', name: '運行 管理者', role: ['manager'] }) }) },
  render: () => null,
})
const stubs = {
  ItTenkoVeinRegister: VeinConfirmStub,
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

describe('TenkoRemoteAdminView — 判定のあと', () => {
  it('★ 判定を送ったら通話を終えて一覧に戻る (IT点呼と同じ。残すと押し直して送信失敗になる)', async () => {
    const { getTenkoSession } = await import('~/utils/api')
    vi.mocked(getTenkoSession).mockResolvedValue({
      id: 'session-1', employee_id: 'emp-1', status: 'judgment_pending', tenko_type: 'pre_operation',
    } as never)
    const judgeStub = {
      emits: ['judged'],
      template: '<button data-testid="judge-stub" @click="$emit(\'judged\', { id: \'session-1\', status: \'completed\' })">判定</button>',
    }
    useManagerAuth().setManagerId('mgr-1')
    const w = await mountSuspended(TenkoRemoteAdminView, { global: { stubs: { ...stubs, TenkoManagerJudgmentPanel: judgeStub, TenkoDriverInfoPanel: true } } })
    await flushPromises()
    await w.findAll('div').find(d => d.classes().includes('cursor-pointer') && d.text().includes('session-1'))!.trigger('click')
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 0))
    await flushPromises()
    expect(w.text()).toContain('通話終了')
    await w.find('[data-testid="judge-stub"]').trigger('click')
    await flushPromises()
    expect(w.text()).not.toContain('通話終了')
    expect(w.find('[data-testid="judge-stub"]').exists()).toBe(false)
    vi.mocked(getTenkoSession).mockRejectedValue(new Error('no session'))
    w.unmount()
  })
})

describe('TenkoRemoteAdminView — 点呼受付で並べたとき', () => {
  it('★ 並べた IT点呼 が通話中 (blocked) の間は確認を出さず理由を出す。確認中・通話中は busy を知らせる', async () => {
    useManagerAuth().setManagerId('mgr-1')
    const w = await mountSuspended(TenkoRemoteAdminView, { props: { blocked: true }, global: { stubs } })
    await flushPromises()
    expect(w.emitted('busy')!.at(-1)).toEqual([false])
    const row = () => w.findAll('div').find(d => d.classes().includes('cursor-pointer') && d.text().includes('session-1'))!
    await row().trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="remote-blocked-by-it"]').text()).toContain('IT点呼の通話中')
    expect(w.text()).not.toContain('通話終了')
    await w.setProps({ blocked: false })
    expect(w.find('[data-testid="remote-blocked-by-it"]').exists()).toBe(false)
    await row().trigger('click')
    await flushPromises()
    expect(w.text()).toContain('通話終了')
    expect(w.emitted('busy')!.at(-1)).toEqual([true])
    w.unmount()
  })
})

describe('TenkoRemoteAdminView — 点呼受付に埋め込む (embedded)', () => {
  it('★ 自前の一覧は出さず、requestCall で呼ばれたら指静脈の確認から通話まで受け持つ', async () => {
    useManagerAuth().setManagerId('mgr-1')
    const w = await mountSuspended(TenkoRemoteAdminView, { props: { embedded: true }, global: { stubs } })
    await flushPromises()
    expect(w.text()).not.toContain('遠隔点呼モニター')
    expect(w.text()).not.toContain('接続待ちデバイス')
    ;(w.vm as unknown as { requestCall: (id: string) => void }).requestCall('session-1')
    await flushPromises()
    expect(w.text()).toContain('通話終了')
    w.unmount()
  })
})

