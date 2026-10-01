import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ref, readonly, computed, nextTick, defineComponent } from 'vue'
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
import DevDeviceRecords from '~/components/DevDeviceRecords.vue'
import TenkoKiosk from '~/components/TenkoKiosk.vue'
import { clearDevDeviceMark, isDevDevice, noteDeviceToken, DEV_DEVICE_MARK_EVENT } from '~/utils/token-selection'
import { devDeviceJwt, plainDeviceJwt } from '../helpers/dummy-jwt'
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
// 測定台の getter を**後から**入れる口 (Refs ippoan/alc-app#368)。名乗りで決着した
// 時点でだけ呼ばれていること / 未確定とキオスクでは呼ばれないことを固定する
const setBpStationJwtGetterSpy = vi.hoisted(() => vi.fn())

vi.mock('~/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/utils/api')>()
  return {
    ...actual,
    initApi: (...args: Parameters<typeof actual.initApi>) => {
      initApiSpy(...args)
      return actual.initApi(...args)
    },
    setBpStationJwtGetter: (...args: Parameters<typeof actual.setBpStationJwtGetter>) => {
      setBpStationJwtGetterSpy(...args)
      return actual.setBpStationJwtGetter(...args)
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

// 端末の名乗りで決着した機種 (Refs ippoan/alc-app#368)。既定は `null` (未確定) —
// 他の describe は URL だけで測定台を判定していた従来どおりの状態で回る
const arbiterState = {
  arbitratedDeviceKind: ref<'bp-station' | 'other' | null>(null),
}
mockNuxtImport('useSerialArbiter', () => () => ({
  isSupported: false,
  isArbitratedPort: () => false,
  arbitratedDeviceKind: readonly(arbiterState.arbitratedDeviceKind),
  register: vi.fn(),
  unregister: vi.fn(async () => {}),
  release: vi.fn(async () => {}),
  request: vi.fn(async () => ''),
  start: vi.fn(),
  requestPort: vi.fn(async () => false),
}))

// 血圧測定を可視タブに出すかの判定 (`useBpUiEnabled`)。実物は BLE gateway / 署名ボンド /
// 端末認証を読むので、ここでは状態だけ差し替える。既定は `unused` (= 従来どおりハンバーガーだけ)。
// `showBpUi` は実物と同じく `bpUiState === 'show'` から導く
const bpUi = { state: ref<'show' | 'unused' | 'checking' | 'unregistered' | 'unavailable'>('unused') }
mockNuxtImport('useBpUiEnabled', () => () => ({
  bpUiState: readonly(bpUi.state),
  showBpUi: computed(() => bpUi.state.value === 'show'),
}))

// 署名ボンドの読み口 (`useSignedBpBond`)。実物は module スコープに「試し終えたら true」を
// 持つので、ここでは差し替える。既定は「まだ試していない」(= 自動点呼を塞がない)
const signedBond = { probed: ref(false), bonded: ref<boolean | null>(null) }
mockNuxtImport('useSignedBpBond', () => () => ({
  signedBpBonded: readonly(signedBond.bonded),
  hasProbedBpBond: readonly(signedBond.probed),
}))

// Android 横画面 (トップのタブバーが縦画面と別の描画になる)。既定は縦
const landscape = { on: ref(false) }
mockNuxtImport('useAndroidLandscape', () => () => ({
  isAndroidLandscape: readonly(landscape.on),
}))

// 測定台の device JWT。実物は ATOM S3 へ `AUTH SIGNBP` を撃つので、呼ばれた回数だけ見る
const bpStationToken = { jwtCalls: 0 }
mockNuxtImport('useBpStationDeviceToken', () => () => ({
  getBpStationJwt: async () => {
    bpStationToken.jwtCalls += 1
    return 'bp-station.jwt'
  },
  lastError: ref<string | null>(null),
  lastFailureStage: ref<string | null>(null),
  lastFailureStatus: ref<number | null>(null),
  backoffUntil: ref(0),
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

describe('pages/index — 血圧測定を可視タブに出す (Refs ippoan/alc-app#373)', () => {
  // 血圧しか測らない端末が、測りに行くたびにハンバーガーを開かされていた。`bpUiState === 'show'`
  // (BloodPressureMeasurement が中身を出せる状態と同じ述語) の端末では可視タブへ、
  // それ以外は従来どおりハンバーガーへ。**2 か所に同じ導線を出さない** (排他)

  let wrapper: VueWrapper | null = null
  const HAMBURGER = 'M4 6h16M4 12h16M4 18h16'

  beforeEach(() => {
    bpUi.state.value = 'unused'
    landscape.on.value = false
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    bpUi.state.value = 'unused'
    landscape.on.value = false
  })

  /** 可視のサブタブ (縦: 青いタブ行 / 横: トップのタブバー) の文言 */
  function visibleTabLabels(w: VueWrapper) {
    const row = w.find(landscape.on.value ? '.border-b.bg-gray-50' : '.bg-blue-100')
    return row.findAll('button').map(b => b.text()).filter(t => ['通常点呼', '自動点呼', '遠隔点呼', '血圧測定'].includes(t))
  }

  function hamburgerButton(w: VueWrapper) {
    const b = w.findAll('button').find(x => x.html().includes(HAMBURGER))
    if (!b) throw new Error('hamburger not found')
    return b
  }

  /** ハンバーガーを開いて、メニュー内のタブ (デモ・設定・血圧) の文言を返す */
  async function menuTabLabels(w: VueWrapper) {
    await hamburgerButton(w).trigger('click')
    await nextTick()
    const menu = w.find('.absolute.right-0')
    return menu.findAll('button').map(b => b.text()).filter(t => ['自動点呼デモ', '遠隔点呼デモ', 'デバイス設定', '血圧測定'].includes(t))
  }

  describe.each([
    { name: '縦画面', isLandscape: false },
    { name: 'Android 横画面', isLandscape: true },
  ])('$name', ({ isLandscape }) => {
    beforeEach(() => { landscape.on.value = isLandscape })

    it('bpUiState が show なら可視タブに「血圧測定」が出て、ハンバーガーには出ない', async () => {
      bpUi.state.value = 'show'
      wrapper = await mountIndex('/?role=driver')

      expect(visibleTabLabels(wrapper)).toEqual(['通常点呼', '自動点呼', '遠隔点呼', '血圧測定'])
      // 排他: 同じ導線が 2 か所に出ない。デモ・設定は従来どおり残る
      expect(await menuTabLabels(wrapper)).toEqual(['自動点呼デモ', '遠隔点呼デモ', 'デバイス設定'])
    })

    it.each(['unused', 'checking'] as const)('bpUiState が %s なら可視タブには出ず、ハンバーガーにだけ出る', async (state) => {
      bpUi.state.value = state
      wrapper = await mountIndex('/?role=driver')

      expect(visibleTabLabels(wrapper)).toEqual(['通常点呼', '自動点呼', '遠隔点呼'])
      expect(await menuTabLabels(wrapper)).toEqual(['自動点呼デモ', '遠隔点呼デモ', 'デバイス設定', '血圧測定'])
    })

    it('可視の「血圧測定」を選ぶと血圧測定が開き、ハンバーガーのアイコンは点灯しない (選択中に見えない)', async () => {
      bpUi.state.value = 'show'
      wrapper = await mountIndex('/?role=driver')
      const litClass = 'bg-blue-600'
      expect(hamburgerButton(wrapper).classes()).not.toContain(litClass)

      const tab = wrapper.findAll('button').find(b => b.text() === '血圧測定')
      await tab!.trigger('click')
      await nextTick()

      expect(wrapper.findComponent(BloodPressureMeasurement).exists()).toBe(true)
      expect(hamburgerButton(wrapper).classes()).not.toContain(litClass)
    })

    it('ハンバーガー側の血圧測定 (show でない端末) を選ぶと、従来どおりアイコンが点灯する', async () => {
      bpUi.state.value = 'unused'
      wrapper = await mountIndex('/?role=driver')
      await menuTabLabels(wrapper)
      const item = wrapper.find('.absolute.right-0').findAll('button').find(b => b.text() === '血圧測定')
      await item!.trigger('click')
      await nextTick()

      expect(wrapper.findComponent(BloodPressureMeasurement).exists()).toBe(true)
      expect(hamburgerButton(wrapper).classes()).toContain('bg-blue-600')
    })
  })

  it('血圧を選んだまま show でなくなっても、導線はハンバーガーに移るだけで消えない (行き止まりにならない)', async () => {
    bpUi.state.value = 'show'
    wrapper = await mountIndex('/?role=driver&tab=bp')
    expect(visibleTabLabels(wrapper)).toContain('血圧測定')

    bpUi.state.value = 'unavailable'
    await nextTick()

    expect(visibleTabLabels(wrapper)).toEqual(['通常点呼', '自動点呼', '遠隔点呼'])
    expect(await menuTabLabels(wrapper)).toContain('血圧測定')
  })

  // 判定待ち (`checking`) は probe が決着するまで最大 8 秒続く。測定台は `?station=bp` 無しで
  // 開くと必ずここを通り、画面は「血圧測定」なのにタブ行に無く、選択中の印がハンバーガーに付いた
  // (Refs ippoan/alc-app#376)。**`bp` だけの規則** — 他のタブはメニュー側に留まる
  describe('判定待ち (checking) のあいだ (Refs ippoan/alc-app#376)', () => {
    it('血圧測定の画面を開いているなら、可視タブに「血圧測定」が出て、ハンバーガーには出ない', async () => {
      bpUi.state.value = 'checking'
      wrapper = await mountIndex('/?role=driver&tab=bp')

      expect(wrapper.findComponent(BloodPressureMeasurement).exists()).toBe(true)
      expect(visibleTabLabels(wrapper)).toEqual(['通常点呼', '自動点呼', '遠隔点呼', '血圧測定'])
      // 排他: 同じ導線が 2 か所に出ない。選択中の印もハンバーガーには付かない
      expect(hamburgerButton(wrapper).classes()).not.toContain('bg-blue-600')
      expect(await menuTabLabels(wrapper)).toEqual(['自動点呼デモ', '遠隔点呼デモ', 'デバイス設定'])
    })

    it('血圧測定の画面に居なければ、従来どおり可視タブには出ず、ハンバーガーにだけ出る', async () => {
      bpUi.state.value = 'checking'
      wrapper = await mountIndex('/?role=driver')

      expect(wrapper.findComponent(BloodPressureMeasurement).exists()).toBe(false)
      expect(visibleTabLabels(wrapper)).toEqual(['通常点呼', '自動点呼', '遠隔点呼'])
      expect(await menuTabLabels(wrapper)).toEqual(['自動点呼デモ', '遠隔点呼デモ', 'デバイス設定', '血圧測定'])
    })
  })
})

describe('pages/index — 測定台かどうかを端末の名乗りで決める (Refs ippoan/alc-app#368)', () => {
  // 「測定台はこの長い URL で開いてください」を配る運用をやめるのが目的。端末は
  // `DEVICE bp-station` と自分で名乗っているので、ハンバーガーの「血圧測定」から入った
  // 画面 (= `?station=bp` 無し) でも測定台として動く。ここで固定するのは 4 つ:
  //
  //   1. `station` 無しの URL でも、名乗りで決着したら測定台の鍵を使う
  //   2. **未確定のあいだは入れない** (キオスクへ倒れない = 点呼 4 本を落とさない)
  //   3. CoreS3 キオスク (`other`) では入れない
  //   4. `?station=bp` 付きの既存 URL は従来どおり起動時から測定台

  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    arbiterState.arbitratedDeviceKind.value = null
    bpStationToken.jwtCalls = 0
    initApiSpy.mockClear()
    setBpStationJwtGetterSpy.mockClear()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    arbiterState.arbitratedDeviceKind.value = null
  })

  it('★ ?station=bp の無い URL (/?role=driver&tab=bp) でも、ATOM S3 が名乗れば測定台の鍵を使う', async () => {
    wrapper = await mountIndex('/?role=driver&tab=bp')
    // 起動時は未確定 — initApi にも渡さず、後入れもしない
    expect(initApiSpy.mock.calls[0]![6]).toBeUndefined()
    expect(setBpStationJwtGetterSpy).not.toHaveBeenCalled()

    // 数秒後、ATOM S3 が `DEVICE bp-station` と名乗って決着する
    arbiterState.arbitratedDeviceKind.value = 'bp-station'
    await nextTick()

    expect(setBpStationJwtGetterSpy).toHaveBeenCalledTimes(1)
    expect(typeof setBpStationJwtGetterSpy.mock.calls[0]![0]).toBe('function')
    // 入れた getter は測定台の device JWT (ATOM S3 の署名) を返すものであること
    await expect(setBpStationJwtGetterSpy.mock.calls[0]![0]()).resolves.toBe('bp-station.jwt')
    // 決着した時点で 1 本取りに行く (ボンド状態が来ないと血圧の画面が checking のまま止まる)
    expect(bpStationToken.jwtCalls).toBeGreaterThan(0)
  })

  it('★ ハンバーガーの「血圧測定」から入った画面 (URL に印が無い) でも測定台になる', async () => {
    wrapper = await mountIndex('/?role=driver')
    const hamburger = wrapper.findAll('button').find(b => b.html().includes('M4 6h16M4 12h16M4 18h16'))
    await hamburger!.trigger('click')
    await nextTick()
    const item = wrapper.findAll('button').find(b => b.text() === '血圧測定')
    await item!.trigger('click')
    await nextTick()
    expect(wrapper.findComponent(BloodPressureMeasurement).exists()).toBe(true)

    arbiterState.arbitratedDeviceKind.value = 'bp-station'
    await nextTick()
    expect(setBpStationJwtGetterSpy).toHaveBeenCalledTimes(1)
  })

  it('★ 未確定のあいだは測定台の getter を入れない (probe する前にキオスク扱いへ倒さない)', async () => {
    wrapper = await mountIndex('/?role=driver&tab=bp')
    await nextTick()

    // getter が入っていない = `scope: 'bp-station'` の 4 本は従来どおりキオスクの鍵へ素通り。
    // 未確定で入れると fail-closed (#337) がそのまま効いて点呼 4 本が全部落ちる
    expect(setBpStationJwtGetterSpy).not.toHaveBeenCalled()
    expect(initApiSpy.mock.calls[0]![6]).toBeUndefined()
    expect(bpStationToken.jwtCalls).toBe(0)
  })

  it('★ CoreS3 キオスク (other と決着) では測定台の getter を入れない (キオスクは不変)', async () => {
    wrapper = await mountIndex('/?role=driver&tab=bp')
    arbiterState.arbitratedDeviceKind.value = 'other'
    await nextTick()

    expect(setBpStationJwtGetterSpy).not.toHaveBeenCalled()
    expect(bpStationToken.jwtCalls).toBe(0)
  })

  it('?station=bp 付きの既存 URL は従来どおり — 名乗りを待たずに起動時から測定台', async () => {
    wrapper = await mountIndex('/?role=driver&tab=bp&station=bp')

    // initApi に渡す経路は変えていない (既存 URL は 1 ミリも変わらない)
    expect(typeof initApiSpy.mock.calls[0]![6]).toBe('function')
    // 名乗りが `null` (未確定) のままでも測定台として起動している
    expect(arbiterState.arbitratedDeviceKind.value).toBeNull()
    expect(setBpStationJwtGetterSpy).toHaveBeenCalledTimes(1)
    expect(bpStationToken.jwtCalls).toBeGreaterThan(0)
  })

  it('★ 名乗りで測定台になっても URL には station=bp を焼き付けない', async () => {
    // 焼き付けると、ATOM S3 を抜いたあとのリロードで「測定台として開いた」と名乗り続け、
    // ATOM S3 の無い端末で点呼と共用の 4 本が落ちる
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {})
    try {
      wrapper = await mountIndex('/?role=driver')
      arbiterState.arbitratedDeviceKind.value = 'bp-station'
      await nextTick()

      const hamburger = wrapper.findAll('button').find(b => b.html().includes('M4 6h16M4 12h16M4 18h16'))
      await hamburger!.trigger('click')
      await nextTick()
      const item = wrapper.findAll('button').find(b => b.text() === '血圧測定')
      await item!.trigger('click')
      await nextTick()

      expect(replaceState).toHaveBeenCalled()
      for (const call of replaceState.mock.calls) {
        expect(String(call[2])).not.toContain('station')
      }
    }
    finally {
      replaceState.mockRestore()
    }
  })

  it('?station=bp 付きの URL では従来どおり station を引き継ぐ (印が消えない)', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {})
    try {
      wrapper = await mountIndex('/?role=driver&tab=bp&station=bp')
      await clickRole(wrapper, '運行管理者')

      expect(String(replaceState.mock.calls.at(-1)![2])).toContain('station=bp')
    }
    finally {
      replaceState.mockRestore()
    }
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

describe('pages/index — dev端末の記録 (Refs ippoan/alc-app#387)', () => {
  // dev端末 (開発用の鍵) の記録を見る項目は、**キオスクの鍵に dev の印がある端末にだけ**
  // ハンバーガーへ出す。選んでも可視タブ側へは移らない (移るのは血圧タブだけの規則)

  let wrapper: VueWrapper | null = null
  const HAMBURGER = 'M4 6h16M4 12h16M4 18h16'
  const LABEL = '開発用の記録'

  beforeEach(() => {
    bpUi.state.value = 'unused'
    landscape.on.value = false
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    clearDevDeviceMark('kiosk')
    noteDeviceToken('manager-device', null)
    localStorage.clear()
    landscape.on.value = false
  })

  function hamburgerButton(w: VueWrapper) {
    const b = w.findAll('button').find(x => x.html().includes(HAMBURGER))
    if (!b) throw new Error('hamburger not found')
    return b
  }

  /** ハンバーガーを開閉する */
  async function toggleMenu(w: VueWrapper) {
    await hamburgerButton(w).trigger('click')
    await nextTick()
  }

  function menuLabels(w: VueWrapper) {
    return w.find('.absolute.right-0').findAll('button').map(b => b.text())
  }

  function visibleTabLabels(w: VueWrapper) {
    const row = w.find(landscape.on.value ? '.border-b.bg-gray-50' : '.bg-blue-100')
    return row.findAll('button').map(b => b.text())
  }

  describe.each([
    { name: '縦画面', isLandscape: false },
    { name: 'Android 横画面', isLandscape: true },
  ])('$name', ({ isLandscape }) => {
    beforeEach(() => { landscape.on.value = isLandscape })

    it('dev の印が無い端末ではメニューに項目が出ない', async () => {
      wrapper = await mountIndex('/?role=driver')
      await toggleMenu(wrapper)
      expect(menuLabels(wrapper)).not.toContain(LABEL)
      expect(menuLabels(wrapper)).toContain('デバイス設定')
    })

    it('dev でない端末のトークンが取れている端末でも出ない', async () => {
      noteDeviceToken('kiosk', plainDeviceJwt())
      wrapper = await mountIndex('/?role=driver')
      await toggleMenu(wrapper)
      expect(menuLabels(wrapper)).not.toContain(LABEL)
    })

    it('★ dev の印がある端末ではメニューに出て、選ぶと開く (可視タブ側へは移らない)', async () => {
      noteDeviceToken('kiosk', devDeviceJwt())
      wrapper = await mountIndex('/?role=driver')
      expect(visibleTabLabels(wrapper)).not.toContain(LABEL)

      await toggleMenu(wrapper)
      const item = wrapper.find('.absolute.right-0').findAll('button').find(b => b.text() === LABEL)
      expect(item).toBeTruthy()
      await item!.trigger('click')
      await nextTick()

      expect(wrapper.findComponent(DevDeviceRecords).exists()).toBe(true)
      expect(wrapper.find('.normal-measurement-stub').exists()).toBe(false)
      // 選んだあとも可視タブには出ず、ハンバーガーが点灯する (= メニュー側に居る)
      expect(visibleTabLabels(wrapper)).not.toContain(LABEL)
      expect(hamburgerButton(wrapper).classes()).toContain('bg-blue-600')
    })
  })

  it('見るのはキオスクの鍵の印だけ (運行管理者席の鍵が dev でも出ない)', async () => {
    noteDeviceToken('manager-device', devDeviceJwt())
    wrapper = await mountIndex('/?role=driver')
    await toggleMenu(wrapper)
    expect(menuLabels(wrapper)).not.toContain(LABEL)
  })

  it('起動後に dev の鍵でトークンが取れた端末でも、メニューを開き直せば出る', async () => {
    wrapper = await mountIndex('/?role=driver')
    await toggleMenu(wrapper)
    expect(menuLabels(wrapper)).not.toContain(LABEL)
    await toggleMenu(wrapper) // 閉じる

    noteDeviceToken('kiosk', devDeviceJwt())
    await toggleMenu(wrapper)
    expect(menuLabels(wrapper)).toContain(LABEL)
  })

  it('★ dev の印がある端末は ?tab=dev_records で開ける', async () => {
    noteDeviceToken('kiosk', devDeviceJwt())
    wrapper = await mountIndex('/?role=driver&tab=dev_records')
    expect(wrapper.findComponent(DevDeviceRecords).exists()).toBe(true)
    expect(wrapper.find('.normal-measurement-stub').exists()).toBe(false)
  })

  it('dev の印が無い端末が ?tab=dev_records で開いても通常点呼になる', async () => {
    wrapper = await mountIndex('/?role=driver&tab=dev_records')
    expect(wrapper.findComponent(DevDeviceRecords).exists()).toBe(false)
    expect(wrapper.find('.normal-measurement-stub').exists()).toBe(true)
  })

  it('画面から印を外すと、項目が消えて通常点呼へ戻る', async () => {
    noteDeviceToken('kiosk', devDeviceJwt())
    wrapper = await mountIndex('/?role=driver&tab=dev_records')

    // DevDeviceRecords は印を消してから cleared を上げる
    clearDevDeviceMark('kiosk')
    wrapper.findComponent(DevDeviceRecords).vm.$emit('cleared')
    await nextTick()

    expect(isDevDevice('kiosk')).toBe(false)
    expect(wrapper.findComponent(DevDeviceRecords).exists()).toBe(false)
    expect(wrapper.find('.normal-measurement-stub').exists()).toBe(true)
    await toggleMenu(wrapper)
    expect(menuLabels(wrapper)).not.toContain(LABEL)
  })
})

describe('pages/index — IT点呼タブ (Refs ippoan/alc-app#387)', () => {
  // IT点呼 は**キオスクの鍵に dev の印がある端末にだけ**ハンバーガーへ出す
  // (テストが済むまで本番の運行者には見せない)。印が無い端末の画面は 1 つも変わらない

  let wrapper: VueWrapper | null = null
  const HAMBURGER = 'M4 6h16M4 12h16M4 18h16'
  const LABEL = 'IT点呼'
  /** 通常点呼タブの NormalMeasurement (it-mode が付いていない方) */
  const NORMAL = '.normal-measurement-stub:not([it-mode])'
  /** IT点呼タブの NormalMeasurement */
  const IT = '.normal-measurement-stub[it-mode]'

  beforeEach(() => {
    bpUi.state.value = 'unused'
    landscape.on.value = false
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    clearDevDeviceMark('kiosk')
    noteDeviceToken('manager-device', null)
    localStorage.clear()
    landscape.on.value = false
  })

  function hamburgerButton(w: VueWrapper) {
    const b = w.findAll('button').find(x => x.html().includes(HAMBURGER))
    if (!b) throw new Error('hamburger not found')
    return b
  }

  async function toggleMenu(w: VueWrapper) {
    await hamburgerButton(w).trigger('click')
    await nextTick()
  }

  function menuLabels(w: VueWrapper) {
    return w.find('.absolute.right-0').findAll('button').map(b => b.text())
  }

  function visibleTabLabels(w: VueWrapper) {
    const row = w.find(landscape.on.value ? '.border-b.bg-gray-50' : '.bg-blue-100')
    return row.findAll('button').map(b => b.text())
  }

  describe.each([
    { name: '縦画面', isLandscape: false },
    { name: 'Android 横画面', isLandscape: true },
  ])('$name', ({ isLandscape }) => {
    beforeEach(() => { landscape.on.value = isLandscape })

    it('★ dev の印が無い端末ではメニューにも可視タブにも出ない', async () => {
      wrapper = await mountIndex('/?role=driver')
      expect(visibleTabLabels(wrapper)).not.toContain(LABEL)
      await toggleMenu(wrapper)
      expect(menuLabels(wrapper)).not.toContain(LABEL)
      // 印が無い端末のメニューのタブは今までの 4 項目のまま (開発用の項目は 1 つも足さない)
      expect(menuLabels(wrapper)).toEqual(expect.arrayContaining(['自動点呼デモ', '遠隔点呼デモ', 'デバイス設定', '血圧測定']))
      expect(menuLabels(wrapper)).not.toContain('開発用の記録')
    })

    it('dev でない端末のトークンが取れている端末でも出ない', async () => {
      noteDeviceToken('kiosk', plainDeviceJwt())
      wrapper = await mountIndex('/?role=driver')
      await toggleMenu(wrapper)
      expect(menuLabels(wrapper)).not.toContain(LABEL)
    })

    it('★ dev の印がある端末ではメニューに出て、選ぶと IT点呼 の画面が開く (可視タブ側へは移らない)', async () => {
      noteDeviceToken('kiosk', devDeviceJwt())
      wrapper = await mountIndex('/?role=driver')
      expect(visibleTabLabels(wrapper)).not.toContain(LABEL)
      expect(wrapper.find(NORMAL).exists()).toBe(true)
      expect(wrapper.find(IT).exists()).toBe(false)

      await toggleMenu(wrapper)
      const item = wrapper.find('.absolute.right-0').findAll('button').find(b => b.text() === LABEL)
      expect(item).toBeTruthy()
      await item!.trigger('click')
      await nextTick()

      expect(wrapper.find(IT).exists()).toBe(true)
      expect(wrapper.find(NORMAL).exists()).toBe(false)
      expect(visibleTabLabels(wrapper)).not.toContain(LABEL)
      expect(hamburgerButton(wrapper).classes()).toContain('bg-blue-600')
    })
  })

  it('見るのはキオスクの鍵の印だけ (運行管理者席の鍵が dev でも出ない)', async () => {
    noteDeviceToken('manager-device', devDeviceJwt())
    wrapper = await mountIndex('/?role=driver')
    await toggleMenu(wrapper)
    expect(menuLabels(wrapper)).not.toContain(LABEL)
  })

  it('★ dev の印がある端末は ?tab=it で開ける', async () => {
    noteDeviceToken('kiosk', devDeviceJwt())
    wrapper = await mountIndex('/?role=driver&tab=it')
    expect(wrapper.find(IT).exists()).toBe(true)
    expect(wrapper.find(NORMAL).exists()).toBe(false)
  })

  it('★ dev の印が無い端末が ?tab=it で開いても通常点呼になる', async () => {
    wrapper = await mountIndex('/?role=driver&tab=it')
    expect(wrapper.find(IT).exists()).toBe(false)
    expect(wrapper.find(NORMAL).exists()).toBe(true)
  })

  it('dev でない端末のトークンが取れている端末が ?tab=it で開いても通常点呼になる', async () => {
    noteDeviceToken('kiosk', plainDeviceJwt())
    wrapper = await mountIndex('/?role=driver&tab=it')
    expect(wrapper.find(IT).exists()).toBe(false)
    expect(wrapper.find(NORMAL).exists()).toBe(true)
  })

  it('IT点呼 の側には打刻履歴 (below-card slot) を付けない — 通常点呼タブには今までどおり付く', async () => {
    noteDeviceToken('kiosk', devDeviceJwt())
    wrapper = await mountIndex('/?role=driver&tab=it')
    expect(wrapper.findComponent(TodayPunchHistory).exists()).toBe(false)
    wrapper.unmount()

    wrapper = await mountIndex('/?role=driver')
    expect(wrapper.find(NORMAL).findComponent(TodayPunchHistory).exists()).toBe(true)
  })

  it('★ 印が外れた端末でメニューを開くと、項目が消えて通常点呼へ戻る', async () => {
    noteDeviceToken('kiosk', devDeviceJwt())
    wrapper = await mountIndex('/?role=driver&tab=it')
    expect(wrapper.find(IT).exists()).toBe(true)

    clearDevDeviceMark('kiosk')
    await toggleMenu(wrapper)
    await nextTick()

    expect(menuLabels(wrapper)).not.toContain(LABEL)
    expect(wrapper.find(IT).exists()).toBe(false)
    expect(wrapper.find(NORMAL).exists()).toBe(true)
  })

  it('★ 開発用の記録の画面から印を外しても、項目が消えて通常点呼へ戻る', async () => {
    noteDeviceToken('kiosk', devDeviceJwt())
    wrapper = await mountIndex('/?role=driver&tab=dev_records')

    clearDevDeviceMark('kiosk')
    wrapper.findComponent(DevDeviceRecords).vm.$emit('cleared')
    await nextTick()

    expect(wrapper.find(NORMAL).exists()).toBe(true)
    await toggleMenu(wrapper)
    expect(menuLabels(wrapper)).not.toContain(LABEL)
  })

  it('印がある端末で通常点呼を開いているときに印が外れても、通常点呼のまま', async () => {
    noteDeviceToken('kiosk', devDeviceJwt())
    wrapper = await mountIndex('/?role=driver')

    clearDevDeviceMark('kiosk')
    await toggleMenu(wrapper)
    await nextTick()

    expect(wrapper.find(NORMAL).exists()).toBe(true)
    expect(menuLabels(wrapper)).not.toContain(LABEL)
  })
})

describe('pages/index — 開発用の端末であることの帯 (Refs ippoan/alc-app#387)', () => {
  // dev の印がある端末にだけ、役割のタブより上に帯を 1 本出す。印が無い端末
  // (= 本番の全端末) では DOM に 1 つも足さない。帯そのものの中身は DevDeviceBanner.test.ts

  let wrapper: VueWrapper | null = null
  const HAMBURGER = 'M4 6h16M4 12h16M4 18h16'
  const BANNER = '[data-testid="dev-device-banner"]'
  const NORMAL = '.normal-measurement-stub:not([it-mode])'
  const IT = '.normal-measurement-stub[it-mode]'

  /** 帯だけ実物にして載せる (ほかは他の describe と同じ shallow) */
  function mountWithBanner(route: string) {
    return mountSuspended(IndexPage, {
      route,
      shallow: true,
      global: {
        stubs: { ManagerAlarmBar: false, ClientOnly: false, NormalMeasurement: NormalMeasurementStub, DevDeviceBanner: false },
      },
    })
  }

  async function toggleMenu(w: VueWrapper) {
    const b = w.findAll('button').find(x => x.html().includes(HAMBURGER))
    if (!b) throw new Error('hamburger not found')
    await b.trigger('click')
    await nextTick()
  }

  function menuLabels(w: VueWrapper) {
    return w.find('.absolute.right-0').findAll('button').map(b => b.text())
  }

  beforeEach(() => {
    bpUi.state.value = 'unused'
    landscape.on.value = false
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    for (const kind of ['kiosk', 'manager-device', 'bp-station'] as const) clearDevDeviceMark(kind)
    localStorage.clear()
    landscape.on.value = false
  })

  describe.each([
    { name: '縦画面', isLandscape: false },
    { name: 'Android 横画面', isLandscape: true },
  ])('$name', ({ isLandscape }) => {
    beforeEach(() => { landscape.on.value = isLandscape })

    it('★ dev の印が無い端末では帯が無い (画面の先頭は今までどおり)', async () => {
      wrapper = await mountWithBanner('/?role=driver')
      expect(wrapper.find(BANNER).exists()).toBe(false)
      expect(wrapper.html()).not.toContain('開発用の端末です')
      expect(wrapper.find(NORMAL).exists()).toBe(true)
    })

    it('dev でない端末のトークンが取れている端末でも帯が無い', async () => {
      noteDeviceToken('kiosk', plainDeviceJwt())
      wrapper = await mountWithBanner('/?role=driver')
      expect(wrapper.find(BANNER).exists()).toBe(false)
    })

    it('★ キオスクの印がある端末では帯が 1 本だけ出る', async () => {
      noteDeviceToken('kiosk', devDeviceJwt())
      wrapper = await mountWithBanner('/?role=driver')
      expect(wrapper.findAll(BANNER)).toHaveLength(1)
      expect(wrapper.find(BANNER).text()).toContain('開発用の端末です')
      expect(wrapper.find(BANNER).text()).toContain('キオスク')
    })
  })

  it('役割のタブより上に出る', async () => {
    noteDeviceToken('kiosk', devDeviceJwt())
    wrapper = await mountWithBanner('/?role=driver')
    const html = wrapper.html()
    expect(html.indexOf('dev-device-banner')).toBeGreaterThan(-1)
    expect(html.indexOf('dev-device-banner')).toBeLessThan(html.indexOf('運行管理者'))
  })

  it('運行管理者のタブを開いていても出る (運行管理者席の印)', async () => {
    noteDeviceToken('manager-device', devDeviceJwt())
    wrapper = await mountWithBanner('/?role=manager')
    expect(wrapper.find(BANNER).text()).toContain('運行管理者席')
  })

  it('mount 後に印が立つと帯が現れる (メニューを開かなくてよい)', async () => {
    wrapper = await mountWithBanner('/?role=driver')
    expect(wrapper.find(BANNER).exists()).toBe(false)

    noteDeviceToken('kiosk', devDeviceJwt())
    await nextTick()

    expect(wrapper.find(BANNER).exists()).toBe(true)
  })

  it('★ mount 後に印が立つと、メニューを開き直さなくても「IT点呼」「開発用の記録」が入る', async () => {
    wrapper = await mountIndex('/?role=driver')
    // メニューは開いたまま (開いた時点の読み直しでは、まだ印が無い)
    await toggleMenu(wrapper)
    expect(menuLabels(wrapper)).not.toContain('IT点呼')
    expect(menuLabels(wrapper)).not.toContain('開発用の記録')

    noteDeviceToken('kiosk', devDeviceJwt())
    await nextTick()

    expect(menuLabels(wrapper)).toContain('IT点呼')
    expect(menuLabels(wrapper)).toContain('開発用の記録')
  })

  it('★ IT点呼 を開いているときに印が外れると、メニューを開かなくても通常点呼へ戻る', async () => {
    noteDeviceToken('kiosk', devDeviceJwt())
    wrapper = await mountIndex('/?role=driver&tab=it')
    expect(wrapper.find(IT).exists()).toBe(true)

    noteDeviceToken('kiosk', plainDeviceJwt())
    await nextTick()
    await nextTick()

    expect(wrapper.find(IT).exists()).toBe(false)
    expect(wrapper.find(NORMAL).exists()).toBe(true)
  })

  it('unmount で listener を外す (そのあと印が変わっても例外にならない)', async () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const mounted = await mountIndex('/?role=driver')

    mounted.unmount()

    expect(removeSpy.mock.calls.some(([name]) => name === DEV_DEVICE_MARK_EVENT)).toBe(true)
    expect(() => noteDeviceToken('kiosk', devDeviceJwt())).not.toThrow()
    removeSpy.mockRestore()
  })
})

describe('pages/index — 血圧を測れない端末では自動点呼のタブを選べない (Refs ippoan/alc-app#401)', () => {
  let wrapper: VueWrapper | null = null
  const HAMBURGER = 'M4 6h16M4 12h16M4 18h16'
  const NOTE = '[data-testid="auto-tenko-blocked-note"]'
  const NORMAL = '.normal-measurement-stub'
  /**
   * いま描かれている TenkoKiosk を、props (`demoMode` / `remoteMode`) で種類に分けて返す。
   * 自動 stub の属性名は kebab にならず、未指定の Boolean が false で出ることもあるので、
   * 属性セレクタでは判別しない。**「何も描かれていない」は `[]` で確かめる** (種類を問わず 0 個)
   */
  function kiosks(w: VueWrapper) {
    return w.findAllComponents(TenkoKiosk).map((c) => {
      const demo = !!c.props('demoMode')
      const remote = !!c.props('remoteMode')
      return remote ? (demo ? 'remote_demo' : 'remote') : (demo ? 'demo' : 'auto')
    })
  }
  const HEAD = 'この端末は血圧計が登録されていないため、自動点呼を使えません。'
  const FIX_PAIR = '自動点呼を使うには、この端末に血圧計を登録 (ペアリング) してください。'
  const FIX_SETTING = '自動点呼を使うには、端末の設定で血圧計を使う設定にしてください。'
  const TAIL = 'それまでは通常点呼か遠隔点呼を使ってください。分からないときは運行管理者に連絡してください。'

  function block(bonded: boolean | null = null) {
    signedBond.probed.value = true
    signedBond.bonded.value = bonded
    bpUi.state.value = 'unused'
  }

  beforeEach(() => {
    bpUi.state.value = 'unused'
    signedBond.probed.value = false
    signedBond.bonded.value = null
    landscape.on.value = false
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    bpUi.state.value = 'unused'
    signedBond.probed.value = false
    signedBond.bonded.value = null
    landscape.on.value = false
  })

  function tabButton(w: VueWrapper, label: string) {
    const row = w.find(landscape.on.value ? '.border-b.bg-gray-50' : '.bg-blue-100')
    const b = row.findAll('button').find(x => x.text() === label)
    if (!b) throw new Error(`tab not found: ${label}`)
    return b
  }

  async function clickMenuItem(w: VueWrapper, label: string) {
    const hamburger = w.findAll('button').find(x => x.html().includes(HAMBURGER))
    if (!hamburger) throw new Error('hamburger not found')
    await hamburger.trigger('click')
    await nextTick()
    const item = w.find('.absolute.right-0').findAll('button').find(x => x.text() === label)
    if (!item) throw new Error(`menu item not found: ${label}`)
    await item.trigger('click')
    await nextTick()
  }

  describe.each([
    { name: '縦画面', isLandscape: false },
    { name: 'Android 横画面', isLandscape: true },
  ])('$name', ({ isLandscape }) => {
    beforeEach(() => { landscape.on.value = isLandscape })

    it('★ 試し終えて unused の端末は、自動点呼を押しても通常点呼のまま・案内が出る・タブは aria-disabled', async () => {
      block()
      wrapper = await mountIndex('/?role=driver')
      expect(tabButton(wrapper, '自動点呼').attributes('aria-disabled')).toBe('true')
      // 他のタブは塞がない
      expect(tabButton(wrapper, '通常点呼').attributes('aria-disabled')).toBeUndefined()
      expect(tabButton(wrapper, '遠隔点呼').attributes('aria-disabled')).toBeUndefined()
      // 押せないのではなく、押すと案内が出る (disabled 属性は付けない)
      expect(tabButton(wrapper, '自動点呼').attributes('disabled')).toBeUndefined()
      expect(wrapper.find(NOTE).exists()).toBe(false)

      await tabButton(wrapper, '自動点呼').trigger('click')
      await nextTick()

      expect(kiosks(wrapper)).toEqual([])
      expect(wrapper.find(NORMAL).exists()).toBe(true)
      expect(wrapper.find(NOTE).exists()).toBe(true)
    })

    it.each(['show', 'checking'] as const)('%s では今までどおり自動点呼に切り替わり、案内は出ない', async (state) => {
      signedBond.probed.value = true
      bpUi.state.value = state
      wrapper = await mountIndex('/?role=driver')
      expect(tabButton(wrapper, '自動点呼').attributes('aria-disabled')).toBeUndefined()

      await tabButton(wrapper, '自動点呼').trigger('click')
      await nextTick()

      expect(kiosks(wrapper)).toEqual(['auto'])
      expect(wrapper.find(NOTE).exists()).toBe(false)
    })

    it('unused でも署名をまだ試していなければ塞がない (CoreS3 の署名が届けば show に変わる)', async () => {
      bpUi.state.value = 'unused'
      wrapper = await mountIndex('/?role=driver')
      expect(tabButton(wrapper, '自動点呼').attributes('aria-disabled')).toBeUndefined()

      await tabButton(wrapper, '自動点呼').trigger('click')
      await nextTick()

      expect(kiosks(wrapper)).toEqual(['auto'])
      expect(wrapper.find(NOTE).exists()).toBe(false)
    })

    it('unregistered / unavailable も塞がない', async () => {
      signedBond.probed.value = true
      bpUi.state.value = 'unregistered'
      wrapper = await mountIndex('/?role=driver')
      expect(tabButton(wrapper, '自動点呼').attributes('aria-disabled')).toBeUndefined()
      bpUi.state.value = 'unavailable'
      await nextTick()
      expect(tabButton(wrapper, '自動点呼').attributes('aria-disabled')).toBeUndefined()
    })
  })

  it('★ ?tab=tenko で開いても blocked なら通常点呼に戻り、案内が出る', async () => {
    block()
    wrapper = await mountIndex('/?role=driver&tab=tenko')
    expect(kiosks(wrapper)).toEqual([])
    expect(wrapper.find(NORMAL).exists()).toBe(true)
    expect(wrapper.find(NOTE).exists()).toBe(true)
  })

  it('★ 自動点呼を開いている最中に blocked へ変わると通常点呼に戻って案内が出る。外れると案内が消える', async () => {
    signedBond.probed.value = false
    wrapper = await mountIndex('/?role=driver&tab=tenko')
    expect(kiosks(wrapper)).toEqual(['auto'])
    expect(wrapper.find(NOTE).exists()).toBe(false)

    signedBond.probed.value = true
    await nextTick()
    await nextTick()
    expect(kiosks(wrapper)).toEqual([])
    expect(wrapper.find(NORMAL).exists()).toBe(true)
    expect(wrapper.find(NOTE).exists()).toBe(true)

    bpUi.state.value = 'show'
    await nextTick()
    expect(wrapper.find(NOTE).exists()).toBe(false)
    // 外れたあと、また塞がれても押していないのに案内は出ない
    bpUi.state.value = 'unused'
    await nextTick()
    expect(wrapper.find(NOTE).exists()).toBe(false)
  })

  it('案内の文言: signedBpBonded が false なら登録 (ペアリング) を案内する', async () => {
    block(false)
    wrapper = await mountIndex('/?role=driver&tab=tenko')
    expect(wrapper.find(NOTE).findAll('p').map(p => p.text())).toEqual([HEAD, FIX_PAIR, TAIL])
  })

  it.each([null, true])('案内の文言: signedBpBonded が %s なら端末の設定を案内する', async (bonded) => {
    block(bonded)
    wrapper = await mountIndex('/?role=driver&tab=tenko')
    expect(wrapper.find(NOTE).findAll('p').map(p => p.text())).toEqual([HEAD, FIX_SETTING, TAIL])
  })

  it('★ 自動点呼デモ (メニュー) も同じ: 選んでも通常点呼のまま・案内が出る', async () => {
    block()
    wrapper = await mountIndex('/?role=driver')
    await clickMenuItem(wrapper, '自動点呼デモ')
    expect(kiosks(wrapper)).toEqual([])
    expect(wrapper.find(NORMAL).exists()).toBe(true)
    expect(wrapper.find(NOTE).exists()).toBe(true)
  })

  it('塞がれていなければ自動点呼デモは開ける', async () => {
    bpUi.state.value = 'show'
    wrapper = await mountIndex('/?role=driver')
    await clickMenuItem(wrapper, '自動点呼デモ')
    expect(kiosks(wrapper)).toEqual(['demo'])
    expect(wrapper.find(NOTE).exists()).toBe(false)
  })

  it('遠隔点呼・遠隔点呼デモ・デバイス設定は塞がれていても開ける', async () => {
    block()
    wrapper = await mountIndex('/?role=driver&tab=remote')
    expect(kiosks(wrapper)).toEqual(['remote'])
    expect(wrapper.find(NOTE).exists()).toBe(false)
    await clickMenuItem(wrapper, '遠隔点呼デモ')
    expect(kiosks(wrapper)).toEqual(['remote_demo'])
    await clickMenuItem(wrapper, 'デバイス設定')
    expect(wrapper.findComponent(DeviceSettings).exists()).toBe(true)
    expect(wrapper.find(NOTE).exists()).toBe(false)
  })
})
