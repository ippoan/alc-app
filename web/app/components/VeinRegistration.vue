<script setup lang="ts">
import { getEmployeeByNfcId } from '~/utils/api'
import { employeeNotFoundByNfc, employeeLookupFailureMessage } from '~/utils/employee-lookup-messages'

/**
 * 血圧測定タブの指静脈登録 (Refs ippoan/vein-match#20)。
 *
 * **カードをかざす → 指を 2 回読ませる → 登録** だけを行う。乗務員の特定は
 * 血圧測定と同じく NFC だけ (測定台の端末は乗務員の一覧を引けない)。読み取りと保存の
 * 手順は顔登録画面と同じ `useVeinEnroll` の 1 か所。
 *
 * 入口は BloodPressureMeasurement が Vein Station の接続中だけ出す。
 */

const emit = defineEmits<{ close: [] }>()

const vein = useVeinEnroll()
const employeeId = ref('')
const employeeName = ref('')
const lookupError = ref<string | null>(null)

async function onNfcRead(nfcId: string) {
  lookupError.value = null
  try {
    const emp = await getEmployeeByNfcId(nfcId)
    employeeId.value = emp.id
    employeeName.value = emp.name
  } catch (e) {
    lookupError.value = employeeLookupFailureMessage(e, employeeNotFoundByNfc(nfcId))
  }
}

function next() {
  employeeId.value = ''
  employeeName.value = ''
  lookupError.value = null
  vein.reset()
}
</script>

<template>
  <div class="bg-white rounded-2xl p-4 shadow-sm">
    <h2 class="text-lg font-semibold text-gray-700 mb-4">指静脈の登録</h2>

    <!-- 1: カードをかざす -->
    <template v-if="!employeeId">
      <NfcStatus @read="onNfcRead" />
      <p v-if="lookupError" class="mt-3 text-sm text-red-600">{{ lookupError }}</p>
    </template>

    <!-- 3: 登録できた -->
    <div v-else-if="vein.registered.value" class="text-center">
      <p class="text-sm text-gray-500 mb-2">{{ employeeName }}さん</p>
      <p class="text-green-700 font-medium">指静脈を登録しました</p>
      <button
        class="w-full mt-6 px-4 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
        @click="next"
      >
        次の人へ
      </button>
    </div>

    <!-- 2: 指を読ませる -->
    <template v-else>
      <p class="text-sm text-gray-500 mb-4">{{ employeeName }}さん</p>
      <button
        class="w-full px-4 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
        :disabled="!!vein.disabledReason.value || vein.registering.value"
        @click="vein.enroll(employeeId)"
      >
        {{ vein.registering.value ? '指静脈を読み取り中... (端末の案内に従ってください)' : '指静脈を登録' }}
      </button>
      <p v-if="vein.disabledReason.value && !vein.registering.value" class="mt-2 text-sm text-gray-500 text-center">
        {{ vein.disabledReason.value }}
      </p>
      <p v-if="vein.error.value" class="mt-2 text-sm text-red-600 text-center">{{ vein.error.value }}</p>
      <button
        v-if="!vein.registering.value"
        class="w-full mt-3 px-4 py-2 text-sm text-gray-600 hover:underline"
        @click="next"
      >
        別の人にする
      </button>
    </template>

    <button
      v-if="!vein.registering.value"
      class="w-full mt-4 px-4 py-2 bg-gray-200 text-gray-700 rounded-xl text-sm font-medium hover:bg-gray-300 transition-colors"
      @click="emit('close')"
    >
      血圧測定に戻る
    </button>
  </div>
</template>
