import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ref, readonly, nextTick, defineComponent } from 'vue'
import type { VueWrapper } from '@vue/test-utils'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import IndexPage from '~/pages/index.vue'
import NormalMeasurement from '~/components/NormalMeasurement.vue'
import TodayPunchHistory from '~/components/TodayPunchHistory.vue'
import BloodPressureMeasurement from '~/components/BloodPressureMeasurement.vue'
import IcPunchAlcoholPrompt from '~/components/IcPunchAlcoholPrompt.vue'
import DeviceUnregisteredBanner from '~/components/DeviceUnregisteredBanner.vue'
import DeviceSettings from '~/components/DeviceSettings.vue'
import ScreenShareSender from '~/components/ScreenShareSender.vue'
import MeasurementLog from '~/components/MeasurementLog.vue'
import type { LatestPunch } from '~/types'

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

// 見張りと関係の無い全タブ共通の初期化は黙らせる。
// sync/isSyncing は下の「実物を繋いだ回帰テスト」で NormalMeasurement (実物) が使う
mockNuxtImport('useFaceSync', () => () => ({
  isSyncing: ref(false),
  sync: vi.fn(async () => {}),
}))
mockNuxtImport('useAuth', () => () => ({
  accessToken: ref(null),
  isAuthenticated: ref(false),
  deviceTenantId: ref(null),
  refreshAccessToken: vi.fn(async () => false),
  handleLineworksHash: vi.fn(),
  activateFromRegistration: vi.fn(),
}))

// --- 以下は NormalMeasurement / NfcStatus / IcPunchAlcoholPrompt を実物のまま繋ぐ
// 回帰テスト用のモック (Refs ippoan/rust-alc-api#644)。他の describe は引き続き
// shallow stub (below-card slot だけを描く手書きの stub) を使うので、実物を要求する
// 依存だけをここでまとめてモックする (NormalMeasurement.test.ts / NfcStatus.test.ts と同じ形)

// index.vue / TodayPunchHistory (自動 stub 経由でも読み込まれる) など他の実物も
// このモジュールを import するので、`importOriginal` で残りの export はそのまま残す
// initApi は**本物をそのまま呼ぶ**が、渡された getter の顔ぶれだけ控える
// (測定台の getter を通常端末に渡していないことを固定する。Refs ippoan/alc-app#353)
const initApiSpy = vi.hoisted(() => vi.fn())

vi.mock('~/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/utils/api')>()
  return {
    ...actual,
    initApi: (...args: Parameters<typeof actual.initApi>) => {
      initApiSpy(...args)
      return actual.initApi(...args)
    },
    getEmployeeByNfcId: vi.fn(async () => ({ id: 'emp-1', name: '山田太郎', face_approval_status: 'approved' })),
    getEmployeeByCode: vi.fn(async () => ({ id: 'emp-1', name: '山田太郎', face_approval_status: 'approved' })),
    punchTimecard: vi.fn(async () => {}),
    startMeasurement: vi.fn(async () => ({ id: 'measurement-1' })),
    updateMeasurement: vi.fn(async () => ({})),
    uploadBlowVideo: vi.fn(async () => 'https://example.com/blow.webm'),
    lookupCarInspection: vi.fn(async () => null),
  }
})

vi.mock('~/utils/face-approval', () => ({
  checkFaceApproval: vi.fn(() => null),
}))

vi.mock('~/utils/video-store', () => ({
  saveVideo: vi.fn(async () => 'video-1'),
  markVideoUploaded: vi.fn(async () => {}),
  getPendingVideos: vi.fn(async () => []),
  cleanupOldVideos: vi.fn(async () => {}),
}))

// WebSerial 分岐は使わない (この回帰テストの関心はタッチ枠のスロット差し替えだけ)
vi.mock('~/utils/webserial', () => ({
  isWebSerialSupported: () => false,
}))

mockNuxtImport('useOfflineSync', () => () => ({
  isOnline: ref(true),
  pending: ref(0),
  isSyncing: ref(false),
  save: vi.fn(),
  syncQueue: vi.fn(),
}))

mockNuxtImport('useCamera', () => () => ({
  stream: ref(null),
  videoRef: ref(null),
  isActive: ref(false),
  start: vi.fn(async () => {}),
  stop: vi.fn(),
}))

mockNuxtImport('useVideoRecorder', () => () => ({
  isRecording: ref(false),
  startRecording: vi.fn(),
  stopRecording: vi.fn(async () => null),
}))

mockNuxtImport('useBleGateway', () => () => ({
  latestTemperature: ref(null),
  latestBloodPressure: ref(null),
}))

mockNuxtImport('useCoreS3Stage', () => () => ({
  syncStep: vi.fn(),
  sendResult: vi.fn(),
}))

// 本人確認前のアルコール測定の通知 (Refs ippoan/rust-alc-api#644、#287)。この回帰テストの
// 関心は IC 打刻のボタンだけなので、モーダルが出ない (latest: null) ようにしておく
mockNuxtImport('useStrayAlcohol', () => () => ({
  latest: ref(null),
}))

// NormalMeasurement (onEvent) と NfcStatus (isConnected/requestPort/...) の
// 両方から呼ばれるので、両方の形を 1 つのモックにまとめる
mockNuxtImport('useCoreS3Serial', () => () => ({
  onEvent: vi.fn(() => vi.fn()),
  isConnected: ref(false),
  requestPort: vi.fn(async () => true),
  startupProbe: vi.fn(async () => false),
  isStartupProbing: ref(false),
}))

mockNuxtImport('useNfcReader', () => () => ({
  isConnected: ref(false),
  error: ref<string | null>(null),
  readers: ref<string[]>([]),
  bridgeVersion: ref<string | null>(null),
  connect: vi.fn(),
  onRead: vi.fn(),
  onLicenseRead: vi.fn(),
}))

mockNuxtImport('useNfcBridgeUpdate', () => () => ({
  latestVersion: ref<string | null>(null),
  checkLatestVersion: vi.fn(async () => {}),
  isUpdateAvailable: vi.fn(() => false),
}))

mockNuxtImport('useKioskAccess', () => () => ({
  isCheckingKioskAccess: ref(false),
}))

// NormalMeasurement は below-card slot (本日の打刻履歴) を実際に描く必要があるため、
// 自動 shallow stub (named slot を描かない) ではなく手書きの stub に差し替える。
// TodayPunchHistory 側は自動 stub のまま — 「slot の中に出る」ことを DOM の入れ子で確かめる
const NormalMeasurementStub = {
  name: 'NormalMeasurement',
  template: '<div class="normal-measurement-stub"><slot name="below-card" /></div>',
}

function mountIndex(route: string, normalMeasurementStub: unknown = NormalMeasurementStub) {
  return mountSuspended(IndexPage, {
    route,
    shallow: true,
    global: { stubs: { ManagerAlarmBar: false, ClientOnly: false, NormalMeasurement: normalMeasurementStub } },
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

describe('pages/index — 本日の打刻履歴 (TodayPunchHistory) を通常点呼のカードの下に出す (Refs ippoan/alc-app#238, ippoan/alc-app-s3#135)', () => {
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

  it('タブレット (Android UA) でも本日の打刻履歴を出す — タイムカードタブ廃止で打刻の口がここだけになるため (Refs ippoan/alc-app-s3#135)', async () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 14)', configurable: true })
    wrapper = await mountIndex('/?role=driver')
    expect(wrapper.findComponent(NormalMeasurement).exists()).toBe(true)
    expect(wrapper.findComponent(TodayPunchHistory).exists()).toBe(true)
  })

  it('通常点呼タブ以外 (点呼) では PC でも本日の打刻履歴を出さない', async () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', configurable: true })
    wrapper = await mountIndex('/?role=driver&tab=tenko')
    expect(wrapper.findComponent(TodayPunchHistory).exists()).toBe(false)
  })
})

describe('pages/index — 血圧測定タブ (Refs ippoan/alc-app-s3#135)', () => {
  let wrapper: VueWrapper | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  /** 血圧端末の manifest。start_url を実物から読み、インストール後の起動を再現する */
  function bpManifest() {
    return JSON.parse(
      readFileSync(resolve(import.meta.dirname!, '../../public/manifest-bp.webmanifest'), 'utf-8'),
    )
  }

  it('(manifest) 血圧端末の manifest で開くと血圧測定タブが出る', async () => {
    wrapper = await mountIndex(bpManifest().start_url)
    expect(wrapper.findComponent(BloodPressureMeasurement).exists()).toBe(true)
    // 通常点呼のカードは出ない — 血圧しか測らない端末
    expect(wrapper.find('.normal-measurement-stub').exists()).toBe(false)
  })

  it('運行者の既定のタブ (?role=driver) では血圧測定タブは出ない', async () => {
    wrapper = await mountIndex('/?role=driver')
    expect(wrapper.findComponent(BloodPressureMeasurement).exists()).toBe(false)
    expect(wrapper.find('.normal-measurement-stub').exists()).toBe(true)
  })

  it('ハンバーガーメニューから血圧測定タブへ移れる', async () => {
    wrapper = await mountIndex('/?role=driver')
    // ハンバーガー (3 本線のアイコン) を開く
    const hamburger = wrapper.findAll('button').find(b => b.html().includes('M4 6h16M4 12h16M4 18h16'))
    expect(hamburger).toBeTruthy()
    await hamburger!.trigger('click')
    await nextTick()

    const item = wrapper.findAll('button').find(b => b.text() === '血圧測定')
    expect(item).toBeTruthy()
    await item!.trigger('click')
    await nextTick()
    expect(wrapper.findComponent(BloodPressureMeasurement).exists()).toBe(true)
  })

  it('通常端末がハンバーガーで血圧測定タブを選んでからリロードしても (?tab=bp のみ、station 無し) 点呼まわりの部品は消えない (Refs ippoan/alc-app#353、裏取りで発覚)', async () => {
    // URL 同期が書く `?tab=bp` はどの端末でも起きる。`station` が無ければ測定台とは判定しない
    wrapper = await mountIndex('/?role=driver&tab=bp')
    expect(wrapper.findAll('button').some(b => b.text() === '運行管理者')).toBe(true)
    expect(wrapper.findAll('button').some(b => b.text() === '通常点呼')).toBe(true)
    expect(wrapper.findAll('button').some(b => b.text() === '自動点呼')).toBe(true)
    expect(wrapper.findAll('button').some(b => b.text() === '遠隔点呼')).toBe(true)
    expect(wrapper.findAll('button').some(b => b.html().includes('M4 6h16M4 12h16M4 18h16'))).toBe(true)
    expect(wrapper.findComponent(DeviceUnregisteredBanner).exists()).toBe(true)
    expect(wrapper.findComponent(ScreenShareSender).exists()).toBe(true)
    expect(wrapper.findComponent(MeasurementLog).exists()).toBe(true)
    // tab=bp のとおり血圧測定タブ自体は出る (通常端末の1タブとして)
    expect(wrapper.findComponent(BloodPressureMeasurement).exists()).toBe(true)
  })

  it('測定台 (?station=bp) のときだけ測定台の device JWT getter を initApi に渡す (Refs ippoan/alc-app#353)', async () => {
    // `scope: 'bp-station'` を付けた 4 本は**点呼と共用**なので、通常端末にこの getter を
    // 渡すと ATOM S3 の無い端末で点呼の口が落ちる。渡すのは測定台として開いた画面だけ
    initApiSpy.mockClear()
    wrapper = await mountIndex('/?role=driver&tab=bp')
    expect(initApiSpy).toHaveBeenCalledTimes(1)
    expect(initApiSpy.mock.calls[0]![6]).toBeUndefined()
    wrapper.unmount()

    initApiSpy.mockClear()
    wrapper = await mountIndex(bpManifest().start_url)
    expect(initApiSpy).toHaveBeenCalledTimes(1)
    expect(typeof initApiSpy.mock.calls[0]![6]).toBe('function')
  })

  it('(manifest) 血圧端末の manifest (?tab=bp&station=bp) で開いても、点呼まわりの部品を出す (Refs ippoan/alc-app#353)', async () => {
    // 詰まったときに人が自力で抜けられるように nav を残す。以前は測定台だけ nav を隠していたが、
    // デバイス設定への道も一緒に消え、「血圧計が見つかりません」で止まると押せるものが何も無かった
    wrapper = await mountIndex(bpManifest().start_url)
    // ロールタブ (運行者/運行管理者/システム管理者/汎用管理)
    expect(wrapper.findAll('button').some(b => b.text() === '運行管理者')).toBe(true)
    // 端末未登録バナー
    expect(wrapper.findComponent(DeviceUnregisteredBanner).exists()).toBe(true)
    // 点呼サブタブ (通常点呼/自動点呼/遠隔点呼)
    expect(wrapper.findAll('button').some(b => b.text() === '通常点呼')).toBe(true)
    expect(wrapper.findAll('button').some(b => b.text() === '自動点呼')).toBe(true)
    expect(wrapper.findAll('button').some(b => b.text() === '遠隔点呼')).toBe(true)
    // ハンバーガーメニュー (3 本線アイコン) — ここからデバイス設定 (USB 許可) へ入れる
    expect(wrapper.findAll('button').some(b => b.html().includes('M4 6h16M4 12h16M4 18h16'))).toBe(true)
    // 画面共有・測定ログ
    expect(wrapper.findComponent(ScreenShareSender).exists()).toBe(true)
    expect(wrapper.findComponent(MeasurementLog).exists()).toBe(true)
    // 血圧測定は start_url の tab=bp のとおり出る。1 つだけ (測定台専用の別描画は無い)
    expect(wrapper.findAllComponents(BloodPressureMeasurement)).toHaveLength(1)
  })

  it('測定台 (?station=bp) でもハンバーガーからデバイス設定へ辿り着ける (行き止まりにならない) (Refs ippoan/alc-app#353)', async () => {
    wrapper = await mountIndex(bpManifest().start_url)
    const hamburger = wrapper.findAll('button').find(b => b.html().includes('M4 6h16M4 12h16M4 18h16'))
    expect(hamburger).toBeTruthy()
    await hamburger!.trigger('click')
    await nextTick()

    const item = wrapper.findAll('button').find(b => b.text() === 'デバイス設定')
    expect(item).toBeTruthy()
    await item!.trigger('click')
    await nextTick()
    expect(wrapper.findComponent(DeviceSettings).exists()).toBe(true)
    // 血圧測定タブは切り替わって消える
    expect(wrapper.findComponent(BloodPressureMeasurement).exists()).toBe(false)
  })
})

describe('pages/index — IC カードの打刻からアルコールチェックへ (Refs ippoan/rust-alc-api#644)', () => {
  let wrapper: VueWrapper | null = null

  // NormalMeasurement は「待機中か」と「社員を指定して始める入口」を defineExpose する。
  // index はその 2 つだけを使うので、stub も同じ 2 つを expose する。
  // below-card slot と nfc-punch-prompt slot (NFC のタッチ枠の中) を見分けられるよう、
  // それぞれ別の要素に描く
  const startForEmployeeMock = vi.fn(async () => true)
  const stubIsIdle = ref(true)
  const NormalMeasurementExposeStub = defineComponent({
    name: 'NormalMeasurement',
    props: { icPromptActive: { type: Boolean, default: false } },
    setup(_props, { expose }) {
      expose({ isIdle: stubIsIdle, startForEmployee: startForEmployeeMock })
    },
    template: '<div class="normal-measurement-stub"><div class="nfc-touch-area"><slot name="nfc-punch-prompt" /></div><div class="below-card-area"><slot name="below-card" /></div></div>',
  })

  function punchOf(over: Partial<LatestPunch> = {}): LatestPunch {
    return {
      id: 'punch-1',
      employeeId: 'emp-1',
      name: '山田太郎',
      cardKind: 'other',
      punchedAt: new Date().toISOString(),
      ...over,
    }
  }

  /** TodayPunchHistory (自動 stub) が引き直しで上げてくる最新行を流す */
  async function emitLatest(w: VueWrapper, punch: LatestPunch | null) {
    w.findComponent(TodayPunchHistory).vm.$emit('latest', punch)
    await nextTick()
  }

  beforeEach(() => {
    startForEmployeeMock.mockClear()
    stubIsIdle.value = true
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('IcPunchAlcoholPrompt は NFC のタッチ枠の中に出る（below-card ではない）', async () => {
    wrapper = await mountIndex('/?role=driver', NormalMeasurementExposeStub)
    const touchArea = wrapper.find('.nfc-touch-area')
    const belowCard = wrapper.find('.below-card-area')
    const prompt = wrapper.findComponent(IcPunchAlcoholPrompt)
    // NormalMeasurement の状態機械の中ではなく、NFC のタッチ枠 (nfc-punch-prompt slot) に置く。
    // below-card (打刻履歴) には出ない
    expect(touchArea.findComponent(IcPunchAlcoholPrompt).exists()).toBe(true)
    expect(belowCard.findComponent(IcPunchAlcoholPrompt).exists()).toBe(false)
    expect(prompt.props('punch')).toBeNull()

    const punch = punchOf()
    await emitLatest(wrapper, punch)
    expect(wrapper.findComponent(IcPunchAlcoholPrompt).props('punch')).toEqual(punch)
  })

  it('IcPunchAlcoholPrompt の active emit を icPromptActive として NormalMeasurement へ渡す', async () => {
    wrapper = await mountIndex('/?role=driver', NormalMeasurementExposeStub)
    const normalMeasurement = wrapper.findComponent(NormalMeasurementExposeStub)
    expect(normalMeasurement.props('icPromptActive')).toBe(false)

    wrapper.findComponent(IcPunchAlcoholPrompt).vm.$emit('active', true)
    await nextTick()
    expect(wrapper.findComponent(NormalMeasurementExposeStub).props('icPromptActive')).toBe(true)

    wrapper.findComponent(IcPunchAlcoholPrompt).vm.$emit('active', false)
    await nextTick()
    expect(wrapper.findComponent(NormalMeasurementExposeStub).props('icPromptActive')).toBe(false)
  })

  it('通常点呼が待機中かどうかをそのまま渡す (測定中は出させない)', async () => {
    wrapper = await mountIndex('/?role=driver', NormalMeasurementExposeStub)
    expect(wrapper.findComponent(IcPunchAlcoholPrompt).props('idle')).toBe(true)

    stubIsIdle.value = false
    await nextTick()
    expect(wrapper.findComponent(IcPunchAlcoholPrompt).props('idle')).toBe(false)
  })

  it('押されたら (start) その社員で測定を始める — 打刻はしない入口を使う', async () => {
    wrapper = await mountIndex('/?role=driver', NormalMeasurementExposeStub)
    await emitLatest(wrapper, punchOf())

    wrapper.findComponent(IcPunchAlcoholPrompt).vm.$emit('start', punchOf())
    await nextTick()

    expect(startForEmployeeMock).toHaveBeenCalledTimes(1)
    expect(startForEmployeeMock).toHaveBeenCalledWith('emp-1', '山田太郎')
  })

  it('社員が解決できていない打刻では測定を始めない', async () => {
    wrapper = await mountIndex('/?role=driver', NormalMeasurementExposeStub)
    const punch = punchOf({ employeeId: null, name: '未登録カード 0123' })
    await emitLatest(wrapper, punch)

    wrapper.findComponent(IcPunchAlcoholPrompt).vm.$emit('start', punch)
    await nextTick()

    expect(startForEmployeeMock).not.toHaveBeenCalled()
  })

  it('通常点呼タブ以外 (点呼) では導線も出さない', async () => {
    wrapper = await mountIndex('/?role=driver&tab=tenko', NormalMeasurementExposeStub)
    expect(wrapper.findComponent(IcPunchAlcoholPrompt).exists()).toBe(false)
  })
})

describe('pages/index — IC カードの打刻でタッチ枠にボタンが実際に出る (実物を繋いだ回帰テスト、Refs ippoan/rust-alc-api#644)', () => {
  let wrapper: VueWrapper | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  function icPunch(): LatestPunch {
    return {
      id: 'punch-1',
      employeeId: 'emp-1',
      name: '山田太郎',
      cardKind: 'other',
      punchedAt: new Date().toISOString(),
    }
  }

  /**
   * `NormalMeasurement` / `NfcStatus` / `IcPunchAlcoholPrompt` を stub に差し替えず実物のまま繋ぐ。
   * **`promptActive` を手で立てない** — スロットの中身 (`IcPunchAlcoholPrompt`) が自分で
   * `active` を emit し、それが `NfcStatus` の `promptActive` に届いて初めてボタンが描画される、
   * という実際の経路をここで踏む。`NfcStatus` 側で `punch-prompt` スロットを `v-if="promptActive"`
   * で包むと、マウントされない → emit されない → 永久に `false` のままの鶏と卵になり、
   * 本番で実際にこの不具合が起きた (Refs ippoan/rust-alc-api#644)
   */
  it('IC カードの打刻があるとき、タッチ枠にボタンが出る (スロットが v-if で包まれていない)', async () => {
    wrapper = await mountSuspended(IndexPage, {
      route: '/?role=driver',
      shallow: true,
      global: {
        stubs: {
          ManagerAlarmBar: false,
          ClientOnly: false,
          NormalMeasurement: false,
          NfcStatus: false,
          IcPunchAlcoholPrompt: false,
        },
      },
    })

    wrapper.findComponent(TodayPunchHistory).vm.$emit('latest', icPunch())
    await nextTick()
    await nextTick()

    expect(wrapper.find('[data-testid="ic-punch-alcohol"]').exists()).toBe(true)
  })
})
