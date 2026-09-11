import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, readonly, nextTick } from 'vue'
import type { VueWrapper } from '@vue/test-utils'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import IndexPage from '~/pages/index.vue'
import NormalMeasurement from '~/components/NormalMeasurement.vue'
import TodayPunchHistory from '~/components/TodayPunchHistory.vue'

// トップ画面のうち「警告デバイスの見張りをロールタブに関わらず始める」部分だけを見る (Refs #231)。
// useAlarmWatch は本物、その下の singleton (デバイス / 着信購読 / 設定) だけをモックして
// 呼び順を 1 本の配列に記録する。子コンポーネントは ManagerAlarmBar 以外 stub

const calls: string[] = []

const alarmState = {
  isConnected: ref(false),
  deviceState: ref<{ state: 'idle' | 'alarming' | 'muted'; cause: string } | null>(null),
}
mockNuxtImport('useAlarmDevice', () => () => ({
  isSupported: true,
  isConnected: readonly(alarmState.isConnected),
  deviceState: readonly(alarmState.deviceState),
  connect: (delay: number) => { calls.push(`connect(${delay})`) },
  disconnect: async () => { calls.push('disconnect') },
  requestPort: async () => {},
  notifyIntentionalReload: () => {},
}))

const roomsState = {
  isWatching: ref(false),
  activeRooms: ref<string[]>([]),
  joinedRoomId: ref<string | null>(null),
}
mockNuxtImport('useActiveRooms', () => () => ({
  isWatching: readonly(roomsState.isWatching),
  activeRooms: readonly(roomsState.activeRooms),
  joinedRoomId: readonly(roomsState.joinedRoomId),
  start: () => { calls.push('start') },
  stop: () => { calls.push('stop') },
  setJoined: vi.fn(),
  reload: vi.fn(async () => true),
}))

const enabled = ref<boolean | null>(true)
mockNuxtImport('useAlarmDeviceSetting', () => () => ({
  enabled: readonly(enabled),
  setEnabled: (v: boolean) => { enabled.value = v },
}))

// 見張りと関係の無い全タブ共通の初期化は黙らせる
mockNuxtImport('useFaceSync', () => () => ({}))
mockNuxtImport('useAuth', () => () => ({
  accessToken: ref(null),
  isAuthenticated: ref(false),
  deviceTenantId: ref(null),
  refreshAccessToken: vi.fn(async () => false),
  handleLineworksHash: vi.fn(),
  activateFromRegistration: vi.fn(),
}))

// NormalMeasurement は below-card slot (本日の打刻履歴) を実際に描く必要があるため、
// 自動 shallow stub (named slot を描かない) ではなく手書きの stub に差し替える。
// TodayPunchHistory 側は自動 stub のまま — 「slot の中に出る」ことを DOM の入れ子で確かめる
const NormalMeasurementStub = {
  name: 'NormalMeasurement',
  template: '<div class="normal-measurement-stub"><slot name="below-card" /></div>',
}

function mountIndex(route: string) {
  return mountSuspended(IndexPage, {
    route,
    shallow: true,
    global: { stubs: { ManagerAlarmBar: false, ClientOnly: false, NormalMeasurement: NormalMeasurementStub } },
  })
}

function roleButton(wrapper: VueWrapper, label: string) {
  const button = wrapper.findAll('button').find(b => b.text() === label)
  if (!button) throw new Error(`role tab not found: ${label}`)
  return button
}

async function clickRole(wrapper: VueWrapper, label: string) {
  await roleButton(wrapper, label).trigger('click')
  await nextTick()
}

describe('pages/index — 警告デバイスの見張り', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    calls.length = 0
    enabled.value = true
    alarmState.isConnected.value = false
    alarmState.deviceState.value = null
    roomsState.isWatching.value = false
    roomsState.activeRooms.value = []
    roomsState.joinedRoomId.value = null
  })

  afterEach(async () => {
    // 「始めたか」は module スコープなので、次のテストへ持ち越さないよう設定 off で止めてから外す
    enabled.value = false
    await nextTick()
    wrapper?.unmount()
    wrapper = null
  })

  it('運行者タブ (?role=driver) で開いても、設定 on なら着信購読 → 接続の順に対で始まる', async () => {
    wrapper = await mountIndex('/?role=driver')
    expect(roleButton(wrapper, '運行者').classes()).toContain('bg-white')
    // 運行管理者タブのバーは出ていない = バーの mount を待たずに始まっている
    expect(wrapper.find('[data-testid="manager-alarm-bar"]').exists()).toBe(false)
    expect(calls).toEqual(['start', 'connect(0)'])
  })

  it('ロールタブを切り替えても切れず、運行管理者タブのバーは二重に始めない。設定 off で対で止まる', async () => {
    wrapper = await mountIndex('/?role=driver')
    expect(calls).toEqual(['start', 'connect(0)'])

    await clickRole(wrapper, '運行管理者')
    expect(wrapper.find('[data-testid="manager-alarm-bar"]').exists()).toBe(true)
    await clickRole(wrapper, 'システム管理者')
    expect(wrapper.find('[data-testid="manager-alarm-bar"]').exists()).toBe(false)
    await clickRole(wrapper, '運行者')
    expect(calls).toEqual(['start', 'connect(0)'])

    enabled.value = false
    await nextTick()
    expect(calls).toEqual(['start', 'connect(0)', 'disconnect', 'stop'])
  })

  it('設定 off の端末では運行者タブでも運行管理者タブでも何も始めない', async () => {
    enabled.value = false
    wrapper = await mountIndex('/?role=driver')
    expect(calls).toEqual([])

    await clickRole(wrapper, '運行管理者')
    expect(calls).toEqual([])
  })

  it('トップ画面を離れて戻っても (再 mount) 止めず、二重に始めない', async () => {
    const first = await mountIndex('/?role=driver')
    first.unmount()
    expect(calls).toEqual(['start', 'connect(0)'])

    wrapper = await mountIndex('/?role=manager')
    expect(calls).toEqual(['start', 'connect(0)'])
  })
})

describe('pages/index — 本日の打刻履歴 (TodayPunchHistory) を通常点呼のカードの下に出すのは PC だけ (Refs ippoan/alc-app#238)', () => {
  let wrapper: VueWrapper | null = null
  const originalUserAgent = navigator.userAgent

  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', { value: originalUserAgent, configurable: true })
    wrapper?.unmount()
    wrapper = null
  })

  it('PC (Android/iPhone/iPad でない UA) では通常点呼の below-card slot に本日の打刻履歴を出す', async () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', configurable: true })
    wrapper = await mountIndex('/?role=driver')
    const normalMeasurement = wrapper.find('.normal-measurement-stub')
    expect(normalMeasurement.exists()).toBe(true)
    expect(wrapper.findComponent(TodayPunchHistory).exists()).toBe(true)
    // 「顔登録」「メンテナンス」を画面最下部に保つため below-card slot に入れる設計
    // (Refs ippoan/alc-app#238) — 兄弟ではなく NormalMeasurement (stub) の**中**にあることを確かめる
    expect(normalMeasurement.findComponent(TodayPunchHistory).exists()).toBe(true)
    // #248 のラッパー div はもう無い — NormalMeasurement 自身の class に flex-1 min-h-0 が付く
    // (他の driverSubTab 兄弟 (TenkoKiosk 等) と同じパターンに戻した)
    expect(normalMeasurement.classes()).toContain('flex-1')
    expect(normalMeasurement.classes()).toContain('min-h-0')
  })

  it('Android では本日の打刻履歴を出さない (通常点呼のみ)', async () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 14)', configurable: true })
    wrapper = await mountIndex('/?role=driver')
    expect(wrapper.findComponent(NormalMeasurement).exists()).toBe(true)
    expect(wrapper.findComponent(TodayPunchHistory).exists()).toBe(false)
  })

  it('通常点呼タブ以外 (点呼) では PC でも本日の打刻履歴を出さない', async () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', configurable: true })
    wrapper = await mountIndex('/?role=driver&tab=tenko')
    expect(wrapper.findComponent(TodayPunchHistory).exists()).toBe(false)
  })
})
