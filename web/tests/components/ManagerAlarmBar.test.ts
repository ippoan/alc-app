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
  // 着信として数える部屋 (判定は useActiveRooms の側。バーは読むだけ)
  callingRooms: ref<string[]>([]),
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
  callingRooms: readonly(roomsState.callingRooms),
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
    roomsState.callingRooms.value = []
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
    roomsState.callingRooms.value = ['room-a']
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

  it('着信として数える部屋が在れば「着信あり」+ amber の枠と脈打つアイコン (台数は出さない)', async () => {
    alarmState.isConnected.value = true
    roomsState.callingRooms.value = ['room-a', 'room-b']
    const wrapper = await mountSuspended(ManagerAlarmBar)
    // ★ 回帰: 遠隔点呼だけの着信の文言は今までと同じ
    expect(wrapper.text()).toContain('着信あり — 遠隔点呼に入ると止まります')
    expect(wrapper.text()).not.toContain('2')
    expect(wrapper.find('.bg-amber-100').exists()).toBe(true)
    expect(wrapper.find('.animate-pulse').exists()).toBe(true)
    expect(wrapper.find('[data-testid="manager-alarm-bar"]').classes()).toContain('border-amber-300')

    // 数える部屋が無くなれば (どれかに入った・対応を終えた) 平常の見張り文言と緑に戻る
    roomsState.callingRooms.value = []
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).not.toContain('着信あり')
    expect(wrapper.text()).toContain('運行管理者のブラウザを見張っています')
    expect(wrapper.find('.bg-green-100').exists()).toBe(true)
    expect(wrapper.find('[data-testid="manager-alarm-bar"]').classes()).not.toContain('border-amber-300')

    // デバイス側の鳴動 / 停止済みは着信より優先する
    alarmState.deviceState.value = { state: 'muted', cause: 'call' }
    roomsState.callingRooms.value = ['room-a']
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="manager-alarm-bar"]').classes()).toContain('border-amber-200')
    wrapper.unmount()
  })

  it('signaling 未接続なら着信の代わりに警告文を出す', async () => {
    alarmState.isConnected.value = true
    roomsState.isWatching.value = false
    roomsState.callingRooms.value = ['room-a']
    const wrapper = await mountSuspended(ManagerAlarmBar)
    expect(wrapper.text()).toContain('着信を受けられません (signaling 未接続)')
    expect(wrapper.text()).not.toContain('着信あり')
    wrapper.unmount()
  })

  // --- 着信の案内は部屋の種別で分ける (Refs ippoan/alc-app#387) ---

  it.each([
    ['遠隔点呼だけ', ['room-a'], '着信あり — 遠隔点呼に入ると止まります'],
    ['IT点呼 だけ', ['it-s1'], 'IT点呼の着信あり — IT点呼 の画面で通話すると止まります'],
    ['両方', ['room-a', 'it-s1'], '遠隔点呼と IT点呼 の着信あり — それぞれの画面で通話すると止まります'],
  ])('着信が %s のときの文言 (見た目は同じ amber)', async (_label, rooms, text) => {
    alarmState.isConnected.value = true
    roomsState.callingRooms.value = rooms
    const wrapper = await mountSuspended(ManagerAlarmBar)

    expect(wrapper.find('p.text-amber-700').text()).toBe(text)
    expect(wrapper.find('[data-testid="manager-alarm-bar"]').classes()).toContain('border-amber-300')
    wrapper.unmount()
  })

  it('★ 回帰: 着信が無ければ平常の見張り文言 (部屋 0 の席は今までと同じ)', async () => {
    alarmState.isConnected.value = true
    const wrapper = await mountSuspended(ManagerAlarmBar)

    expect(wrapper.text()).toContain('運行管理者のブラウザを見張っています (閉じると鳴ります)')
    expect(wrapper.text()).not.toContain('着信')
    expect(wrapper.find('.bg-green-100').exists()).toBe(true)
    wrapper.unmount()
  })

  it('接続ボタンでポート許可を求める', async () => {
    const wrapper = await mountSuspended(ManagerAlarmBar)
    await wrapper.find('button').trigger('click')
    expect(alarmMock.requestPort).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})
