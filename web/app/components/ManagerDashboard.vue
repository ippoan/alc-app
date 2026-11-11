<script setup lang="ts">
type TabKey = 'employees' | 'license' | 'tenko' | 'remote_tenko' | 'screen_share' | 'schedules' | 'baselines' | 'failures' | 'carrying_items' | 'work_hours' | 'timecard' | 'devices' | 'cam_live' | 'cam_clips' | 'it_guide'

const props = defineProps<{
  initialTab?: string
  initialRoomId?: string | null
}>()

const activeTab = ref<TabKey>((props.initialTab as TabKey) ?? 'tenko')
const { isAuthenticated } = useAuth()
const tenkoDashboardSummaryRef = ref<{ refresh: () => void } | null>(null)

const tabs: { key: TabKey, label: string }[] = [
  { key: 'employees', label: '乗務員' },
  { key: 'license', label: '免許証' },
  { key: 'tenko', label: '点呼' },
  { key: 'remote_tenko', label: '遠隔点呼' },
  { key: 'screen_share', label: '画面共有' },
  { key: 'schedules', label: '予定管理' },
  { key: 'baselines', label: '健康基準' },
  { key: 'failures', label: '故障記録' },
  { key: 'carrying_items', label: '携行品' },
  { key: 'work_hours', label: '労働時間' },
  { key: 'timecard', label: 'タイムカード' },
  { key: 'devices', label: 'デバイス管理' },
  // 拠点カメラ (管理者の画面と同じ 2 タブ)。カメラの登録・切り出しは管理者の画面だけ
  { key: 'cam_live', label: 'カメラ一覧' },
  { key: 'cam_clips', label: '拠点カメラの録画' },
  // IT点呼 の手順書 (印刷用)。常に出す
  { key: 'it_guide', label: 'IT点呼 の手順' },
]
</script>

<template>
  <div class="flex flex-col flex-1 overflow-hidden">
    <div class="px-4 pt-4 flex justify-center">
      <div class="flex flex-wrap gap-1 bg-blue-100 rounded-lg p-1 w-fit">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="px-4 py-2 rounded-md text-sm font-medium transition-colors"
          :class="activeTab === tab.key ? 'bg-white text-blue-800 shadow-sm' : 'text-blue-700 hover:text-blue-900'"
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
        </button>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto px-4 py-4">
      <div v-if="activeTab === 'employees'">
        <EmployeeList />
      </div>

      <div v-if="activeTab === 'license'">
        <LicenseRegistration />
      </div>

      <div v-if="activeTab === 'tenko'" class="space-y-4">
        <TenkoDashboardSummary ref="tenkoDashboardSummaryRef" />
        <h2 class="text-sm font-medium text-gray-700">進行中セッション</h2>
        <TenkoSessionMonitor @changed="tenkoDashboardSummaryRef?.refresh()" />
      </div>

      <div v-if="activeTab === 'remote_tenko'">
        <TenkoRemoteAdminView :initial-room-id="initialRoomId" />
      </div>

      <div v-if="activeTab === 'screen_share'">
        <ScreenShareAdminView />
      </div>

      <div v-if="activeTab === 'schedules'">
        <TenkoScheduleManager />
      </div>

      <div v-if="activeTab === 'baselines'">
        <HealthBaselineManager />
      </div>

      <div v-if="activeTab === 'failures'">
        <EquipmentFailureManager />
      </div>

      <div v-if="activeTab === 'carrying_items'">
        <CarryingItemsManager />
      </div>

      <div v-if="activeTab === 'work_hours'">
        <WorkHoursViewer />
      </div>

      <div v-if="activeTab === 'timecard'">
        <TimecardManager />
      </div>

      <div v-if="activeTab === 'devices'" class="space-y-4">
        <DeviceRegistrationManager />
      </div>

      <CamLiveGrid v-if="activeTab === 'cam_live'" seat />

      <!-- 録画の一覧・再生は管理者ログインだけに開いている (運行管理者席の鍵ではカメラの一覧しか取れない) -->
      <template v-if="activeTab === 'cam_clips'">
        <CamClipEvents v-if="isAuthenticated" readonly />
        <p v-else class="text-sm text-gray-600" data-testid="manager-cam-clips-login-required">
          録画を見るには、管理者のアカウントでログインしてください。
        </p>
      </template>

      <ItTenkoGuide v-if="activeTab === 'it_guide'" />
    </div>
  </div>
</template>
