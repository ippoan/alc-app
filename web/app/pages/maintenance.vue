<script setup lang="ts">
import { readDiag } from '~/utils/serialDiagLog'

const {
  isConnected,
  state,
  error,
  sensorLifetime,
  memoryRecords,
  dateUpdateSuccess,
  isSupported,
  connect,
  disconnect,
  resetSession,
  checkSensorLifetime,
  startMemoryRead,
  completeMemoryRead,
  updateDeviceDate,
} = useFc1200Serial()

const { deactivateDevice, isDeviceActivated, deviceTenantId } = useAuth()
const isMemoryReading = ref(false)
const showDeactivateConfirm = ref(false)

async function handleConnect() {
  await connect()
}

async function handleCheckSensor() {
  await checkSensorLifetime()
}

async function handleMemoryRead() {
  isMemoryReading.value = true
  await startMemoryRead()
}

async function handleMemoryComplete() {
  await completeMemoryRead()
  isMemoryReading.value = false
}

async function handleSyncDate() {
  await updateDeviceDate()
}

function formatSeconds(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  return `${hours}時間${minutes}分`
}

// シリアル診断ログ (CoreS3 が繋がらず get_log で読めないときの逃げ道、Refs ippoan/alc-app#223)
const diagLines = ref<string[]>([])
const diagCopyResult = ref<'ok' | 'ng' | null>(null)

function reloadDiag() {
  diagLines.value = readDiag()
  diagCopyResult.value = null
}

async function copyDiag() {
  try {
    await navigator.clipboard.writeText(diagLines.value.join('\n'))
    diagCopyResult.value = 'ok'
  }
  catch {
    diagCopyResult.value = 'ng'
  }
}

onMounted(reloadDiag)
</script>

<template>
  <div class="flex flex-col items-center min-h-screen p-4">
    <header class="w-full max-w-lg text-center py-6">
      <h1 class="text-2xl font-bold text-gray-800">デバイスメンテナンス</h1>
      <p class="text-sm text-gray-500 mt-1">FC-1200 の管理・診断</p>
    </header>

    <main class="w-full max-w-lg flex flex-col gap-4">
      <!-- WebSerial 非対応 -->
      <div v-if="!isSupported()" class="bg-red-50 border border-red-200 rounded-xl p-4 text-center">
        <p class="text-red-700 font-medium">FC-1200 接続非対応</p>
        <p class="text-red-500 text-sm mt-1">Chrome / Edge ブラウザまたは Android アプリをご使用ください</p>
      </div>

      <template v-else>
        <!-- 接続カード -->
        <div class="bg-white rounded-2xl p-6 shadow-sm">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-lg font-semibold text-gray-700">接続状態</h2>
            <span
              class="px-3 py-1 rounded-full text-xs font-medium"
              :class="isConnected ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'"
            >
              {{ isConnected ? '接続中' : '未接続' }}
            </span>
          </div>
          <p v-if="isConnected" class="text-sm text-gray-500 mb-3">状態: {{ state }}</p>
          <div class="flex gap-2">
            <button
              v-if="!isConnected"
              class="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
              @click="handleConnect"
            >
              FC-1200 に接続
            </button>
            <button
              v-else
              class="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-300 transition-colors"
              @click="disconnect"
            >
              切断
            </button>
            <button
              v-if="isConnected"
              class="px-4 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm hover:bg-gray-200 transition-colors"
              @click="resetSession"
            >
              リセット
            </button>
          </div>
        </div>

        <!-- エラー表示 -->
        <div v-if="error" class="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
          {{ error }}
        </div>

        <!-- メンテナンス機能 (接続時のみ) -->
        <template v-if="isConnected">
          <!-- センサ寿命確認 -->
          <div class="bg-white rounded-2xl p-6 shadow-sm">
            <h2 class="text-lg font-semibold text-gray-700 mb-3">センサ寿命確認</h2>
            <p class="text-sm text-gray-500 mb-4">FC-1200 のセンサ使用状況を確認します (RQUT)</p>
            <button
              class="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors"
              @click="handleCheckSensor"
            >
              センサ寿命を確認
            </button>
            <div v-if="sensorLifetime" class="mt-4 bg-indigo-50 rounded-lg p-4">
              <div class="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span class="text-gray-500">累計使用時間</span>
                  <p class="font-medium text-gray-800">{{ formatSeconds(sensorLifetime.totalSeconds) }}</p>
                </div>
                <div>
                  <span class="text-gray-500">経過日数</span>
                  <p class="font-medium text-gray-800">{{ sensorLifetime.elapsedDays }}日</p>
                </div>
              </div>
            </div>
          </div>

          <!-- メモリ取込 -->
          <div class="bg-white rounded-2xl p-6 shadow-sm">
            <h2 class="text-lg font-semibold text-gray-700 mb-3">メモリ取込</h2>
            <p class="text-sm text-gray-500 mb-4">
              デバイス内蔵メモリの測定履歴を取得します (RQDD)。
              取込完了後にデバイスメモリがクリアされます。
            </p>
            <button
              v-if="!isMemoryReading"
              class="w-full px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 transition-colors"
              @click="handleMemoryRead"
            >
              メモリ取込開始
            </button>
            <button
              v-else
              class="w-full px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition-colors"
              @click="handleMemoryComplete"
            >
              取込完了 (メモリクリア)
            </button>

            <!-- メモリデータ一覧 -->
            <div v-if="memoryRecords.length > 0" class="mt-4">
              <p class="text-sm font-medium text-gray-600 mb-2">取得件数: {{ memoryRecords.length }}件</p>
              <div class="max-h-64 overflow-y-auto">
                <table class="w-full text-sm">
                  <thead class="bg-gray-50">
                    <tr>
                      <th class="px-2 py-1 text-left text-gray-500">ID</th>
                      <th class="px-2 py-1 text-left text-gray-500">日時</th>
                      <th class="px-2 py-1 text-right text-gray-500">値 (mg/L)</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="record in memoryRecords" :key="record.id" class="border-t border-gray-100">
                      <td class="px-2 py-1 text-gray-700">{{ record.id }}</td>
                      <td class="px-2 py-1 text-gray-700">{{ record.datetime }}</td>
                      <td class="px-2 py-1 text-right" :class="record.alcoholValue > 0 ? 'text-red-600 font-medium' : 'text-green-600'">
                        {{ record.alcoholValue.toFixed(2) }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <!-- 日時同期 -->
          <div class="bg-white rounded-2xl p-6 shadow-sm">
            <h2 class="text-lg font-semibold text-gray-700 mb-3">日時同期</h2>
            <p class="text-sm text-gray-500 mb-4">PC の現在時刻をデバイスに同期します</p>
            <button
              class="w-full px-4 py-2 bg-teal-600 text-white rounded-lg text-sm font-medium hover:bg-teal-700 transition-colors"
              @click="handleSyncDate"
            >
              日時を同期
            </button>
            <div v-if="dateUpdateSuccess !== null" class="mt-3 text-sm text-center">
              <span v-if="dateUpdateSuccess" class="text-green-600">日時同期に成功しました</span>
              <span v-else class="text-red-600">日時同期に失敗しました</span>
            </div>
          </div>
        </template>
      </template>
    </main>

    <!-- 端末管理 -->
    <div class="w-full max-w-lg mt-4">
      <div class="bg-white rounded-2xl p-6 shadow-sm">
        <h2 class="text-lg font-semibold text-gray-700 mb-3">端末管理</h2>
        <div class="flex items-center justify-between">
          <div>
            <p class="text-sm text-gray-500">テナントID</p>
            <p class="text-sm font-mono text-gray-700">
              {{ isDeviceActivated ? deviceTenantId : '未登録' }}
            </p>
          </div>
          <button
            v-if="isDeviceActivated && !showDeactivateConfirm"
            class="px-4 py-2 bg-red-100 text-red-700 rounded-lg text-sm font-medium hover:bg-red-200 transition-colors"
            @click="showDeactivateConfirm = true"
          >
            端末登録解除
          </button>
          <div v-if="showDeactivateConfirm" class="flex gap-2">
            <button
              class="px-3 py-2 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700"
              @click="deactivateDevice(); showDeactivateConfirm = false"
            >
              解除する
            </button>
            <button
              class="px-3 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm hover:bg-gray-300"
              @click="showDeactivateConfirm = false"
            >
              キャンセル
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- シリアル診断ログ -->
    <div class="w-full max-w-lg mt-4">
      <div class="bg-white rounded-2xl p-6 shadow-sm">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-lg font-semibold text-gray-700">シリアル診断ログ</h2>
          <div class="flex gap-2">
            <button
              class="px-3 py-1 bg-gray-100 text-gray-600 rounded-lg text-sm hover:bg-gray-200 transition-colors"
              @click="reloadDiag"
            >
              再読み込み
            </button>
            <button
              class="px-3 py-1 bg-gray-100 text-gray-600 rounded-lg text-sm hover:bg-gray-200 transition-colors"
              :disabled="diagLines.length === 0"
              @click="copyDiag"
            >
              コピー
            </button>
          </div>
        </div>
        <p class="text-sm text-gray-500 mb-2">
          USB シリアルの接続・切断の記録 (最新 {{ diagLines.length }} 行)
          <span v-if="diagCopyResult === 'ok'" class="text-green-600 ml-2">コピーしました</span>
          <span v-else-if="diagCopyResult === 'ng'" class="text-red-600 ml-2">コピーできませんでした</span>
        </p>
        <pre
          v-if="diagLines.length > 0"
          class="max-h-64 overflow-y-auto bg-gray-50 rounded-lg p-3 text-xs font-mono text-gray-700 whitespace-pre-wrap break-all"
        >{{ diagLines.join('\n') }}</pre>
        <p v-else class="text-sm text-gray-400">記録はまだありません</p>
      </div>
    </div>

    <!-- ナビゲーション -->
    <footer class="w-full max-w-lg py-4">
      <div class="flex justify-center gap-4">
        <NuxtLink to="/" class="text-blue-600 hover:underline text-sm">測定画面</NuxtLink>
        <NuxtLink to="/?role=admin" class="text-blue-600 hover:underline text-sm">管理画面</NuxtLink>
      </div>
    </footer>
  </div>
</template>
