// 遠隔点呼モニター: IT点呼の着信では運行管理者の顔認証を飛ばす (Refs ippoan/alc-app#387)。
//
// 飛ばすのは「開発用の印がある席で、運行管理者が自分で部屋を選び、点呼が IT点呼・未判定」のときだけ。
// 印が無い席は session を引かず、今までどおり顔認証の段へ進む (本番の席の流れを変えない)。
// 通話・カメラ・部屋の購読はモックし、子コンポーネントは stub。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, readonly, nextTick } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import TenkoRemoteAdminView from '~/components/TenkoRemoteAdminView.vue'
import { noteDeviceToken } from '~/utils/token-selection'
import { devDeviceJwt, plainDeviceJwt } from '../helpers/dummy-jwt'

// 値はすべて架空 (部屋の id = 点呼セッションの id)
const ROOM = 'room-it-1'
const OTHER_ROOM = 'room-remote-2'
const MANAGER_ID = 'manager-emp-1'

const { getTenkoSessionMock, getEmployeeByCodeMock } = vi.hoisted(() => ({
  getTenkoSessionMock: vi.fn(),
  getEmployeeByCodeMock: vi.fn(),
}))
vi.mock('~/utils/api', () => ({
  getTenkoSession: getTenkoSessionMock,
  getEmployeeByCode: getEmployeeByCodeMock,
  getEmployeeById: vi.fn(async () => ({ name: '管理 太郎' })),
  getEmployees: vi.fn(async () => []),
  getDeviceSettings: vi.fn(async () => ({})),
  getDriverInfo: vi.fn(async () => null),
}))

const webRtcConnect = vi.fn(async () => {})
mockNuxtImport('useWebRtc', () => () => ({
  isConnected: ref(false),
  isPeerConnected: ref(false),
  remoteStream: ref(null),
  error: ref(null),
  connect: webRtcConnect,
  startStreaming: vi.fn(async () => {}),
  disconnect: vi.fn(),
}))

const cameraStart = vi.fn(async () => {})
mockNuxtImport('useCamera', () => () => ({
  stream: ref(null),
  start: cameraStart,
  stop: vi.fn(),
}))

const activeRooms = ref<string[]>([])
mockNuxtImport('useActiveRooms', () => () => ({
  activeRooms: readonly(activeRooms),
  start: vi.fn(),
  stop: vi.fn(),
  setJoined: vi.fn(),
  reload: vi.fn(async () => true),
}))

const authenticatedManagerId = ref<string | null>(null)
mockNuxtImport('useManagerAuth', () => () => ({
  authenticatedManagerId,
  setManagerId: (id: string | null) => { authenticatedManagerId.value = id },
  loadFromDevice: () => {},
}))

mockNuxtImport('useAuth', () => () => ({ deviceId: ref(null), deviceSettingsToken: ref(null) }))
mockNuxtImport('useKioskScreen', () => () => ({ declareSafeToReload: vi.fn() }))

function itSession(over: Record<string, unknown> = {}) {
  return { id: ROOM, employee_id: '', tenko_method: 'IT点呼', manager_judgment: null, ...over }
}

function mountView(props: { initialRoomId?: string } = {}) {
  return mountSuspended(TenkoRemoteAdminView, {
    props,
    global: {
      stubs: { FaceAuth: true, TenkoVideoCall: true, TenkoDriverInfoPanel: true, TenkoManagerJudgmentPanel: true },
    },
  })
}

type View = Awaited<ReturnType<typeof mountView>>

/** 運行管理者が一覧から部屋を選ぶ */
async function pickRoom(wrapper: View, index = 0) {
  await wrapper.findAll('.cursor-pointer')[index]!.trigger('click')
  await flushPromises()
}

const faceAuthShown = (wrapper: View) => wrapper.find('face-auth-stub').exists()
const idInputShown = (wrapper: View) => wrapper.find('input[placeholder^="社員番号"]').exists()

beforeEach(() => {
  vi.clearAllMocks()
  activeRooms.value = [ROOM, OTHER_ROOM]
  authenticatedManagerId.value = MANAGER_ID
  getTenkoSessionMock.mockResolvedValue(itSession())
  getEmployeeByCodeMock.mockResolvedValue({ id: MANAGER_ID, name: '管理 太郎', role: ['manager'] })
  noteDeviceToken('manager-device', devDeviceJwt())
})

afterEach(() => {
  noteDeviceToken('manager-device', null)
  localStorage.clear()
})

describe('TenkoRemoteAdminView — IT点呼の着信で顔認証を飛ばす', () => {
  it('★ 印が無い席: session を引かず、今までどおり顔認証の段へ進む (通話は始めない)', async () => {
    noteDeviceToken('manager-device', plainDeviceJwt())
    const wrapper = await mountView()

    await wrapper.findAll('.cursor-pointer')[0]!.trigger('click')
    // 同期の流れのまま: 通信を待たずに顔認証が出ている
    expect(faceAuthShown(wrapper)).toBe(true)
    await flushPromises()

    expect(getTenkoSessionMock).not.toHaveBeenCalled()
    expect(webRtcConnect).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('印あり + 自分で選ぶ + IT点呼・未判定 + 社員番号が復元済み: 顔認証を出さずに通話開始', async () => {
    const wrapper = await mountView()
    await pickRoom(wrapper)

    expect(getTenkoSessionMock).toHaveBeenCalledWith(ROOM, 'tenko-monitor')
    expect(faceAuthShown(wrapper)).toBe(false)
    expect(idInputShown(wrapper)).toBe(false)
    expect(cameraStart).toHaveBeenCalledTimes(1)
    expect(webRtcConnect).toHaveBeenCalledWith(expect.any(String), ROOM)
    wrapper.unmount()
  })

  it('印あり + 自分で選ぶ + IT点呼・未判定 + 社員番号なし: 社員番号の段が出て、入力後に顔認証を出さずに通話開始', async () => {
    authenticatedManagerId.value = null
    const wrapper = await mountView()
    await pickRoom(wrapper)

    // 社員番号の段は残る (この時点ではまだ通話を始めない)
    expect(idInputShown(wrapper)).toBe(true)
    expect(webRtcConnect).not.toHaveBeenCalled()

    await wrapper.find('input[placeholder^="社員番号"]').setValue('001')
    await wrapper.findAll('button').find(b => b.text() === '次へ')!.trigger('click')
    await flushPromises()

    expect(getEmployeeByCodeMock).toHaveBeenCalledWith('001', 'tenko-monitor')
    expect(faceAuthShown(wrapper)).toBe(false)
    expect(webRtcConnect).toHaveBeenCalledWith(expect.any(String), ROOM)
    wrapper.unmount()
  })

  it('社員番号の段の役割の検査はそのまま (運行管理者でなければ通話を始めない)', async () => {
    authenticatedManagerId.value = null
    getEmployeeByCodeMock.mockResolvedValue({ id: 'driver-emp-1', name: '運転 次郎', role: ['driver'] })
    const wrapper = await mountView()
    await pickRoom(wrapper)

    await wrapper.find('input[placeholder^="社員番号"]').setValue('002')
    await wrapper.findAll('button').find(b => b.text() === '次へ')!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('運行管理者の権限がありません')
    expect(webRtcConnect).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('印あり + 遠隔点呼: 顔認証', async () => {
    getTenkoSessionMock.mockResolvedValue(itSession({ tenko_method: '遠隔点呼' }))
    const wrapper = await mountView()
    await pickRoom(wrapper)

    expect(getTenkoSessionMock).toHaveBeenCalledTimes(1)
    expect(faceAuthShown(wrapper)).toBe(true)
    expect(webRtcConnect).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('印あり + IT点呼でも判定済み: 顔認証', async () => {
    getTenkoSessionMock.mockResolvedValue(itSession({ manager_judgment: 'ok' }))
    const wrapper = await mountView()
    await pickRoom(wrapper)

    expect(faceAuthShown(wrapper)).toBe(true)
    expect(webRtcConnect).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('印あり + session を引けない: 顔認証', async () => {
    getTenkoSessionMock.mockRejectedValue(new Error('404'))
    const wrapper = await mountView()
    await pickRoom(wrapper)

    expect(faceAuthShown(wrapper)).toBe(true)
    expect(webRtcConnect).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('★ 印あり + initialRoomId による自動の呼び出し + IT点呼・未判定: 飛ばさない (session も引かず顔認証)', async () => {
    activeRooms.value = []
    const wrapper = await mountView({ initialRoomId: ROOM })

    activeRooms.value = [ROOM]
    await nextTick()
    await flushPromises()

    expect(getTenkoSessionMock).not.toHaveBeenCalled()
    expect(faceAuthShown(wrapper)).toBe(true)
    expect(cameraStart).not.toHaveBeenCalled()
    expect(webRtcConnect).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('引いている間に別の部屋を選んだら、古い方の結果は捨てる', async () => {
    let resolveFirst!: (s: unknown) => void
    getTenkoSessionMock
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r }))
      .mockResolvedValueOnce(itSession({ id: OTHER_ROOM, tenko_method: '遠隔点呼' }))
    const wrapper = await mountView()

    await wrapper.findAll('.cursor-pointer')[0]!.trigger('click')
    await pickRoom(wrapper, 1)
    // 後から選んだ遠隔点呼の部屋: 顔認証
    expect(faceAuthShown(wrapper)).toBe(true)

    // 先に選んだ IT点呼の結果が遅れて届いても、通話を始めない
    resolveFirst(itSession())
    await flushPromises()
    expect(faceAuthShown(wrapper)).toBe(true)
    expect(webRtcConnect).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
