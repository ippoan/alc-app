<script setup lang="ts">
type TabKey = 'employees' | 'license' | 'history' | 'tenko' | 'remote_tenko' | 'screen_share' | 'schedules' | 'records' | 'baselines' | 'failures' | 'carrying_items' | 'work_hours' | 'timecard' | 'devices'

const props = defineProps<{
  initialTab?: string
  initialRoomId?: string | null
}>()

const activeTab = ref<TabKey>((props.initialTab as TabKey) ?? 'tenko')
const tenkoDashboardSummaryRef = ref<{ refresh: () => void } | null>(null)

// 据置警告デバイス (Atom VoiceS3R / USB) は運行管理者の PC につなぐ。
// この画面が開いているあいだだけ heartbeat が出る = 閉じるとデバイスが鳴る (#135)
const rooms = useActiveRooms()
const alarm = useAlarmDevice()

onMounted(() => {
  rooms.start()
  // BLE ゲートウェイと同居しない PC なので、ポートの取り合いを待つ必要が無い
  alarm.connect(0)
})
onUnmounted(() => {
  void alarm.disconnect()
  // 参照カウントなので、遠隔点呼タブの子が先に stop していても WebSocket は残る
  rooms.stop()
})

const alarmCauseLabels: Record<string, string> = {
  silence: '無音',
  'ng:signaling': 'signaling 未接続',
  call: '呼び出し',
}
function alarmCauseText(cause: string): string {
  return alarmCauseLabels[cause] ?? cause
}

/** 着信中 = room は立っているが管理者がまだどれにも入っていない */
const callingRooms = computed(() =>
  rooms.joinedRoomId.value === null ? rooms.activeRooms.value.length : 0,
)

const alarmStatusText = computed(() => {
  if (!alarm.isConnected.value) return '未接続'
  const s = alarm.deviceState.value
  if (s?.state === 'alarming') return `鳴動中 (${alarmCauseText(s.cause)})`
  if (s?.state === 'muted') return `停止済み (人が止めた・${alarmCauseText(s.cause)})`
  return '接続'
})

const alarmDotClass = computed(() => {
  if (!alarm.isConnected.value) return 'bg-gray-300'
  const state = alarm.deviceState.value?.state
  if (state === 'alarming') return 'bg-red-500'
  if (state === 'muted') return 'bg-amber-400'
  return 'bg-green-500'
})
</script>

<template>
  <div class="flex flex-col flex-1 overflow-hidden">
    <div class="px-4 pt-4 flex justify-center">
      <div class="flex flex-wrap gap-1 bg-blue-100 rounded-lg p-1 w-fit">
        <button
          v-for="tab in [
            { key: 'employees', label: '乗務員' },
            { key: 'license', label: '免許証' },
            { key: 'tenko', label: '点呼' },
            { key: 'remote_tenko', label: '遠隔点呼' },
            { key: 'screen_share', label: '画面共有' },
            { key: 'history', label: '測定履歴' },
            { key: 'schedules', label: '予定管理' },
            { key: 'records', label: '点呼記録' },
            { key: 'baselines', label: '健康基準' },
            { key: 'failures', label: '故障記録' },
            { key: 'carrying_items', label: '携行品' },
            { key: 'work_hours', label: '労働時間' },
            { key: 'timecard', label: 'タイムカード' },
            { key: 'devices', label: 'デバイス管理' },
          ]"
          :key="tab.key"
          class="px-4 py-2 rounded-md text-sm font-medium transition-colors"
          :class="activeTab === tab.key ? 'bg-white text-blue-800 shadow-sm' : 'text-blue-700 hover:text-blue-900'"
          @click="activeTab = tab.key as TabKey"
        >
          {{ tab.label }}
        </button>
      </div>

      <!-- 警告デバイスの状態はどのタブに居ても見えるようにする -->
      <ClientOnly>
        <div v-if="alarm.isSupported" class="flex items-center gap-1.5 ml-2 self-center" :title="`警告デバイス: ${alarmStatusText}`">
          <span class="w-2.5 h-2.5 rounded-full" :class="alarmDotClass" />
          <span class="text-xs text-blue-800">警告デバイス</span>
        </div>
      </ClientOnly>
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

      <div v-if="activeTab === 'history'">
        <MeasurementHistory />
      </div>

      <div v-if="activeTab === 'schedules'">
        <TenkoScheduleManager />
      </div>

      <div v-if="activeTab === 'records'">
        <TenkoRecordViewer />
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
        <!-- 警告デバイス (この PC につなぐ) -->
        <ClientOnly>
          <div v-if="alarm.isSupported" class="bg-white rounded-xl shadow-sm overflow-hidden">
            <div class="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
              <div>
                <h3 class="text-sm font-medium text-gray-800">警告デバイス (Atom VoiceS3R)</h3>
                <p class="text-xs text-gray-500">この PC の USB につなぐ / 115200 baud</p>
              </div>
              <button
                class="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs hover:bg-blue-700 transition-colors"
                @click="alarm.requestPort()"
              >
                警告デバイスを接続
              </button>
            </div>

            <div class="p-4 space-y-2">
              <div class="flex items-center gap-2">
                <span class="w-2 h-2 rounded-full" :class="alarmDotClass" />
                <p class="text-xs text-gray-600">{{ alarmStatusText }}</p>
              </div>
              <p v-if="!rooms.isWatching.value" class="text-xs text-red-600">
                着信を受けられません (signaling 未接続)
              </p>
              <p v-else-if="callingRooms > 0" class="text-xs text-amber-600">
                呼び出し中 ({{ callingRooms }} 台)
              </p>
            </div>
          </div>
        </ClientOnly>

        <DeviceRegistrationManager />
      </div>
    </div>
  </div>
</template>
