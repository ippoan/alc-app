<script setup lang="ts">
import type { MeasurementResult } from '~/types'

const props = defineProps<{
  employeeId: string
  demoMode?: boolean
}>()

const emit = defineEmits<{
  result: [result: MeasurementResult]
  error: [message: string]
  stateChange: [state: string]
}>()

const {
  isConnected,
  state,
  error,
  result,
  isSupported,
  autoConnect,
  scanDevices,
  startMeasurement,
  resetSession,
} = useFc1200Serial()

// CoreS3 につないだ FC-1200 (Refs ippoan/alc-app-s3#135)。CoreS3 を NFC・認証だけに
// 使い FC-1200 は PC に直結している運用もあるため、CoreS3 の接続有無では判定しない
// — PC 直結の autoConnect は常に行い、CoreS3 の latestAlcohol も同時に待つ。DB9 は
// 物理的に PC か CoreS3 のどちらか 1 台にしかつながらないので、先に届いた結果を
// 1 回だけ emit すれば二重計測にはならない (#238)。
const coreS3 = useCoreS3Serial()
const ble = useBleGateway()

// 業務後は `medical` ステップを通らないため、`useBleGateway.wire()` が一度も呼ばれず
// `ble.latestAlcohol` に alcohol JSON が届かない (#320)。`useStrayAlcohol` は
// `wire()` を経由せず `coreS3.onJson` を直接購読しているので、`wire()` の有無に
// 関わらず値が届く。`wire()` には一切触らない — 前倒しすると heartbeat 監視も
// 前倒しになり、30 秒無音で `coreS3.release()` が走る経路を新設してしまう
// (useStrayAlcohol.ts のコメント参照)。
const { latest: strayAlcohol } = useStrayAlcohol()
// `useStrayAlcohol.latest` は clear されない (前の点呼や本人確認前の値が残ったまま)。
// mount 時点の seq を基準にし、それより新しい seq だけをこの点呼の測定として採用する。
const strayBaselineSeq = ref(0)

const autoConnecting = ref(false)
const autoConnectFailed = ref(false)

// 結果は先着 1 回だけ emit する (PC 直結 / CoreS3 のどちらが先でも同じ規則)。
const resultEmitted = ref(false)

function emitResult(result: MeasurementResult) {
  if (resultEmitted.value) return
  resultEmitted.value = true
  emit('result', result)
}

// 接続後に測定を自動開始 (PC 直結のみ。CoreS3 側の吹込は CoreS3 の画面が案内する)
watch(isConnected, (connected) => {
  if (connected) {
    startMeasurement()
  }
})

// 状態変化を親に通知 (録画制御用)
watch(state, (s) => {
  emit('stateChange', s)
})

// CoreS3 側の進み (firmware の EVT FC1200) も同じく親に通知する — NormalMeasurement の
// onAlcStateChange が CoreS3 経由でも吹き込み待ちで録画を始められるように (Refs ippoan/alc-app-s3#135)
watch(() => ble.alcoholStage.value, (s) => {
  if (s) emit('stateChange', s)
})

// マウント時に自動接続を試行 (CoreS3 接続中かどうかに関わらず PC 直結も試す)
onMounted(async () => {
  resultEmitted.value = false
  // 前の運転者の結果を引き継がない (latestAlcohol はシングルトンの composable 状態)
  ble.clearAlcoholReading()
  // strayAlcohol は clear できないので、基準の seq をここで控える (上のコメント参照)
  strayBaselineSeq.value = strayAlcohol.value?.seq ?? 0

  if (!isSupported() || isConnected.value) return
  autoConnecting.value = true
  const success = await autoConnect()
  autoConnecting.value = false
  if (!success) {
    autoConnectFailed.value = true
  }
})

// 結果を親に通知 (PC 直結の FC-1200)
watch(result, (val) => {
  if (val) {
    emitResult({
      ...val,
      employeeId: props.employeeId,
    })
  }
})

// 結果を親に通知 (CoreS3 につないだ FC-1200)
watch(() => ble.latestAlcohol.value, (val) => {
  if (val) {
    emitResult({
      employeeId: props.employeeId,
      alcoholValue: val.value,
      resultType: val.result,
      deviceUseCount: val.useCount,
      measuredAt: val.measuredAt,
    })
  }
})

// 結果を親に通知 (業務後などで wire() されていない CoreS3 経路。#320)
watch(() => strayAlcohol.value, (val) => {
  if (val && val.seq > strayBaselineSeq.value) {
    emitResult({
      employeeId: props.employeeId,
      alcoholValue: val.value,
      resultType: val.result,
      deviceUseCount: val.useCount,
      measuredAt: val.measuredAt,
    })
  }
})

// エラーを親に通知
watch(error, (val) => {
  if (val) {
    emit('error', val)
  }
})


function handleRetry() {
  resetSession()
  startMeasurement()
}

async function handleRescan() {
  autoConnectFailed.value = false
  autoConnecting.value = true
  const success = await autoConnect()
  autoConnecting.value = false
  if (success) {
    scanDevices()
  } else {
    // WebSocket は接続したが USB デバイス未検出 → 再スキャン指示
    scanDevices()
    autoConnectFailed.value = true
  }
}

// デモモード
const demoAlcValue = ref(0.00)
const demoResultType = ref<'normal' | 'over'>('normal')

function emitDemoResult() {
  emit('result', {
    employeeId: props.employeeId,
    alcoholValue: demoAlcValue.value,
    resultType: demoResultType.value,
    deviceUseCount: 0,
    measuredAt: new Date(),
  })
}
</script>

<template>
  <div class="flex flex-col items-center gap-4">
    <!-- デモモード -->
    <div v-if="demoMode" class="w-full flex flex-col gap-4">
      <div class="flex flex-col gap-2">
        <label class="text-sm font-medium text-gray-700">アルコール値 (mg/L)</label>
        <input
          v-model.number="demoAlcValue"
          type="number"
          step="0.01"
          min="0"
          max="5"
          class="w-full px-4 py-3 border border-gray-300 rounded-xl text-lg text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
      </div>
      <div class="flex gap-3">
        <label
          class="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl border-2 cursor-pointer transition-colors"
          :class="demoResultType === 'normal' ? 'border-green-500 bg-green-50 text-green-700' : 'border-gray-200 text-gray-500'"
        >
          <input v-model="demoResultType" type="radio" value="normal" class="sr-only">
          <span class="font-medium">正常</span>
        </label>
        <label
          class="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl border-2 cursor-pointer transition-colors"
          :class="demoResultType === 'over' ? 'border-red-500 bg-red-50 text-red-700' : 'border-gray-200 text-gray-500'"
        >
          <input v-model="demoResultType" type="radio" value="over" class="sr-only">
          <span class="font-medium">超過</span>
        </label>
      </div>
      <button
        class="w-full px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
        @click="emitDemoResult"
      >
        デモ送信
      </button>
    </div>

    <!-- CoreS3 につないだ FC-1200: firmware が流す EVT FC1200 を PC 直結と同じ語彙で
         出す (Refs ippoan/alc-app-s3#135) -->
    <div
      v-else-if="coreS3.isConnected.value"
      class="flex flex-col items-center gap-4 w-full"
    >
      <div class="bg-blue-50 border-2 border-blue-300 rounded-2xl p-6 text-center w-full">
        <p class="text-blue-800 font-medium">CoreS3 につないだアルコールチェッカーで測定してください</p>
      </div>

      <!-- 状態インジケーター + 吹きかけプロンプト (PC 直結と同じ部品) -->
      <AlcoholStageIndicator :state="ble.alcoholStage.value" />
    </div>

    <!-- 通常モード (FC-1200 PC 直結) -->
    <!-- WebSerial 非対応 -->
    <div v-else-if="!isSupported()" class="bg-red-50 border border-red-200 rounded-xl p-4 text-center">
      <p class="text-red-700 font-medium">FC-1200 接続非対応</p>
      <p class="text-red-500 text-sm mt-1">Chrome / Edge ブラウザまたは Android アプリをご使用ください</p>
    </div>

    <template v-else>
      <!-- 自動接続中 -->
      <div v-if="!isConnected && autoConnecting" class="flex flex-col items-center gap-3">
        <span class="w-4 h-4 rounded-full bg-blue-500 animate-pulse" />
        <p class="text-blue-600 text-sm">FC-1200 に自動接続中...</p>
      </div>

      <!-- 自動接続失敗 -->
      <div v-else-if="!isConnected && autoConnectFailed" class="flex flex-col items-center gap-3">
        <p class="text-amber-700 text-sm font-medium">FC-1200 が見つかりません</p>
        <p class="text-gray-500 text-xs text-center">
          デバイスが USB 接続されていることを確認してください。
          <br>
          初回は
          <NuxtLink to="/?tab=device" class="text-blue-600 hover:underline">デバイス設定</NuxtLink>
          からデバイスを登録してください。
        </p>
        <button
          class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors"
          @click="handleRescan"
        >
          USB 再スキャン
        </button>
      </div>

      <!-- 測定状態表示 -->
      <div v-else class="flex flex-col items-center gap-4 w-full">
        <!-- 状態インジケーター + 吹きかけプロンプト (CoreS3 経由と同じ部品) -->
        <AlcoholStageIndicator :state="state" />

        <!-- エラー表示 + 再測定 -->
        <div v-if="error" class="bg-red-50 border border-red-200 rounded-xl p-4 text-center w-full">
          <p class="text-red-700">{{ error }}</p>
          <button
            class="mt-3 px-4 py-2 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700 transition-colors"
            @click="handleRetry"
          >
            再測定
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
