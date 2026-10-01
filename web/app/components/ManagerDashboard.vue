<script setup lang="ts">
import { isDevDevice } from '~/utils/token-selection'

type TabKey = 'employees' | 'license' | 'tenko' | 'remote_tenko' | 'it_tenko' | 'screen_share' | 'schedules' | 'baselines' | 'failures' | 'carrying_items' | 'work_hours' | 'timecard' | 'devices'

const props = defineProps<{
  initialTab?: string
  initialRoomId?: string | null
}>()

const activeTab = ref<TabKey>((props.initialTab as TabKey) ?? 'tenko')
const tenkoDashboardSummaryRef = ref<{ refresh: () => void } | null>(null)

// IT点呼 の受け画面 (Refs ippoan/alc-app#387)。**運行管理者席の鍵に開発用の印がある席にだけ**出す
// (テストが済むまで本番の運行管理者には見せない)。印 (`isDevDevice`) は同期で読める代わりに
// reactive ではないので、ここに写しを持ち、mount 時とタブを押すたびに読み直す
// (`pages/index.vue` の `devKioskMark` と同じ流儀)
const devManagerMark = ref(isDevDevice('manager-device'))
function refreshDevManagerMark() {
  devManagerMark.value = isDevDevice('manager-device')
  // 印が消えたら、行き場の無くなった画面を点呼へ戻す
  if (!devManagerMark.value && activeTab.value === 'it_tenko') activeTab.value = 'tenko'
}
onMounted(refreshDevManagerMark)

const tabs = computed<{ key: TabKey, label: string }[]>(() => [
  { key: 'employees', label: '乗務員' },
  { key: 'license', label: '免許証' },
  { key: 'tenko', label: '点呼' },
  { key: 'remote_tenko', label: '遠隔点呼' },
  ...(devManagerMark.value ? [{ key: 'it_tenko' as const, label: 'IT点呼' }] : []),
  { key: 'screen_share', label: '画面共有' },
  { key: 'schedules', label: '予定管理' },
  { key: 'baselines', label: '健康基準' },
  { key: 'failures', label: '故障記録' },
  { key: 'carrying_items', label: '携行品' },
  { key: 'work_hours', label: '労働時間' },
  { key: 'timecard', label: 'タイムカード' },
  { key: 'devices', label: 'デバイス管理' },
])

function selectTab(key: TabKey) {
  activeTab.value = key
  refreshDevManagerMark()
}
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
          @click="selectTab(tab.key)"
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

      <!-- 印の写しも見る: 印の無い席は `it_tenko` が残っていても描画しない -->
      <TenkoItAdminView v-if="devManagerMark && activeTab === 'it_tenko'" />

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
    </div>
  </div>
</template>
