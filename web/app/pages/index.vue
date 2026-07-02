<script setup lang="ts">
import { initApi } from '~/utils/api'

const config = useRuntimeConfig()
const route = useRoute()

// Auth + API init (全タブ共通)
const { accessToken, isAuthenticated, deviceTenantId, refreshAccessToken, handleLineworksHash, activateFromRegistration } = useAuth()

// LINE WORKS コールバック処理 (hash fragment からトークン取得)
onMounted(() => { handleLineworksHash() })

// LINE WORKS ログイン (auth-worker 経由)
const lwDomain = ref('')
function loginWithLineworks() {
  const input = lwDomain.value.trim()
  if (!input) return
  const redirectUri = encodeURIComponent(window.location.origin + '/?role=general')
  const address = encodeURIComponent(input)
  const authWorkerUrl = (config.public.authWorkerUrl as string) || 'https://auth.ippoan.org'
  window.location.href = `${authWorkerUrl}/oauth/lineworks/redirect?address=${address}&redirect_uri=${redirectUri}`
}
initApi(
  config.public.apiBase as string,
  () => accessToken.value,
  () => deviceTenantId.value,
  () => refreshAccessToken(),
  // キオスク: device credential があれば device JWT を mint して proxy 経由に切替 (#434 3b)。
  // 無ければ null → 従来の X-Tenant-ID 直 fetch に fallback (非破壊)。
  () => useDeviceToken().getDeviceJwt(),
)

// 顔データ同期 (singleton)
useFaceSync()

// Android 横画面検出
const { isAndroidLandscape } = useAndroidLandscape()

// --- 着信通知からの直行モード ---
const incomingCallMode = ref(route.query.mode === 'incoming_call')
const incomingCallRoom = ref<string | null>((route.query.room as string) || null)

// --- ロールタブ ---
type RoleTab = 'driver' | 'manager' | 'admin' | 'general'
const roleTabOptions: RoleTab[] = ['driver', 'manager', 'admin', 'general']
const activeRole = ref<RoleTab>(
  incomingCallMode.value ? 'manager'
  : roleTabOptions.includes(route.query.role as RoleTab)
    ? (route.query.role as RoleTab)
    : 'driver',
)

// PC判定 (汎用管理タブはPCのみ表示)
const isPC = ref(false)
onMounted(() => {
  isPC.value = window.innerWidth >= 1024 && !/Android|iPhone|iPad/i.test(navigator.userAgent)
})

// --- 運行者サブタブ ---
type DriverSubTab = 'normal' | 'tenko' | 'remote' | 'timecard' | 'demo' | 'remote_demo' | 'device'
const driverSubTab = ref<DriverSubTab>(
  route.query.tab === 'tenko' ? 'tenko'
  : route.query.tab === 'demo' ? 'demo'
  : route.query.tab === 'remote' ? 'remote'
  : route.query.tab === 'remote_demo' ? 'remote_demo'
  : route.query.tab === 'timecard' ? 'timecard'
  : route.query.tab === 'device' ? 'device'
  : 'normal',
)

// URL クエリ同期
watch(activeRole, (role) => {
  const params = new URLSearchParams()
  if (role !== 'driver') params.set('role', role)
  const qs = params.toString()
  window.history.replaceState({}, '', qs ? `/?${qs}` : '/')
})

watch(driverSubTab, (tab) => {
  if (activeRole.value !== 'driver') return
  const params = new URLSearchParams()
  if (tab !== 'normal') params.set('tab', tab)
  const qs = params.toString()
  window.history.replaceState({}, '', qs ? `/?${qs}` : '/')
})

const roleLabels: Record<RoleTab, string> = {
  driver: '運行者',
  manager: '運行管理者',
  admin: 'システム管理者',
  general: '汎用管理',
}

const visibleRoleTabs = computed(() =>
  isPC.value ? roleTabOptions : roleTabOptions.filter(r => r !== 'general')
)

// ハンバーガーメニュー
const menuOpen = ref(false)
const menuRef = ref<HTMLElement | null>(null)

// WatchdogService ステータス (Android端末のみ)
const { isAndroidApp } = useFingerprint()
const watchdogStatus = ref<string | null>(null)
function refreshWatchdogStatus() {
  if (!isAndroidApp.value) { watchdogStatus.value = null; return }
  try {
    watchdogStatus.value = (window as any).Android?.isCallEnabled?.() ? '稼働中' : '停止中'
  } catch { watchdogStatus.value = null }
}
watch(menuOpen, (open) => { if (open) refreshWatchdogStatus() })

// QRスキャンでデバイス登録
const qrRegistering = ref(false)
const qrResult = ref<string | null>(null)

function scanQrForRegistration() {
  menuOpen.value = false
  qrResult.value = null
  qrRegistering.value = true
  try {
    ;(window as any).Android?.scanQrCode?.()
  } catch {
    qrResult.value = 'QRスキャナーを起動できません'
    qrRegistering.value = false
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('qr-scanned', async (e: any) => {
      const value = e.detail?.value
      if (!value) { qrRegistering.value = false; return }
      try {
        // URLからtokenを抽出 (/device-claim?token=xxx or コード直接)
        let code = value
        try {
          const url = new URL(value)
          code = url.searchParams.get('token') || value
        } catch { /* URLでなければそのまま使う */ }

        const { claimDeviceRegistration } = await import('~/utils/api')
        let phoneNumber: string | undefined
        try { phoneNumber = (window as any).Android?.getPhoneNumber?.() || undefined } catch {}
        const res = await claimDeviceRegistration({
          registration_code: code,
          phone_number: phoneNumber,
        })
        if (res.device_id) {
          // funnel を通して activate する。raw setDeviceId だと settings_token /
          // device credential (auth_device_id/device_secret) を native に渡さず、
          // device JWT が mint できず register-fcm-token 等が 403 になる
          // (アプリ内 QR スキャン経路の credential 取りこぼし、Refs rust-alc-api#480)。
          activateFromRegistration(res)
          qrResult.value = `登録完了: ${res.device_id.slice(0, 8)}...`
        } else {
          qrResult.value = res.message || '登録に失敗しました'
        }
      } catch (err) {
        qrResult.value = err instanceof Error ? err.message : '登録エラー'
      } finally {
        qrRegistering.value = false
      }
    })
  }
})

function onMenuSelect(tab: DriverSubTab) {
  driverSubTab.value = tab
  menuOpen.value = false
}

function onClickOutside(e: Event) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    menuOpen.value = false
  }
}

onMounted(() => document.addEventListener('click', onClickOutside))
onUnmounted(() => document.removeEventListener('click', onClickOutside))

// 同タブ再クリックで再認証させるためのキー
const managerAuthKey = ref(0)
const adminAuthKey = ref(0)
function reloadPage() { window.location.reload() }
function onRoleTabClick(role: RoleTab) {
  if (activeRole.value === role) {
    if (role === 'manager') managerAuthKey.value++
    if (role === 'admin') adminAuthKey.value++
  }
  activeRole.value = role
}
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- ロールタブ (Android横画面時は非表示→ハンバーガーメニューに移動) -->
    <div v-if="!isAndroidLandscape" class="w-full max-w-lg mx-auto px-4 pt-2 flex items-center gap-2">
      <div class="flex-1 flex gap-1 bg-gray-200 rounded-lg p-1">
        <button
          v-for="role in visibleRoleTabs"
          :key="role"
          class="flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors"
          :class="activeRole === role
            ? 'bg-white text-gray-800 shadow-sm'
            : 'text-gray-600 hover:text-gray-800'"
          @click="onRoleTabClick(role)"
        >
          {{ roleLabels[role] }}
        </button>
      </div>
      <button
        class="p-2 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-200 transition-colors"
        title="ページ更新"
        @click="reloadPage()"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h5M20 20v-5h-5M4.49 15a8 8 0 0013.02 2.13M19.51 9A8 8 0 006.49 6.87" />
        </svg>
      </button>
    </div>

    <!-- 運行者タブ -->
    <template v-if="activeRole === 'driver'">
      <!-- 通常点呼 / 自動点呼 サブタブ + ハンバーガーメニュー (縦画面時のみ) -->
      <div v-if="!isAndroidLandscape" class="w-full max-w-lg mx-auto px-4 mt-2 flex items-center gap-2">
        <div class="flex-1 flex gap-1 bg-blue-100 rounded-lg p-1">
          <button
            v-for="tab in ([
              { key: 'normal' as const, label: '通常点呼' },
              { key: 'tenko' as const, label: '自動点呼' },
              { key: 'remote' as const, label: '遠隔点呼' },
              { key: 'timecard' as const, label: 'タイムカード' },
            ])"
            :key="tab.key"
            class="flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors"
            :class="driverSubTab === tab.key
              ? 'bg-white text-blue-800 shadow-sm'
              : 'text-blue-700 hover:text-blue-900'"
            @click="driverSubTab = tab.key"
          >
            {{ tab.label }}
          </button>
        </div>
        <!-- ハンバーガーメニュー -->
        <div ref="menuRef" class="relative">
          <button
            class="p-2 rounded-md transition-colors"
            :class="['demo', 'remote_demo', 'device'].includes(driverSubTab)
              ? 'bg-blue-600 text-white'
              : 'text-gray-600 hover:text-gray-800 hover:bg-gray-200'"
            @click.stop="menuOpen = !menuOpen"
          >
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div
            v-if="menuOpen"
            class="absolute right-0 top-full mt-1 w-48 bg-white rounded-lg shadow-lg border py-1 z-50"
          >
            <button
              v-for="item in ([
                { key: 'demo' as const, label: '自動点呼デモ' },
                { key: 'remote_demo' as const, label: '遠隔点呼デモ' },
                { key: 'device' as const, label: 'デバイス設定' },
              ])"
              :key="item.key"
              class="w-full text-left px-4 py-2 text-sm transition-colors"
              :class="driverSubTab === item.key
                ? 'bg-blue-50 text-blue-800 font-medium'
                : 'text-gray-700 hover:bg-gray-100'"
              @click="onMenuSelect(item.key)"
            >
              {{ item.label }}
            </button>
            <!-- QRスキャンでデバイス登録 (Android のみ) -->
            <template v-if="isAndroidApp">
              <div class="border-t my-1" />
              <button
                class="w-full text-left px-4 py-2 text-sm transition-colors text-gray-700 hover:bg-gray-100"
                :disabled="qrRegistering"
                @click="scanQrForRegistration"
              >
                {{ qrRegistering ? 'スキャン中...' : 'QRでデバイス登録' }}
              </button>
              <div v-if="qrResult" class="px-4 py-1 text-xs" :class="qrResult.includes('完了') ? 'text-green-600' : 'text-red-500'">
                {{ qrResult }}
              </div>
            </template>
            <div v-if="watchdogStatus" class="border-t my-1" />
            <div v-if="watchdogStatus" class="px-4 py-2 text-xs text-gray-500">
              常時起動:
              <span
                :class="watchdogStatus === '稼働中' ? 'text-green-600 font-medium' : 'text-red-500 font-medium'"
              >{{ watchdogStatus }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- メインコンテンツラッパー: 横画面=flex-col(タブバー+コンテンツ), 縦画面=contents(透過) -->
      <div :class="isAndroidLandscape ? 'flex flex-col flex-1 min-h-0' : 'contents'">
        <!-- トップタブバー (横画面時のみ) -->
        <div v-if="isAndroidLandscape" class="shrink-0 bg-gray-50 border-b flex items-center px-2 py-1 gap-1">
          <!-- サブタブ -->
          <button
            v-for="tab in ([
              { key: 'normal' as const, label: '通常点呼' },
              { key: 'tenko' as const, label: '自動点呼' },
              { key: 'remote' as const, label: '遠隔点呼' },
              { key: 'timecard' as const, label: 'タイムカード' },
            ])"
            :key="tab.key"
            class="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
            :class="driverSubTab === tab.key
              ? 'bg-blue-100 text-blue-800'
              : 'text-blue-600 hover:text-blue-800 hover:bg-blue-50'"
            @click="driverSubTab = tab.key"
          >
            {{ tab.label }}
          </button>
          <div class="flex-1" />
          <!-- ハンバーガーメニュー -->
          <div ref="menuRef" class="relative">
            <button
              class="p-1.5 rounded-md transition-colors"
              :class="['demo', 'remote_demo', 'device'].includes(driverSubTab)
                ? 'bg-blue-600 text-white'
                : 'text-gray-600 hover:text-gray-800 hover:bg-gray-200'"
              @click.stop="menuOpen = !menuOpen"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <div
              v-if="menuOpen"
              class="absolute right-0 top-full mt-1 w-52 bg-white rounded-lg shadow-lg border py-1 z-50 max-h-[70vh] overflow-y-auto"
            >
              <!-- ロール切替 -->
              <div class="px-3 py-1 text-xs text-gray-400 font-medium">ロール切替</div>
              <button
                v-for="role in (['manager', 'admin', 'general'] as RoleTab[])"
                :key="role"
                class="w-full text-left px-4 py-2 text-sm transition-colors"
                :class="activeRole === role
                  ? 'bg-gray-100 text-gray-800 font-medium'
                  : 'text-gray-700 hover:bg-gray-100'"
                @click="onRoleTabClick(role); menuOpen = false"
              >
                {{ roleLabels[role] }}
              </button>
              <div class="border-t my-1" />
              <!-- その他タブ -->
              <button
                v-for="item in ([
                  { key: 'demo' as const, label: '自動点呼デモ' },
                  { key: 'remote_demo' as const, label: '遠隔点呼デモ' },
                  { key: 'device' as const, label: 'デバイス設定' },
                ])"
                :key="item.key"
                class="w-full text-left px-4 py-2 text-sm transition-colors"
                :class="driverSubTab === item.key
                  ? 'bg-blue-50 text-blue-800 font-medium'
                  : 'text-gray-700 hover:bg-gray-100'"
                @click="onMenuSelect(item.key)"
              >
                {{ item.label }}
              </button>
              <div class="border-t my-1" />
              <!-- 測定ログ -->
              <div class="px-2">
                <MeasurementLog :sidebar="true" />
              </div>
              <div class="border-t my-1" />
              <!-- QRスキャンでデバイス登録 (Android のみ) -->
              <template v-if="isAndroidApp">
                <button
                  class="w-full text-left px-4 py-2 text-sm transition-colors text-gray-700 hover:bg-gray-100"
                  :disabled="qrRegistering"
                  @click="scanQrForRegistration"
                >
                  {{ qrRegistering ? 'スキャン中...' : 'QRでデバイス登録' }}
                </button>
                <div v-if="qrResult" class="px-4 py-1 text-xs" :class="qrResult.includes('完了') ? 'text-green-600' : 'text-red-500'">
                  {{ qrResult }}
                </div>
              </template>
              <!-- 常時起動ステータス -->
              <div v-if="watchdogStatus" class="px-4 py-2 text-xs text-gray-500">
                常時起動:
                <span
                  :class="watchdogStatus === '稼働中' ? 'text-green-600 font-medium' : 'text-red-500 font-medium'"
                >{{ watchdogStatus }}</span>
              </div>
              <div v-if="watchdogStatus || isAndroidApp" class="border-t my-1" />
              <!-- ページ更新 -->
              <button
                class="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 transition-colors flex items-center gap-2"
                @click="reloadPage()"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h5M20 20v-5h-5M4.49 15a8 8 0 0013.02 2.13M19.51 9A8 8 0 006.49 6.87" />
                </svg>
                ページ更新
              </button>
            </div>
          </div>
        </div>

        <!-- コンテンツ (1箇所のみ: 横画面=flex子要素, 縦画面=contents透過でルート直下) -->
        <div :class="isAndroidLandscape ? 'flex-1 min-w-0 flex flex-col' : 'contents'">
          <NormalMeasurement v-if="driverSubTab === 'normal'" :landscape="isAndroidLandscape" class="flex-1 min-h-0" />
          <TenkoKiosk v-if="driverSubTab === 'tenko'" :landscape="isAndroidLandscape" class="flex-1 min-h-0" />
          <TenkoKiosk v-if="driverSubTab === 'remote'" :remote-mode="true" :landscape="isAndroidLandscape" class="flex-1 min-h-0" />
          <TenkoKiosk v-if="driverSubTab === 'remote_demo'" :remote-mode="true" :demo-mode="true" :landscape="isAndroidLandscape" class="flex-1 min-h-0" />
          <TenkoKiosk v-if="driverSubTab === 'demo'" :demo-mode="true" :landscape="isAndroidLandscape" class="flex-1 min-h-0" />
          <TimePunchKiosk v-if="driverSubTab === 'timecard'" :landscape="isAndroidLandscape" class="flex-1 min-h-0" />
          <DeviceSettings v-if="driverSubTab === 'device'" class="flex-1 min-h-0" />
        </div>
      </div>

      <!-- 画面共有: タブに関係なく常時フローティング表示 -->
      <ScreenShareSender />
      <!-- 測定ログ: フッターバー (縦画面時のみ。横画面時はサイドバー内) -->
      <MeasurementLog v-if="!isAndroidLandscape" />
    </template>

    <!-- 横画面: 管理者/admin → 運行者に戻るバー -->
    <div v-if="isAndroidLandscape && activeRole !== 'driver'"
         class="shrink-0 bg-gray-50 border-b flex items-center px-2 py-1 gap-2">
      <button
        class="px-3 py-1.5 rounded-md text-xs font-medium text-blue-700 hover:bg-blue-50 transition-colors flex items-center gap-1"
        @click="activeRole = 'driver'"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        運行者に戻る
      </button>
      <span class="text-xs text-gray-500">{{ roleLabels[activeRole] }}</span>
    </div>

    <!-- 運行管理者タブ -->
    <!-- 着信通知モード: RoleAuthGate スキップ → 直接 ManagerDashboard 表示 -->
    <ManagerDashboard
      v-if="activeRole === 'manager' && incomingCallMode"
      initial-tab="remote_tenko"
      :initial-room-id="incomingCallRoom"
      class="flex-1 min-h-0"
    />
    <RoleAuthGate v-else-if="activeRole === 'manager'" :key="managerAuthKey" required-role="manager" class="flex-1 min-h-0">
      <ManagerDashboard />
    </RoleAuthGate>

    <!-- システム管理者タブ -->
    <RoleAuthGate v-if="activeRole === 'admin'" :key="adminAuthKey" required-role="admin" class="flex-1 min-h-0">
      <AdminDashboard />
    </RoleAuthGate>

    <!-- 汎用管理タブ (PCのみ, Google/LINE WORKS認証) -->
    <template v-if="activeRole === 'general'">
      <div v-if="isAuthenticated" class="flex-1 min-h-0">
        <GeneralDashboard />
      </div>
      <div v-else class="flex flex-col items-center justify-center flex-1 p-4">
        <div class="bg-white rounded-2xl p-6 shadow-sm max-w-md w-full text-center space-y-4">
          <h2 class="text-lg font-semibold text-gray-700">汎用管理</h2>
          <p class="text-sm text-gray-500">Google アカウントまたは LINE WORKS でログインしてください。</p>
          <NuxtLink to="/login" class="block px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors">
            Google アカウントでログイン
          </NuxtLink>
          <div class="border-t pt-4">
            <p class="text-xs text-gray-400 mb-2">LINE WORKS</p>
            <div class="flex gap-2">
              <input
                v-model="lwDomain"
                type="text"
                placeholder="ドメインまたはメール"
                class="flex-1 border rounded px-3 py-2 text-sm"
              />
              <button
                class="px-4 py-2 bg-green-600 text-white rounded-xl font-medium hover:bg-green-700 transition-colors disabled:opacity-50"
                :disabled="!lwDomain.trim()"
                @click="loginWithLineworks"
              >
                ログイン
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
