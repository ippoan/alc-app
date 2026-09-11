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

// この端末で警告デバイスを使うか (true / false / null = 未設定)。既定は true で既存ケースを保つ
const settingState = {
  enabled: ref<boolean | null>(true),
}
const setEnabledMock = vi.fn((v: boolean) => { settingState.enabled.value = v })

mockNuxtImport('useAlarmDeviceSetting', () => () => ({
  enabled: readonly(settingState.enabled),
  setEnabled: setEnabledMock,
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
    settingState.enabled.value = true
  })

  it('購読も接続も始めず止めもしない (見張りはトップ画面の useAlarmWatch の役目 = 二重に起動しない)', async () => {
    // まだ購読していない・未接続の状態から mount しても、バーは表示だけ
    roomsState.isWatching.value = false
    const wrapper = await mountSuspended(ManagerAlarmBar)
    expect(wrapper.find('[data-testid="manager-alarm-bar"]').exists()).toBe(true)
    expect(calls).toEqual([])

    // 設定 off に変わっても、切るのはバーではない
    settingState.enabled.value = false
    await wrapper.vm.$nextTick()
    expect(calls).toEqual([])

    wrapper.unmount()
    expect(calls).toEqual([])
  })

  it('Web Serial が無いブラウザでは何も描画せず、購読も heartbeat も立てない', async () => {
    alarmState.isSupported = false
    const wrapper = await mountSuspended(ManagerAlarmBar)

    expect(wrapper.find('[data-testid="manager-alarm-bar"]').exists()).toBe(false)
    expect(calls).toEqual([])

    wrapper.unmount()
    expect(calls).toEqual([])
  })

  it('「使わない」端末では何も描画せず、購読も heartbeat も立てない', async () => {
    settingState.enabled.value = false
    const wrapper = await mountSuspended(ManagerAlarmBar)

    expect(wrapper.find('[data-testid="manager-alarm-bar"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="manager-alarm-ask"]').exists()).toBe(false)
    expect(calls).toEqual([])

    wrapper.unmount()
    expect(calls).toEqual([])
  })

  it('未設定 (既存の端末) なら問いかけカードだけを出し、[つなぐ] で保存してバーに切り替わる', async () => {
    settingState.enabled.value = null
    roomsState.isWatching.value = false
    const wrapper = await mountSuspended(ManagerAlarmBar)

    expect(wrapper.find('[data-testid="manager-alarm-ask"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('この PC に警告デバイス (Atom VoiceS3R) をつなぎますか?')
    expect(wrapper.find('[data-testid="manager-alarm-bar"]').exists()).toBe(false)
    // 「使う」と決まるまで探索しない
    expect(calls).toEqual([])

    await wrapper.find('[data-testid="manager-alarm-ask-yes"]').trigger('click')
    expect(setEnabledMock).toHaveBeenCalledWith(true)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="manager-alarm-ask"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="manager-alarm-bar"]').exists()).toBe(true)
    // 探索を始めるのはバーではなく、設定の変化を見ている useAlarmWatch (トップ画面)
    expect(calls).toEqual([])

    wrapper.unmount()
    expect(calls).toEqual([])
  })

  it('未設定で [つながない] を選ぶと保存して非表示になり、unmount でも何も止めない', async () => {
    settingState.enabled.value = null
    const wrapper = await mountSuspended(ManagerAlarmBar)

    await wrapper.find('[data-testid="manager-alarm-ask-no"]').trigger('click')
    expect(setEnabledMock).toHaveBeenCalledWith(false)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="manager-alarm-ask"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="manager-alarm-bar"]').exists()).toBe(false)

    wrapper.unmount()
    expect(calls).toEqual([])
  })

  it('未接続のあいだは赤のアイコン + 赤枠 + 「接続されていません」、ボタンは「接続」', async () => {
    const wrapper = await mountSuspended(ManagerAlarmBar)
    expect(wrapper.text()).toContain('警告デバイス')
    expect(wrapper.text()).toContain('未接続')
    expect(wrapper.text()).toContain('警告デバイスが接続されていません')
    expect(wrapper.find('.bg-red-100').exists()).toBe(true)
    expect(wrapper.find('.animate-pulse').exists()).toBe(true)
    expect(wrapper.find('[data-testid="manager-alarm-bar"]').classes()).toContain('border-red-300')
    expect(wrapper.find('button').text()).toBe('接続')
    wrapper.unmount()
  })

  it('未接続の警告は signaling 未接続 / 着信より優先し、つながると消える', async () => {
    roomsState.isWatching.value = false
    roomsState.activeRooms.value = ['room-a']
    const wrapper = await mountSuspended(ManagerAlarmBar)
    expect(wrapper.text()).toContain('警告デバイスが接続されていません')
    expect(wrapper.text()).not.toContain('着信を受けられません')
    expect(wrapper.text()).not.toContain('着信あり')

    alarmState.isConnected.value = true
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).not.toContain('接続されていません')
    expect(wrapper.text()).toContain('着信を受けられません (signaling 未接続)')
    wrapper.unmount()
  })

  it('接続後は緑、鳴動中は赤 + 理由 + 赤枠、停止済みは黄 + 理由', async () => {
    alarmState.isConnected.value = true
    const wrapper = await mountSuspended(ManagerAlarmBar)
    expect(wrapper.text()).toContain('接続')
    expect(wrapper.find('.bg-green-100').exists()).toBe(true)
    // 平常は脈打たない
    expect(wrapper.find('.animate-pulse').exists()).toBe(false)
    // 接続済みならボタンは繋ぎ直し
    expect(wrapper.find('button').text()).toBe('接続し直す')

    alarmState.deviceState.value = { state: 'alarming', cause: 'silence' }
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('鳴動中 (無音)')
    expect(wrapper.find('.bg-red-100').exists()).toBe(true)
    expect(wrapper.find('.animate-pulse').exists()).toBe(true)
    // 鳴動中はカードごと赤く縁取る
    expect(wrapper.find('[data-testid="manager-alarm-bar"]').classes()).toContain('border-red-300')

    alarmState.deviceState.value = { state: 'muted', cause: 'call' }
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('停止済み (人が止めた・呼び出し)')
    expect(wrapper.find('.bg-amber-100').exists()).toBe(true)
    expect(wrapper.find('[data-testid="manager-alarm-bar"]').classes()).toContain('border-amber-200')

    // firmware が知らない cause を返しても、そのまま表示する
    alarmState.deviceState.value = { state: 'alarming', cause: 'ng:unknown' }
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('鳴動中 (ng:unknown)')
    wrapper.unmount()
  })

  it('room が立っていて未参加なら「着信あり」+ amber の枠と脈打つアイコン (台数は出さない)', async () => {
    alarmState.isConnected.value = true
    roomsState.activeRooms.value = ['room-a', 'room-b']
    const wrapper = await mountSuspended(ManagerAlarmBar)
    expect(wrapper.text()).toContain('着信あり')
    expect(wrapper.text()).not.toContain('2')
    expect(wrapper.find('.bg-amber-100').exists()).toBe(true)
    expect(wrapper.find('.animate-pulse').exists()).toBe(true)
    expect(wrapper.find('[data-testid="manager-alarm-bar"]').classes()).toContain('border-amber-300')

    // どれかに入れば着信ではなく、平常の見張り文言と緑に戻る
    roomsState.joinedRoomId.value = 'room-a'
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).not.toContain('着信あり')
    expect(wrapper.text()).toContain('運行管理者のブラウザを見張っています')
    expect(wrapper.find('.bg-green-100').exists()).toBe(true)
    expect(wrapper.find('[data-testid="manager-alarm-bar"]').classes()).not.toContain('border-amber-300')

    // デバイス側の鳴動 / 停止済みは着信より優先する
    alarmState.deviceState.value = { state: 'muted', cause: 'call' }
    roomsState.joinedRoomId.value = null
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="manager-alarm-bar"]').classes()).toContain('border-amber-200')
    wrapper.unmount()
  })

  it('signaling 未接続なら着信の代わりに警告文を出す', async () => {
    alarmState.isConnected.value = true
    roomsState.isWatching.value = false
    roomsState.activeRooms.value = ['room-a']
    const wrapper = await mountSuspended(ManagerAlarmBar)
    expect(wrapper.text()).toContain('着信を受けられません (signaling 未接続)')
    expect(wrapper.text()).not.toContain('着信あり')
    wrapper.unmount()
  })

  it('接続ボタンでポート許可を求める', async () => {
    const wrapper = await mountSuspended(ManagerAlarmBar)
    await wrapper.find('button').trigger('click')
    expect(alarmMock.requestPort).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})
