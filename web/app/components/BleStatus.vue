<script setup lang="ts">
import { isWebSerialSupported } from '~/utils/webserial'

const emit = defineEmits<{
  skip: []
  next: []
}>()

const {
  isConnected,
  error,
  thermometerConnected,
  bloodPressureConnected,
  latestTemperature,
  latestBloodPressure,
  hasMedicalData,
  transport,
  connect,
  startAutoConnect,
  clearReadings,
  resetGateway,
} = useBleGateway()

const autoConnecting = ref(false)
const autoConnectFailed = ref(false)

// ステップ突入時: 古いデータをクリアし自動接続
onMounted(async () => {
  clearReadings()

  // 既に接続済みならスキップ
  if (isConnected.value) return

  autoConnecting.value = true
  const success = await startAutoConnect(5, 3000)
  autoConnecting.value = false
  if (!success) {
    autoConnectFailed.value = true
  }
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- 自動接続中 -->
    <div v-if="autoConnecting" class="flex flex-col items-center gap-3 py-4">
      <span class="w-4 h-4 rounded-full bg-blue-500 animate-pulse" />
      <p class="text-blue-600 text-sm">BLE ゲートウェイに接続中...</p>
    </div>

    <!-- 未接続 (自動接続失敗) -->
    <div v-else-if="!isConnected" class="flex flex-col items-center gap-3">
      <p class="text-gray-500 text-sm text-center">
        BLE ゲートウェイが見つかりません。<br>
        <template v-if="isWebSerialSupported()">
          ATOM Lite が USB 接続されていることを確認してください。
        </template>
        <template v-else>
          Android BLE ブリッジが起動していることを確認してください。
        </template>
      </p>
      <div class="flex gap-3">
        <button
          class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors"
          @click="connect"
        >
          {{ isWebSerialSupported() ? '手動で接続' : '再接続' }}
        </button>
        <button
          class="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm hover:bg-gray-300 transition-colors"
          @click="emit('skip')"
        >
          スキップ
        </button>
      </div>
    </div>

      <!-- 接続中: デバイス状態 + 測定値表示 -->
      <template v-else>
        <!-- デバイス接続状態 -->
        <div class="flex gap-6 justify-center text-sm">
          <span class="flex items-center gap-2">
            <span
              class="w-2.5 h-2.5 rounded-full"
              :class="thermometerConnected ? 'bg-green-500' : 'bg-gray-300'"
            />
            体温計
          </span>
          <span class="flex items-center gap-2">
            <span
              class="w-2.5 h-2.5 rounded-full"
              :class="bloodPressureConnected ? 'bg-green-500' : 'bg-gray-300'"
            />
            血圧計
          </span>
        </div>

        <!-- 測定値カード -->
        <div class="grid grid-cols-2 gap-3">
          <!-- 体温 -->
          <div
            class="rounded-xl p-4 text-center"
            :class="latestTemperature ? 'bg-green-50 border border-green-200' : 'bg-gray-50 border border-gray-200'"
          >
            <p class="text-xs text-gray-500 mb-1">体温</p>
            <p v-if="latestTemperature" class="text-2xl font-mono font-bold text-green-700">
              {{ latestTemperature.value.toFixed(1) }}
              <span class="text-sm font-normal">&#8451;</span>
            </p>
            <p v-else class="text-lg text-gray-300">--.-</p>
          </div>

          <!-- 血圧 -->
          <div
            class="rounded-xl p-4 text-center"
            :class="latestBloodPressure ? 'bg-blue-50 border border-blue-200' : 'bg-gray-50 border border-gray-200'"
          >
            <p class="text-xs text-gray-500 mb-1">血圧</p>
            <template v-if="latestBloodPressure">
              <p class="text-2xl font-mono font-bold text-blue-700">
                {{ latestBloodPressure.systolic }}<span class="text-sm font-normal">/</span>{{ latestBloodPressure.diastolic }}
              </p>
              <p v-if="latestBloodPressure.pulse" class="text-xs text-gray-500 mt-0.5">
                脈拍 {{ latestBloodPressure.pulse }} bpm
              </p>
            </template>
            <p v-else class="text-lg text-gray-300">---/---</p>
          </div>
        </div>

        <p
          v-if="!hasMedicalData"
          class="text-sm text-gray-400 text-center"
        >
          医療機器で測定するとデータが表示されます
        </p>

        <!-- 再スキャンボタン (データ受信後に別の機器を測定したい場合) -->
        <button
          v-if="hasMedicalData"
          class="px-3 py-1.5 bg-amber-50 text-amber-700 border border-amber-200 rounded-lg text-xs hover:bg-amber-100 transition-colors mx-auto"
          @click="resetGateway(); clearReadings()"
        >
          別の機器を測定（再スキャン）
        </button>

        <!-- エラー -->
        <p v-if="error" class="text-sm text-red-600 text-center">{{ error }}</p>

        <!-- アクションボタン -->
        <div class="flex gap-3">
          <button
            class="flex-1 px-4 py-3 rounded-xl font-medium text-sm transition-colors"
            :class="hasMedicalData
              ? 'bg-blue-600 text-white hover:bg-blue-700'
              : 'bg-gray-200 text-gray-500 cursor-not-allowed'"
            :disabled="!hasMedicalData"
            @click="emit('next')"
          >
            次へ
          </button>
          <button
            class="px-4 py-3 bg-gray-100 text-gray-600 rounded-xl font-medium text-sm hover:bg-gray-200 transition-colors"
            @click="emit('skip')"
          >
            スキップ
          </button>
        </div>
      </template>
  </div>
</template>
