<script setup lang="ts">
import type { DeviceSettingsResponse } from '~/types'
import { BLE_GW_DEVICES } from '~/composables/useSerialArbiter'
import { alcoholResultLabel } from '~/utils/alcohol'

const { ports, isSupported, refreshPorts, forgetPort } = useSerialDeviceManager()
const { isAndroidApp } = useFingerprint()
const {
  deactivateDevice, deviceTenantId, deviceId: activatedDeviceId, deviceSettingsToken,
  reAuthenticateDevice,
} = useAuth()
const { hasKioskCredential, hasDeviceJwt } = useDeviceToken()
const coreS3 = useCoreS3Serial()
// CoreS3 の署名で短命 JWT を取って動く運行者 PC (資格情報は持たない設計、#238)。
// 接続中 (isConnected) はまだ JWT を取得しきっていない起動直後も含むので or で見る。
const isRunningViaCoreS3 = computed(() => coreS3.isConnected.value || hasDeviceJwt.value)
// 警告デバイス (Atom VoiceS3R) をこの端末につなぐか。端末登録で選んだ値を後から変えられる (#135)
const { enabled: alarmDeviceEnabled, setEnabled: setAlarmDeviceEnabled } = useAlarmDeviceSetting()
const alarmDevice = useAlarmDevice()
// 血圧測定台 (Atom S3、claimant 名 `bp-station`)。CoreS3 も警告デバイスも挿さらない
// 専用 PC なので、ここが繋がっているときだけ使う (Refs ippoan/alc-app#353)
const atomS3 = useAtomS3Serial()
// 血圧測定台として開いた画面か (`pages/index.vue` の `?station=bp` と同じ判定)。
// CoreS3 と Atom S3 は USB の見た目が同一 (VID 0x303A / PID 0x1001) でこのカードは両方を
// 受け持つので、画面が名指しする端末は測定台かどうかで変える (Refs ippoan/alc-app#353)
const isBpStation = useRoute().query.station === 'bp'
const bleGwDeviceName = isBpStation ? 'ATOM S3' : 'CoreS3'

// この端末で Omron 血圧計を使うか (Refs ippoan/alc-app-s3#135)。対象は Omron の
// HEM-6231T / HCR-1901T2 だけ — ニプロの血圧計 (NBP-1BLE) はこの設定に依らず拾う
// (firmware hub-ble の `omron_enabled`)。
// 正本はサーバの端末設定 (`devices.bp_enabled`) — 端末の NVS に置くと端末を
// 入れ替えたときに消えるため。画面の表示はこの 1 系統だけを見る。
const { bpEnabled, setBpEnabled } = useBloodPressureSetting()

// 常時起動 ON/OFF (端末自身での切替)。call_enabled / call_schedule は現在値を
// 保持したまま always_on だけ差し替える (updateDeviceCallSettings は全項目送信の
// ため、取得済み設定を持たずに叩くと他項目を意図せず上書きする)。
const deviceSettings = ref<DeviceSettingsResponse | null>(null)
const alwaysOnToggling = ref(false)
async function refreshDeviceSettings() {
  if (!activatedDeviceId.value) return
  try {
    deviceSettings.value = await getDeviceSettings(activatedDeviceId.value, deviceSettingsToken.value)
    // 血圧計を使うかはサーバが正本。画面への流し込み口は useBloodPressureSetting 1 本
    setBpEnabled(deviceSettings.value.bp_enabled)
  } catch {
    // 取得失敗時は表示なし (トグルボタンを非表示にする、Refs #480 パターンに準拠)
  }
}
async function toggleAlwaysOnSelf() {
  if (!activatedDeviceId.value || !deviceSettings.value || alwaysOnToggling.value) return
  alwaysOnToggling.value = true
  const next = !deviceSettings.value.always_on
  try {
    await updateDeviceCallSettings(
      activatedDeviceId.value,
      deviceSettings.value.call_enabled,
      deviceSettings.value.call_schedule,
      next,
    )
    deviceSettings.value = { ...deviceSettings.value, always_on: next }
  } catch {
    // 失敗時は表示を変えない (再取得は次回リロード時)
  } finally {
    alwaysOnToggling.value = false
  }
}

// --- Omron 血圧計を使うか (Refs ippoan/alc-app-s3#135) ---
// 正本はサーバ (`devices.bp_enabled`)。保存はサーバへの更新を正とし、繋がっている
// 端末があれば同じ値を流し込む。端末が 1 台も繋がっていなくても保存でき、次に端末が
// 繋がったときに効く。端末側の保存先は NVS (CoreS3 / VoiceS3R とも同じ 1 行の口)。
const OMRON_REQUEST_TIMEOUT_MS = 3000
// request は同時に 1 本しか待てず、端末 JWT の `AUTH SIGN` (最大 10 秒) と重なると即 reject される。
// その理由のときだけ間を置いて呼び直す (上限 12 秒。切断・unmount で中止)
const OMRON_BUSY_RETRY_MS = 300
const OMRON_BUSY_RETRY_LIMIT = 40
const OMRON_REPLY_PREFIX = 'OK OMRON BP='
let omronUnmounted = false
/** サーバへ保存中。押せなくする */
const omronBpBusy = ref(false)
/** サーバへの保存に失敗した */
const omronBpSaveError = ref(false)
/** 端末への送信に失敗した (firmware が古い等)。サーバの値は変わっている */
const omronBpDeviceError = ref(false)
/** VoiceS3R へ送った。再起動しないと効かない旨を出す */
const omronBpRestartNotice = ref(false)

/**
 * `OMRON BP ON|OFF` の送り先。CoreS3 でも VoiceS3R でも同じ 1 行を撃てる
 * (どちらも arbiter の `request` を持つ)。どちらも繋がっていなければ null。
 * `needsRestart` = 設定の反映に再起動が要る (VoiceS3R の firmware の作り)。
 */
const omronTarget = computed(() => {
  if (coreS3.isConnected.value) return { needsRestart: false, request: coreS3.request }
  if (alarmDevice.isConnected.value) return { needsRestart: true, request: alarmDevice.request }
  // 測定台の PC には CoreS3 も警告デバイスも挿さらないので、上の 2 分岐とは実際には競合しない。
  // 測定台のファームは警告デバイスと同じ Atom S3 系で、設定の反映に再起動が要る。
  if (atomS3.isConnected.value) return { needsRestart: true, request: atomS3.request }
  return null
})

/**
 * 今つながっている端末へ設定を 1 回送る (機種に依らない唯一の送信口)。
 * 応答は `OK OMRON BP=<0|1>`。送れなかった / 応答が要求と違うときは案内を出すが、
 * サーバの値 (正本) は動かさない — 次に繋がったときに改めて流し込まれる。
 */
async function sendOmronBp(enabled: boolean): Promise<void> {
  omronBpDeviceError.value = false
  for (let attempt = 0; ; attempt++) {
    const target = omronTarget.value
    if (!target) return
    try {
      const reply = await target.request(enabled ? 'OMRON BP ON' : 'OMRON BP OFF', OMRON_REPLY_PREFIX, OMRON_REQUEST_TIMEOUT_MS)
      const value = reply.slice(OMRON_REPLY_PREFIX.length).trim()
      if (value !== (enabled ? '1' : '0')) throw new Error(`OMRON: unexpected value "${value}"`)
      return
    } catch (e) {
      // 判定は useSerialArbiter.ts の reject 文言 (`request(<name>): 既に応答待ちです`) の部分一致。
      // 文言を変えたらここも合わせること
      const busy = String(e).includes('既に応答待ちです')
      if (!busy || attempt >= OMRON_BUSY_RETRY_LIMIT) {
        omronBpDeviceError.value = true
        return
      }
      await new Promise(resolve => setTimeout(resolve, OMRON_BUSY_RETRY_MS))
      if (omronUnmounted) return
    }
  }
}

// 端末が繋がったとき / サーバの設定が届いたときに、今の設定を端末へ流し込む。
// マウント時に既に繋がっていればその時点で 1 回送る。
watch([omronTarget, bpEnabled], ([target, enabled]) => {
  if (target) void sendOmronBp(enabled)
}, { immediate: true })

/** チェックを変えた。サーバへの保存が正で、端末へは watch が流し込む */
async function setOmronBp(event: Event) {
  const input = event.target as HTMLInputElement
  const next = input.checked
  omronBpBusy.value = true
  omronBpSaveError.value = false
  omronBpRestartNotice.value = false
  try {
    // 端末登録が無い (CoreS3 で動く運行者 PC 等) / 設定を取れていないときは端末にだけ効かせる。
    // updateDeviceCallSettings は call_enabled / call_schedule も送るので、
    // 取得済みの設定を持たずに叩くと他項目を意図せず上書きする
    if (activatedDeviceId.value && deviceSettings.value) {
      await updateDeviceCallSettings(
        activatedDeviceId.value,
        deviceSettings.value.call_enabled,
        deviceSettings.value.call_schedule,
        undefined,
        next,
      )
      deviceSettings.value = { ...deviceSettings.value, bp_enabled: next }
    }
    setBpEnabled(next)
    omronBpRestartNotice.value = omronTarget.value?.needsRestart === true
  } catch {
    omronBpSaveError.value = true
  } finally {
    // :checked が同じ値のままだと再描画で DOM が戻らないので、確定値を直接書き戻す
    input.checked = bpEnabled.value
    omronBpBusy.value = false
  }
}

// 再認証 (re-pair、Refs rust-alc-api#495)。管理者が端末一覧で「再認証を許可」した
// window 内でのみ成功する。credential 欠落状態 (hasKioskCredential=false) なら
// 登録済み端末でも起動時に自動で1回だけ試す (管理者が許可すれば端末に触れずリモート復旧)。
const reAuthing = ref(false)
const reAuthResult = ref<'success' | 'failure' | null>(null)
async function reAuthenticate() {
  if (reAuthing.value) return
  reAuthing.value = true
  reAuthResult.value = null
  try {
    const ok = await reAuthenticateDevice()
    reAuthResult.value = ok ? 'success' : 'failure'
  } finally {
    reAuthing.value = false
  }
}

// 端末登録リセット (WebView localStorage + Android native SharedPreferences 両方をクリア)
const resetting = ref(false)
// 2段階タップ確認。Android WebView は onJsConfirm 未実装だと window.confirm() が常に
// false を返すため使えない (「リセットできない」の原因)。in-page で確認する。
const resetConfirming = ref(false)
let resetConfirmTimer: ReturnType<typeof setTimeout> | null = null

// WS (着信) / FCM の接続・登録状態 (Android ブリッジから取得、診断用)。
// isCallConnected() = RoomWatcher が signaling に WS 接続中か。
// getFcmStatus() = {token_present, registered} JSON。
type AndroidDiag = {
  isCallConnected?: () => boolean
  isCallEnabled?: () => boolean
  getFcmStatus?: () => string
  getAppVersion?: () => string
  checkForUpdate?: () => void
  getLastUpdateResult?: () => string
  setWebVersion?: (version: string) => void
  uploadDeviceLog?: () => void
}

// 端末ログを signaling worker (/device-log) に送信 (observability で読める、WS 診断用)。
const uploadingLog = ref(false)
const logUploadMsg = ref('')
function uploadDeviceLog() {
  const android = (window as unknown as { Android?: AndroidDiag }).Android
  if (!android?.uploadDeviceLog) {
    logUploadMsg.value = 'この APK は未対応 (更新してください)'
    return
  }
  uploadingLog.value = true
  logUploadMsg.value = ''
  try {
    // web (alc-app) の版を native に渡してから送る。診断ログの web= に出て
    // web/native の版ズレ判別に使う (旧 APK は setWebVersion 未実装 → guard)。
    const webVersion = String(useRuntimeConfig().public.appVersion ?? 'dev')
    android.setWebVersion?.(webVersion)
    android.uploadDeviceLog()
    logUploadMsg.value = 'ログを送信しました'
  } catch {
    logUploadMsg.value = '送信に失敗しました'
  } finally {
    setTimeout(() => { uploadingLog.value = false }, 3000)
  }
}

// アプリ更新 (releases/latest を DL・インストール、Android ブリッジ checkForUpdate)。
const updating = ref(false)
// 直近の OTA 更新結果 (ネイティブ UpdateStatusStore 由来、無音失敗を UI に可視化)。
const updateResult = ref<{ ok: boolean, hint: string, version?: string } | null>(null)
function checkForUpdate() {
  const android = (window as unknown as { Android?: AndroidDiag }).Android
  if (!android?.checkForUpdate) {
    // 旧 APK は checkForUpdate 未実装。無言で握りつぶさず理由を出す。
    updateResult.value = { ok: false, hint: 'この APK は更新機能に未対応です (手動で再インストールしてください)' }
    return
  }
  updating.value = true
  try {
    android.checkForUpdate()
  } finally {
    // ダウンロード〜インストールはネイティブ側で進むので、少し待ってボタンを戻す。
    setTimeout(() => { updating.value = false }, 5000)
  }
}
const wsConnected = ref<boolean | null>(null)
const fcmRegistered = ref<boolean | null>(null)
const fcmTokenPresent = ref<boolean | null>(null)
const appVersion = ref<string | null>(null)
const currentVersionCode = ref<number | null>(null)
let diagTimer: ReturnType<typeof setInterval> | null = null

// 最新リリースの versionCode。GitHub Releases API `releases/latest` の
// `tag_name` (形式: `v<versionName>+<run_number>`、release.yml が run_number を
// versionCode として焼き込むため run_number == versionCode) から抽出する。
// 取得できない場合は「比較不能」として更新ボタンを従来どおり表示する (fail-open、
// 誤って更新を隠してしまうより誤って出す方が安全)。
const latestVersionCode = ref<number | null>(null)
const latestVersionCheckFailed = ref(false)
async function fetchLatestVersionCode() {
  try {
    const res = await fetch('https://api.github.com/repos/ippoan/AlcoholChecker/releases/latest')
    if (!res.ok) {
      latestVersionCheckFailed.value = true
      return
    }
    const data = await res.json() as { tag_name?: string }
    const match = data.tag_name?.match(/\+(\d+)$/)
    latestVersionCode.value = match ? Number(match[1]) : null
    if (!match) latestVersionCheckFailed.value = true
  } catch {
    latestVersionCheckFailed.value = true
  }
}
// 現在バージョンより新しい版が releases/latest にある時だけ「更新」ボタンを出す。
// 比較不能 (取得失敗 / 旧 APK で versionCode 未取得) な間は従来どおり表示する。
const updateAvailable = computed(() => {
  if (latestVersionCheckFailed.value) return true
  if (latestVersionCode.value == null || currentVersionCode.value == null) return true
  return latestVersionCode.value > currentVersionCode.value
})

function refreshDeviceDiag() {
  const android = (window as unknown as { Android?: AndroidDiag }).Android
  if (!android) return
  try {
    wsConnected.value = android.isCallConnected?.() ?? null
    const raw = android.getFcmStatus?.()
    if (raw) {
      const s = JSON.parse(raw) as { token_present?: boolean, registered?: boolean }
      fcmTokenPresent.value = s.token_present ?? null
      fcmRegistered.value = s.registered ?? null
    }
    // アプリ (APK) のバージョン。旧 APK は getAppVersion 未実装なので null のまま。
    const ver = android.getAppVersion?.()
    if (ver) {
      const v = JSON.parse(ver) as { versionName?: string, versionCode?: number }
      appVersion.value = v.versionName ? `${v.versionName} (${v.versionCode ?? '?'})` : null
      currentVersionCode.value = v.versionCode ?? null
    }
    // 直近の OTA 更新結果 (成功/失敗/理由)。署名不一致等の「無音失敗」を UI に出す。
    const upd = android.getLastUpdateResult?.()
    if (upd) {
      const u = JSON.parse(upd) as { ok?: boolean, hint?: string, version?: string }
      updateResult.value = typeof u.ok === 'boolean'
        ? { ok: u.ok, hint: u.hint ?? '', version: u.version }
        : null
    }
  } catch { /* ブリッジ未実装の旧 APK 等は無視 */ }
}

onMounted(() => {
  if (isAndroidApp) {
    refreshDeviceDiag()
    diagTimer = setInterval(refreshDeviceDiag, 3000) // 3秒ごとに更新
    fetchLatestVersionCode()
  }
  // 登録済みだが credential が欠落している端末 (rust-alc-api#480 の取りこぼし等) は、
  // 管理者が window を開けていれば起動時の自動 1 回試行だけで無人復旧できる。
  // 未許可 (window 外) なら黙って失敗する (再認証ボタンが常時案内として残る)。
  // CoreS3 で動く運行者 PC は資格情報を保存しない設計 (#238) なので、起動時の探索
  // (最大 3 秒) が終わるのを待ってから、CoreS3 で動作中と分かれば試さない — 待たずに
  // 呼ぶと探索中は必ず失敗し「再認証に失敗しました」が出てしまう。
  void (async () => {
    await coreS3.startupProbe()
    if (activatedDeviceId && !hasKioskCredential.value && !isRunningViaCoreS3.value) {
      reAuthenticate()
    }
  })()
  refreshDeviceSettings()
})
onUnmounted(() => {
  omronUnmounted = true
  if (diagTimer) clearInterval(diagTimer)
  if (resetConfirmTimer) clearTimeout(resetConfirmTimer)
})

function resetDeviceRegistration() {
  if (resetting.value) return
  // 1タップ目: 確認状態にして 4秒だけ「本当にリセット」ボタンを出す (window.confirm は
  // WebView で効かないため in-page 確認)。2タップ目で実行。
  if (!resetConfirming.value) {
    resetConfirming.value = true
    if (resetConfirmTimer) clearTimeout(resetConfirmTimer)
    resetConfirmTimer = setTimeout(() => { resetConfirming.value = false }, 4000)
    return
  }
  // 2タップ目: 実行
  if (resetConfirmTimer) clearTimeout(resetConfirmTimer)
  resetConfirming.value = false
  resetting.value = true
  try {
    // WebView 側 (localStorage): tenant / device_id / settings_token / kiosk credential
    // (kiosk credential のクリアは deactivateDevice() 内で済んでいる)
    deactivateDevice()
    // Android native 側 (SharedPreferences): device_id / settings_token / fcm 登録マーク /
    // kiosk credential を消し RoomWatcher を停止する (stale device_id 起因の WS未接続・FCM未 を解消)。
    const android = (window as unknown as { Android?: { resetDeviceRegistration?: () => void } }).Android
    android?.resetDeviceRegistration?.()
    // staging の auth バイパス (NUXT_PUBLIC_STAGING_TENANT_ID) はリロード時に tenant を
    // 自動再アクティベートするため、リセット直後は 1 回スキップして「未登録」を出し、
    // 実登録 (device_id を入れる) の導線を通す。
    sessionStorage.setItem('alc_skip_staging_bypass', '1')
    // 登録画面へ戻す
    window.location.href = '/'
  } finally {
    resetting.value = false
  }
}

// FC-1200 composable
const fc1200 = useFc1200Serial()

// BLE Gateway composable
const bleGw = useBleGateway()

// FC-1200 diagnostics
const fc1200Testing = ref(false)
const fc1200TestResult = ref<string | null>(null)
const fc1200Measuring = ref(false)

// BLE GW diagnostics
const bleGwTesting = ref(false)
const bleGwTestResult = ref<string | null>(null)

onMounted(() => {
  if (isSupported) refreshPorts()
})

function formatVidPid(info: SerialPortInfo): string {
  if (info.usbVendorId !== undefined) {
    const vid = info.usbVendorId.toString(16).toUpperCase().padStart(4, '0')
    const pid = (info.usbProductId ?? 0).toString(16).toUpperCase().padStart(4, '0')
    return `VID:0x${vid} PID:0x${pid}`
  }
  return 'シリアルポート'
}

function isBleGwDevice(info: SerialPortInfo): boolean {
  if (info.usbVendorId === undefined) return false
  return BLE_GW_DEVICES.some(d =>
    d.vid === info.usbVendorId && (d.pid === undefined || d.pid === info.usbProductId),
  )
}

// FC-1200 ポート (BLE GW 以外の USB デバイス)
const fc1200Ports = computed(() =>
  ports.value.filter(e => !isBleGwDevice(e.info)),
)

// BLE Gateway ポート
const bleGwPorts = computed(() =>
  ports.value.filter(e => isBleGwDevice(e.info)),
)

async function registerFc1200() {
  if (!isSupported) return
  try {
    // FC-1200 用: ESP32 以外のデバイスを選択
    await navigator.serial.requestPort()
    await refreshPorts()
  } catch {}
}

async function registerBleGw() {
  if (!isSupported) return
  try {
    await navigator.serial.requestPort({
      filters: BLE_GW_DEVICES.map(d => ({
        usbVendorId: d.vid,
        ...(d.pid !== undefined && { usbProductId: d.pid }),
      })),
    })
    await refreshPorts()
  } catch {}
}

async function testFc1200() {
  fc1200Testing.value = true
  fc1200Measuring.value = false
  fc1200TestResult.value = null
  try {
    const success = await fc1200.autoConnect()
    if (success) {
      fc1200TestResult.value = '接続成功 — 測定を開始します'
      fc1200Measuring.value = true
      fc1200.startMeasurement()
    } else {
      fc1200TestResult.value = '接続失敗 — デバイスが USB に接続されているか確認してください'
      fc1200Testing.value = false
    }
  } catch (e) {
    fc1200TestResult.value = `エラー: ${e instanceof Error ? e.message : '不明'}`
    fc1200Testing.value = false
  }
}

async function stopFc1200Test() {
  fc1200Measuring.value = false
  fc1200Testing.value = false
  await fc1200.disconnect()
}

// 測定完了 or エラーで自動終了
watch(fc1200.result, (val) => {
  if (val && fc1200Measuring.value) {
    fc1200TestResult.value = `測定完了: ${val.alcoholValue} mg/L (${alcoholResultLabel(val.resultType)})`
    fc1200Measuring.value = false
    fc1200Testing.value = false
    fc1200.disconnect()
  }
})

watch(fc1200.error, (val) => {
  if (val && fc1200Measuring.value) {
    fc1200TestResult.value = `エラー: ${val}`
    fc1200Measuring.value = false
    fc1200Testing.value = false
    fc1200.disconnect()
  }
})

const fc1200StateText = computed(() => {
  switch (fc1200.state.value) {
    case 'warming_up': return 'ウォームアップ中...'
    case 'blow_waiting': return '息を吹きかけてください'
    case 'measuring': return '測定中...'
    default: return ''
  }
})

async function testBleGw() {
  bleGwTesting.value = true
  bleGwTestResult.value = null
  try {
    const success = await bleGw.autoConnect()
    if (success) {
      // ready メッセージ待ち (最大3秒)
      await new Promise(r => setTimeout(r, 3000))
      const ver = bleGw.gatewayVersion.value
      const thermo = bleGw.thermometerConnected.value
      const bp = bleGw.bloodPressureConnected.value
      bleGwTestResult.value = [
        `接続成功`,
        ver ? `FW: v${ver}` : null,
        `体温計: ${thermo ? '接続' : '未接続'}`,
        bpEnabled.value ? `血圧計: ${bp ? '接続' : '未接続'}` : null,
      ].filter(Boolean).join(' / ')
    } else {
      bleGwTestResult.value = `接続失敗 — ${bleGwDeviceName} が USB に接続されているか確認してください`
    }
  } catch (e) {
    bleGwTestResult.value = `エラー: ${e instanceof Error ? e.message : '不明'}`
  } finally {
    bleGwTesting.value = false
  }
}

// Android BLE テスト — WebSocket ブリッジ経由で BLE スキャン状態を確認
async function testAndroidBle() {
  bleGwTesting.value = true
  bleGwTestResult.value = null
  try {
    const success = await bleGw.autoConnect()
    if (success) {
      await new Promise(r => setTimeout(r, 3000))
      const thermo = bleGw.thermometerConnected.value
      const bp = bleGw.bloodPressureConnected.value
      bleGwTestResult.value = [
        `BLE ブリッジ接続成功`,
        `体温計: ${thermo ? '検出済み' : '未検出'}`,
        bpEnabled.value ? `血圧計: ${bp ? '検出済み' : '未検出'}` : null,
      ].filter(Boolean).join(' / ')
    } else {
      bleGwTestResult.value = 'BLE ブリッジ接続失敗 — アプリを再起動してください'
    }
  } catch (e) {
    bleGwTestResult.value = `エラー: ${e instanceof Error ? e.message : '不明'}`
  } finally {
    bleGwTesting.value = false
  }
}

async function syncFc1200Date() {
  if (!fc1200.isConnected.value) {
    const success = await fc1200.autoConnect()
    if (!success) return
  }
  fc1200.updateDeviceDate()
  fc1200TestResult.value = 'デバイス日時を同期しました'
  await new Promise(r => setTimeout(r, 2000))
  await fc1200.disconnect()
}
</script>

<template>
  <div class="w-full max-w-lg mx-auto px-4 py-4 space-y-6">
    <!-- 端末登録リセット -->
    <div class="bg-white rounded-xl shadow-sm overflow-hidden">
      <div class="px-4 py-3 bg-gray-50 border-b">
        <h3 class="text-sm font-medium text-gray-800">端末登録</h3>
        <p class="text-xs text-gray-500">この端末に保存された登録情報 (テナント・device ID・着信/FCM 設定)</p>
      </div>
      <div class="p-4 space-y-3">
        <div class="text-xs text-gray-600 space-y-1">
          <p data-testid="device-registration-status">状態:
            <span v-if="hasDeviceJwt" class="text-green-600 font-medium">CoreS3 で動作中 (端末登録は不要)</span>
            <span v-else :class="deviceTenantId ? 'text-green-600 font-medium' : 'text-gray-400'">
              {{ deviceTenantId ? '登録済み' : '未登録' }}
            </span>
          </p>
          <p v-if="activatedDeviceId" class="font-mono text-gray-400 break-all">device: {{ activatedDeviceId }}</p>
          <p v-if="isAndroidApp" class="flex items-center gap-2">
            <span>アプリ: <span class="font-medium text-gray-700">{{ appVersion ?? '取得中...' }}</span></span>
            <button
              v-if="updateAvailable"
              class="px-2 py-0.5 text-[11px] rounded bg-blue-50 text-blue-600 hover:bg-blue-100 disabled:opacity-50"
              :disabled="updating"
              @click="checkForUpdate"
            >
              {{ updating ? '更新中...' : '更新' }}
            </button>
            <span v-else class="text-[11px] text-gray-400">最新です</span>
          </p>
          <!-- 直近の OTA 更新結果 (署名不一致等の無音失敗を可視化) -->
          <p
            v-if="updateResult"
            class="text-[11px] rounded px-2 py-1"
            :class="updateResult.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'"
          >
            {{ updateResult.ok ? '✓' : '⚠' }} {{ updateResult.hint }}
          </p>
        </div>

        <!-- WS (着信) / FCM 状態 (Android アプリのみ、診断用) -->
        <div v-if="isAndroidApp" class="flex flex-wrap gap-2 text-xs">
          <span class="inline-flex items-center gap-1 px-2 py-1 rounded-full"
            :class="wsConnected ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'">
            <span class="w-1.5 h-1.5 rounded-full" :class="wsConnected ? 'bg-green-500' : 'bg-gray-400'" />
            着信WS: {{ wsConnected === null ? '不明' : wsConnected ? '接続中' : '未接続' }}
          </span>
          <span class="inline-flex items-center gap-1 px-2 py-1 rounded-full"
            :class="fcmRegistered ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'">
            <span class="w-1.5 h-1.5 rounded-full" :class="fcmRegistered ? 'bg-green-500' : 'bg-gray-400'" />
            FCM: {{ fcmRegistered === null ? '不明' : fcmRegistered ? '登録済み' : (fcmTokenPresent ? '未登録(token有)' : '未登録') }}
          </span>
          <button class="px-2 py-1 rounded-full bg-blue-50 text-blue-600 hover:bg-blue-100" @click="refreshDeviceDiag">
            更新
          </button>
        </div>

        <!-- 再認証 (credential 欠落からのリモート復旧、Refs rust-alc-api#495) -->
        <div v-if="activatedDeviceId" class="flex items-center gap-2 flex-wrap">
          <span class="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs"
            :class="hasKioskCredential ? 'bg-green-50 text-green-700' : 'bg-yellow-50 text-yellow-700'">
            <span class="w-1.5 h-1.5 rounded-full" :class="hasKioskCredential ? 'bg-green-500' : 'bg-yellow-500'" />
            認証情報: {{ hasKioskCredential ? '取得済み' : '未取得' }}
          </span>
          <button
            data-testid="reauth-button"
            class="px-2 py-1 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            :disabled="reAuthing"
            @click="reAuthenticate"
          >
            {{ reAuthing ? '再認証中...' : '再認証' }}
          </button>
        </div>
        <p v-if="reAuthResult && !(reAuthResult === 'failure' && isRunningViaCoreS3)"
          data-testid="reauth-result"
          class="text-[11px] rounded px-2 py-1"
          :class="reAuthResult === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'">
          {{ reAuthResult === 'success' ? '✓ 再認証に成功しました' : '⚠ 再認証に失敗しました (管理者に「再認証を許可」を依頼してください)' }}
        </p>

        <!-- 常時起動 ON/OFF (端末自身での切替) -->
        <div v-if="deviceSettings" class="flex items-center gap-2">
          <button
            class="px-3 py-1.5 text-xs rounded-lg transition-colors disabled:opacity-50"
            :class="deviceSettings.always_on
              ? 'bg-green-100 text-green-700 hover:bg-green-200'
              : 'bg-gray-100 text-gray-500 hover:bg-gray-200'"
            :disabled="alwaysOnToggling"
            @click="toggleAlwaysOnSelf"
          >
            {{ alwaysOnToggling ? '更新中...' : `常時起動${deviceSettings.always_on ? 'ON' : 'OFF'}` }}
          </button>
        </div>

        <!-- 警告デバイス (運行管理者 PC のみ)。未設定なら「運行管理者」タブで問いかけが出る -->
        <label class="flex items-start gap-2 text-xs text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            class="mt-0.5"
            data-testid="alarm-device-checkbox"
            :checked="alarmDeviceEnabled === true"
            @change="setAlarmDeviceEnabled(($event.target as HTMLInputElement).checked)"
          />
          <span>
            この端末に警告デバイス (Atom VoiceS3R) をつなぐ (運行管理者 PC のみ)
            <span v-if="alarmDeviceEnabled === null" class="block text-gray-400">未設定 — 「運行管理者」タブで問いかけが出ます</span>
          </span>
        </label>

        <!-- Omron 血圧計を使うか (HEM-6231T / HCR-1901T2。ニプロは対象外)。正本はサーバ
             (devices.bp_enabled、既定 OFF)。端末 (CoreS3 / VoiceS3R / 測定台の Atom S3) が
             繋がっていなくても保存でき、次に繋がったときに効く -->
        <label class="flex items-start gap-2 text-xs text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            class="mt-0.5"
            data-testid="omron-bp-checkbox"
            :checked="bpEnabled"
            :disabled="omronBpBusy"
            @change="setOmronBp"
          />
          <span>
            この端末で Omron 血圧計を使う
            <span v-if="omronBpSaveError" data-testid="omron-bp-error" class="block text-red-500">設定を保存できませんでした (通信を確認してください)</span>
            <span v-else-if="omronBpDeviceError" data-testid="omron-bp-device-error" class="block text-red-500">端末に設定を送れませんでした (firmware が古い可能性があります)</span>
            <span v-else-if="omronBpRestartNotice" data-testid="omron-bp-restart-notice" class="block text-amber-600">設定を変えました。VoiceS3R は再起動すると有効になります</span>
          </span>
        </label>

        <button
          class="px-3 py-1.5 text-xs border rounded-lg transition-colors disabled:opacity-50"
          :class="resetConfirming
            ? 'bg-red-600 text-white border-red-600 hover:bg-red-700'
            : 'text-red-600 border-red-300 hover:bg-red-50'"
          :disabled="resetting"
          @click="resetDeviceRegistration"
        >
          {{ resetting ? 'リセット中...' : resetConfirming ? '本当にリセット？(もう一度タップ)' : '端末登録をリセット' }}
        </button>
        <p class="text-[10px] text-gray-400">
          着信が来ない / FCM が届かない / 環境を切り替えた後に使ってください。リセット後は再登録が必要です。
        </p>

        <!-- ログ送信 (Android のみ、WS 診断用) -->
        <div v-if="isAndroidApp" class="pt-1">
          <button
            class="px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            :disabled="uploadingLog"
            @click="uploadDeviceLog"
          >
            {{ uploadingLog ? '送信中...' : '診断ログを送信' }}
          </button>
          <span v-if="logUploadMsg" class="ml-2 text-[11px] text-gray-500">{{ logUploadMsg }}</span>
          <p class="text-[10px] text-gray-400 mt-1">
            RoomWatcher / 登録の動作ログを signaling worker に送ります (サポート診断用)。
          </p>
        </div>
      </div>
    </div>

    <!-- Windows GW (alc-gw) 確認 (#124)。GW 未検出環境では折りたたまれる -->
    <GwStatusCard />

    <!-- Android WebView: WebSocket ブリッジ経由のテスト -->
    <template v-if="isAndroidApp">
      <!-- FC-1200 セクション (Android) -->
      <div class="bg-white rounded-xl shadow-sm overflow-hidden">
        <div class="px-4 py-3 bg-gray-50 border-b">
          <h3 class="text-sm font-medium text-gray-800">FC-1200 アルコールチェッカー</h3>
          <p class="text-xs text-gray-500">USB 接続 → WebSocket ブリッジ</p>
        </div>
        <div class="p-4">
          <!-- 接続状態 -->
          <div class="flex items-center gap-2 mb-3">
            <span class="w-2 h-2 rounded-full" :class="fc1200.isConnected.value ? 'bg-green-500' : 'bg-gray-300'" />
            <span class="text-sm" :class="fc1200.isConnected.value ? 'text-green-700' : 'text-gray-500'">
              {{ fc1200.isConnected.value ? '接続中' : '未接続' }}
            </span>
            <span v-if="fc1200.transport.value" class="text-xs text-gray-400">({{ fc1200.transport.value }})</span>
          </div>

          <!-- 測定中の状態表示 -->
          <div v-if="fc1200Measuring" class="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-3">
            <div class="flex items-center gap-3">
              <span class="w-3 h-3 rounded-full bg-blue-500 animate-pulse" />
              <span class="text-sm font-medium text-blue-700">{{ fc1200StateText || '接続中...' }}</span>
            </div>
            <div v-if="fc1200.state.value === 'blow_waiting'" class="mt-3 bg-blue-100 rounded-lg p-3 text-center">
              <p class="text-blue-800 font-bold">息を吹きかけてください</p>
              <p class="text-blue-600 text-xs mt-1">FC-1200 のセンサー部に向かって約5秒間</p>
            </div>
            <button
              class="mt-3 px-3 py-1.5 text-xs text-red-600 border border-red-300 rounded-lg hover:bg-red-50"
              @click="stopFc1200Test"
            >
              中止
            </button>
          </div>

          <!-- テストボタン -->
          <div class="flex gap-2">
            <button
              class="px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              :disabled="fc1200Testing"
              @click="testFc1200"
            >
              {{ fc1200Testing ? 'テスト中...' : 'テスト測定' }}
            </button>
            <button
              class="px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              :disabled="fc1200Testing"
              @click="syncFc1200Date"
            >
              日時同期
            </button>
          </div>
          <p v-if="fc1200TestResult" class="text-xs mt-2" :class="fc1200TestResult.includes('失敗') || fc1200TestResult.includes('エラー') ? 'text-red-600' : 'text-green-600'">
            {{ fc1200TestResult }}
          </p>
        </div>
      </div>

      <!-- BLE セクション (Android) -->
      <div class="bg-white rounded-xl shadow-sm overflow-hidden">
        <div class="px-4 py-3 bg-gray-50 border-b">
          <h3 class="text-sm font-medium text-gray-800">BLE 医療機器 ({{ bpEnabled ? '体温計・血圧計' : '体温計' }})</h3>
          <p class="text-xs text-gray-500">Android BLE スキャン → WebSocket ブリッジ</p>
        </div>
        <div class="p-4">
          <!-- 接続状態 -->
          <div class="flex items-center gap-2 mb-3">
            <span class="w-2 h-2 rounded-full" :class="bleGw.isConnected.value ? 'bg-green-500' : 'bg-gray-300'" />
            <span class="text-sm" :class="bleGw.isConnected.value ? 'text-green-700' : 'text-gray-500'">
              {{ bleGw.isConnected.value ? 'ブリッジ接続中' : '未接続' }}
            </span>
          </div>

          <!-- 検出済み機器 -->
          <div v-if="bleGw.isConnected.value" class="bg-green-50 rounded-lg p-3 mb-3">
            <div class="flex gap-4 text-xs">
              <span class="flex items-center gap-1">
                <span class="w-1.5 h-1.5 rounded-full" :class="bleGw.thermometerConnected.value ? 'bg-green-500' : 'bg-gray-300'" />
                体温計: {{ bleGw.thermometerConnected.value ? '検出' : '未検出' }}
              </span>
              <span v-if="bpEnabled" class="flex items-center gap-1">
                <span class="w-1.5 h-1.5 rounded-full" :class="bleGw.bloodPressureConnected.value ? 'bg-green-500' : 'bg-gray-300'" />
                血圧計: {{ bleGw.bloodPressureConnected.value ? '検出' : '未検出' }}
              </span>
            </div>
          </div>

          <!-- テストボタン -->
          <button
            class="px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            :disabled="bleGwTesting"
            @click="testAndroidBle"
          >
            {{ bleGwTesting ? '接続テスト中...' : '接続テスト' }}
          </button>
          <p v-if="bleGwTestResult" class="text-xs mt-2" :class="bleGwTestResult.includes('失敗') || bleGwTestResult.includes('エラー') ? 'text-red-600' : 'text-green-600'">
            {{ bleGwTestResult }}
          </p>
        </div>
      </div>

      <!-- 説明 (Android) -->
      <div class="bg-blue-50 rounded-xl p-4 text-sm text-blue-800">
        <p class="font-medium mb-1">Android デバイステスト</p>
        <p class="text-xs text-blue-700">
          FC-1200 と BLE 医療機器はアプリ内の WebSocket ブリッジ経由で接続されます。
          テストを実行して接続状態を確認できます。
        </p>
      </div>
    </template>

    <!-- WebSerial 非対応 & Android でもない -->
    <div v-else-if="!isSupported" class="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-center">
      <p class="text-yellow-700 text-sm">デバイス管理は Chrome/Edge ブラウザ版でのみ利用可能です</p>
    </div>

    <!-- WebSerial 対応 (PC Chrome/Edge) -->
    <template v-else>
      <!-- FC-1200 セクション -->
      <div class="bg-white rounded-xl shadow-sm overflow-hidden">
        <div class="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
          <div>
            <h3 class="text-sm font-medium text-gray-800">FC-1200 アルコールチェッカー</h3>
            <p class="text-xs text-gray-500">9600 baud</p>
          </div>
          <button
            class="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs hover:bg-blue-700 transition-colors"
            @click="registerFc1200"
          >
            デバイスを追加
          </button>
        </div>

        <div class="p-4">
          <!-- 登録済みポート -->
          <div v-if="fc1200Ports.length > 0" class="divide-y divide-gray-100 mb-3">
            <div
              v-for="(entry, i) in fc1200Ports"
              :key="i"
              class="flex items-center justify-between py-2"
            >
              <div class="flex items-center gap-2">
                <span class="w-2 h-2 rounded-full bg-green-500" />
                <div>
                  <p class="text-sm text-gray-800">FC-1200</p>
                  <p class="text-xs text-gray-500 font-mono">{{ formatVidPid(entry.info) }}</p>
                </div>
              </div>
              <button
                class="px-2 py-1 text-xs text-red-600 border border-red-300 rounded hover:bg-red-50"
                @click="forgetPort(entry.port)"
              >
                解除
              </button>
            </div>
          </div>
          <p v-else class="text-xs text-gray-400 mb-3">未登録</p>

          <!-- 測定中の状態表示 -->
          <div v-if="fc1200Measuring" class="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-3">
            <div class="flex items-center gap-3">
              <span class="w-3 h-3 rounded-full bg-blue-500 animate-pulse" />
              <span class="text-sm font-medium text-blue-700">{{ fc1200StateText || '接続中...' }}</span>
            </div>
            <div v-if="fc1200.state.value === 'blow_waiting'" class="mt-3 bg-blue-100 rounded-lg p-3 text-center">
              <p class="text-blue-800 font-bold">息を吹きかけてください</p>
              <p class="text-blue-600 text-xs mt-1">FC-1200 のセンサー部に向かって約5秒間</p>
            </div>
            <button
              class="mt-3 px-3 py-1.5 text-xs text-red-600 border border-red-300 rounded-lg hover:bg-red-50"
              @click="stopFc1200Test"
            >
              中止
            </button>
          </div>

          <!-- 診断ボタン -->
          <div class="flex gap-2">
            <button
              class="px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              :disabled="fc1200Testing || fc1200Ports.length === 0"
              @click="testFc1200"
            >
              {{ fc1200Testing ? 'テスト中...' : 'テスト測定' }}
            </button>
            <button
              class="px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              :disabled="fc1200Testing || fc1200Ports.length === 0"
              @click="syncFc1200Date"
            >
              日時同期
            </button>
          </div>
          <p v-if="fc1200TestResult" class="text-xs mt-2" :class="fc1200TestResult.includes('失敗') || fc1200TestResult.includes('エラー') ? 'text-red-600' : 'text-green-600'">
            {{ fc1200TestResult }}
          </p>
        </div>
      </div>

      <!-- BLE ゲートウェイ セクション -->
      <div class="bg-white rounded-xl shadow-sm overflow-hidden">
        <div class="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
          <div>
            <h3 class="text-sm font-medium text-gray-800">BLE 体温計・血圧計 ({{ bleGwDeviceName }})</h3>
            <p class="text-xs text-gray-500">{{ bpEnabled ? '体温計・血圧計接続用' : '体温計接続用' }} / 115200 baud</p>
          </div>
          <button
            class="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs hover:bg-blue-700 transition-colors"
            @click="registerBleGw"
          >
            デバイスを追加
          </button>
        </div>

        <div class="p-4">
          <!-- 登録済みポート -->
          <div v-if="bleGwPorts.length > 0" class="divide-y divide-gray-100 mb-3">
            <div
              v-for="(entry, i) in bleGwPorts"
              :key="i"
              class="flex items-center justify-between py-2"
            >
              <div class="flex items-center gap-2">
                <span class="w-2 h-2 rounded-full" :class="bleGw.isConnected.value ? 'bg-green-500' : 'bg-gray-300'" />
                <div>
                  <p class="text-sm text-gray-800">ESP32-S3 ({{ bleGwDeviceName }} など)</p>
                  <p class="text-xs text-gray-500 font-mono">{{ formatVidPid(entry.info) }}</p>
                </div>
              </div>
              <button
                class="px-2 py-1 text-xs text-red-600 border border-red-300 rounded hover:bg-red-50"
                @click="forgetPort(entry.port)"
              >
                解除
              </button>
            </div>
          </div>
          <p v-else class="text-xs text-gray-400 mb-3">未登録</p>

          <!-- ゲートウェイ状態 (接続中の場合) -->
          <div v-if="bleGw.isConnected.value" class="bg-green-50 rounded-lg p-3 mb-3">
            <div class="flex gap-4 text-xs">
              <span v-if="bleGw.gatewayVersion.value" class="text-green-700">FW: v{{ bleGw.gatewayVersion.value }}</span>
              <span class="flex items-center gap-1">
                <span class="w-1.5 h-1.5 rounded-full" :class="bleGw.thermometerConnected.value ? 'bg-green-500' : 'bg-gray-300'" />
                体温計
              </span>
              <span v-if="bpEnabled" class="flex items-center gap-1">
                <span class="w-1.5 h-1.5 rounded-full" :class="bleGw.bloodPressureConnected.value ? 'bg-green-500' : 'bg-gray-300'" />
                血圧計
              </span>
            </div>
          </div>

          <!-- 診断ボタン -->
          <div class="flex gap-2">
            <button
              class="px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              :disabled="bleGwTesting || bleGwPorts.length === 0"
              @click="testBleGw"
            >
              {{ bleGwTesting ? '接続テスト中...' : '接続テスト' }}
            </button>
          </div>
          <p v-if="bleGwTestResult" class="text-xs mt-2" :class="bleGwTestResult.includes('失敗') || bleGwTestResult.includes('エラー') ? 'text-red-600' : 'text-green-600'">
            {{ bleGwTestResult }}
          </p>
        </div>
      </div>

      <!-- 説明 -->
      <div class="bg-blue-50 rounded-xl p-4 text-sm text-blue-800">
        <p class="font-medium mb-1">デバイス登録について</p>
        <p class="text-xs text-blue-700">
          ここでデバイスを登録すると、測定画面で自動的に接続されます。
          USB ポートを変更する場合は、古いデバイスを「解除」してから新しいデバイスを追加してください。
        </p>
      </div>
    </template>
  </div>
</template>
