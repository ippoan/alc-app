import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, readonly } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import ManagerAlarmBar from '~/components/ManagerAlarmBar.vue'

// --- composable のモック (呼び順を 1 本の配列に記録して mount/unmount の順序を検証する) ---

const calls: string[] = []

const alarmState = {
  isSupported: true,
  isConnected: ref(false),
  deviceState: ref<{ state: 'idle' | 'alarming' | 'muted'; cause: string } | null>(null),
}
const alarmMock = {
  connect: vi.fn((delay: number) => { calls.push(`connect(${delay})`) }),
  disconnect: vi.fn(async () => { calls.push('disconnect') }),
  requestPort: vi.fn(async () => { calls.push('requestPort') }),
}

const roomsState = {
  isWatching: ref(true),
  activeRooms: ref<string[]>([]),
  joinedRoomId: ref<string | null>(null),
}
const roomsMock = {
  start: vi.fn(() => { calls.push('start') }),
  stop: vi.fn(() => { calls.push('stop') }),
}

mockNuxtImport('useAlarmDevice', () => () => ({
  isSupported: alarmState.isSupported,
  isConnected: readonly(alarmState.isConnected),
  deviceState: readonly(alarmState.deviceState),
  ...alarmMock,
}))

mockNuxtImport('useActiveRooms', () => () => ({
  isWatching: readonly(roomsState.isWatching),
  activeRooms: readonly(roomsState.activeRooms),
  joinedRoomId: readonly(roomsState.joinedRoomId),
  setJoined: vi.fn(),
  reload: vi.fn(),
  ...roomsMock,
}))

describe('ManagerAlarmBar', () => {
  beforeEach(() => {
    calls.length = 0
    vi.clearAllMocks()
    alarmState.isSupported = true
    alarmState.isConnected.value = false
    alarmState.deviceState.value = null
    roomsState.isWatching.value = true
    roomsState.activeRooms.value = []
    roomsState.joinedRoomId.value = null
  })

  it('mount で購読 → heartbeat の順に始め、unmount で heartbeat → 購読の順に止める', async () => {
    const wrapper = await mountSuspended(ManagerAlarmBar)
    expect(calls).toEqual(['start', 'connect(0)'])

    wrapper.unmount()
    expect(calls).toEqual(['start', 'connect(0)', 'disconnect', 'stop'])
  })

  it('Web Serial が無いブラウザでは何も描画せず、購読も heartbeat も立てない', async () => {
    alarmState.isSupported = false
    const wrapper = await mountSuspended(ManagerAlarmBar)

    expect(wrapper.find('[data-testid="manager-alarm-bar"]').exists()).toBe(false)
    expect(calls).toEqual([])

    wrapper.unmount()
    expect(calls).toEqual([])
  })

  it('未接続のあいだは灰の丸と「未接続」', async () => {
    const wrapper = await mountSuspended(ManagerAlarmBar)
    expect(wrapper.text()).toContain('警告デバイス: 未接続')
    expect(wrapper.find('.bg-gray-300').exists()).toBe(true)
    wrapper.unmount()
  })

  it('接続後は緑、鳴動中は赤 + 理由、停止済みは黄 + 理由', async () => {
    alarmState.isConnected.value = true
    const wrapper = await mountSuspended(ManagerAlarmBar)
    expect(wrapper.text()).toContain('警告デバイス: 接続')
    expect(wrapper.find('.bg-green-500').exists()).toBe(true)

    alarmState.deviceState.value = { state: 'alarming', cause: 'silence' }
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('鳴動中 (無音)')
    expect(wrapper.find('.bg-red-500').exists()).toBe(true)

    alarmState.deviceState.value = { state: 'muted', cause: 'call' }
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('停止済み (人が止めた・呼び出し)')
    expect(wrapper.find('.bg-amber-400').exists()).toBe(true)

    // firmware が知らない cause を返しても、そのまま表示する
    alarmState.deviceState.value = { state: 'alarming', cause: 'ng:unknown' }
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('鳴動中 (ng:unknown)')
    wrapper.unmount()
  })

  it('room が立っていて未参加なら「着信あり」(台数は出さない)', async () => {
    roomsState.activeRooms.value = ['room-a', 'room-b']
    const wrapper = await mountSuspended(ManagerAlarmBar)
    expect(wrapper.text()).toContain('着信あり')
    expect(wrapper.text()).not.toContain('2')

    // どれかに入れば着信ではない
    roomsState.joinedRoomId.value = 'room-a'
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).not.toContain('着信あり')
    wrapper.unmount()
  })

  it('signaling 未接続なら着信の代わりに警告文を出す', async () => {
    roomsState.isWatching.value = false
    roomsState.activeRooms.value = ['room-a']
    const wrapper = await mountSuspended(ManagerAlarmBar)
    expect(wrapper.text()).toContain('着信を受けられません (signaling 未接続)')
    expect(wrapper.text()).not.toContain('着信あり')
    wrapper.unmount()
  })

  it('「警告デバイスを接続」でポート許可を求める', async () => {
    const wrapper = await mountSuspended(ManagerAlarmBar)
    await wrapper.find('button').trigger('click')
    expect(alarmMock.requestPort).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})
