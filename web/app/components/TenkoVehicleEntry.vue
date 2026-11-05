<script setup lang="ts">
import type { UpdateTenkoSessionVehicle, VehicleCandidate } from '~/types'
import { evtArg } from '~/composables/useCoreS3Serial'
import { getVehicleCandidates } from '~/utils/api'

/**
 * 車両番号の段 (自己点検表 業務前 二十 ハ)。点呼の開始 (再開) の直後に出る。
 *
 * **車検証の読み取りを優先する**: NFC を読める機体 (CoreS3・Vein Station) がつながっていれば電子車検証をかざしてもらい、
 * 管理番号 (`NFC_CARINS` の `mgno`) をそのままサーバーへ渡す。サーバーが車検証データに照合し、
 * 一致すればその登録番号が車両番号になる (取得元 `carins`)。
 * つながっていない・読めない・一致しないときは、テンキーで一連指定番号 (ナンバーのひらがなの後の数字) を打って候補から選ぶ
 * (`sessionId` を渡したときだけ。候補は端末の営業所の車両が先、点呼の営業所に紐づいていない車両は色を変えて出す)。
 * 候補に無いときは、予定の車両番号を初期値にした入力欄で登録する。
 *
 * 電子車検証の読み取りは通常点呼 (`NormalMeasurement`) と同じイベント (`NFC_CARINS`) で、
 * 番号の取り出しも同じ `evtArg`。Vein Station のファームも CoreS3 と同じ hub-drivers の NFC で車検証を読んで
 * 同じ行を出すので、機体は `useUsbHub().nfc` の組から取る (キオスクは Vein Station のことが多い)。
 */
const props = defineProps<{
  /** 入力欄の値 (予定・セッションの車両番号が初期値)。親が持つ — 登録中の読み込み表示で消えないように */
  modelValue: string
  /** サーバーが車検証に一致する登録を見つけられなかった。入力欄を開く */
  manualRequired?: boolean
  /** 点呼セッション。渡したときだけテンキーと候補を出す */
  sessionId?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  submit: [data: UpdateTenkoSessionVehicle]
}>()

const nfc = useUsbHub().nfc
const carinsAvailable = nfc.isConnected
const readerLabel = nfc.label
/** rc= (読み取り失敗) か、管理番号の無い古いファーム */
const readError = ref(false)
const showManual = ref(false)
const manualVisible = computed(
  () => !carinsAvailable.value || props.manualRequired === true || readError.value || showManual.value,
)

const offCarinsEvent = nfc.onEvent((name, args) => {
  if (name !== 'NFC_CARINS') return
  const mgno = evtArg(args, 'mgno')
  if (evtArg(args, 'rc') || !mgno) {
    readError.value = true
    return
  }
  readError.value = false
  emit('submit', { carins_cert_no: mgno })
})
onUnmounted(offCarinsEvent)

const trimmed = computed(() => props.modelValue.trim())

function submitManual() {
  if (!trimmed.value) return
  emit('submit', { vehicle_number: trimmed.value })
}

// テンキーで打った数字と候補。打つたびに引き直し、古い応答は捨てる。1 桁では候補が多すぎるので
// MIN_DIGITS 桁から引く
const MIN_DIGITS = 2
const digits = ref('')
const candidates = ref<VehicleCandidate[]>([])
const candidatesError = ref(false)
let latestRequest = 0
watch(digits, async (q) => {
  const mine = ++latestRequest
  candidatesError.value = false
  if (q.length < MIN_DIGITS || !props.sessionId) {
    candidates.value = []
    return
  }
  try {
    const found = await getVehicleCandidates(props.sessionId, q)
    if (mine === latestRequest) candidates.value = found
  }
  catch {
    if (mine === latestRequest) {
      candidates.value = []
      candidatesError.value = true
    }
  }
})

/** 候補を選ぶ。車検証から出た候補は管理番号で登録し、取得元を車検証にする */
function pick(c: VehicleCandidate) {
  emit('submit', c.carins_cert_no ? { carins_cert_no: c.carins_cert_no } : { vehicle_number: c.vehicle_number })
}

function officeLabel(c: VehicleCandidate): string {
  if (!c.office_name) return '営業所が未設定'
  return c.company_name ? `${c.company_name} ${c.office_name}` : c.office_name
}
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="vehicle-entry">
    <template v-if="carinsAvailable">
      <p class="text-sm text-gray-600">
        電子車検証を {{ readerLabel }} にかざしてください
      </p>
      <p v-if="readError" data-testid="carins-read-error" class="text-sm text-red-600">
        車検証を読み取れませんでした。もう一度かざすか、車両番号を入力してください
      </p>
      <button
        v-if="!manualVisible"
        data-testid="show-manual-vehicle"
        class="text-sm text-gray-500 hover:text-gray-700 underline"
        @click="showManual = true"
      >
        車検証が使えないときは車両番号を入力する
      </button>
    </template>

    <div v-if="manualVisible && sessionId" class="flex flex-col gap-2" data-testid="vehicle-keypad">
      <p class="text-sm text-gray-600">ナンバーの右側の数字 (例: 7601) を打って、候補から選んでください</p>
      <EmployeeCodeKeypad v-model="digits" :show-submit="false" />
      <p v-if="candidatesError" data-testid="vehicle-candidates-error" class="text-sm text-red-600">
        候補を読み込めませんでした。下の欄に車両番号を入力してください
      </p>
      <p v-else-if="digits && digits.length < MIN_DIGITS" data-testid="vehicle-candidates-more" class="text-sm text-gray-500">
        {{ MIN_DIGITS }} 桁以上打つと候補が出ます
      </p>
      <p v-else-if="digits && !candidates.length" data-testid="vehicle-candidates-empty" class="text-sm text-gray-500">
        候補がありません。下の欄に車両番号を入力してください
      </p>
      <div class="flex flex-col gap-2">
        <button
          v-for="c in candidates"
          :key="`${c.vehicle_number}\n${c.carins_cert_no ?? ''}`"
          data-testid="vehicle-candidate"
          :data-linked="c.linked"
          :class="[
            'w-full px-4 py-3 rounded-xl border text-left flex items-center justify-between gap-2',
            c.linked ? 'bg-white border-gray-300 hover:bg-gray-50' : 'bg-amber-50 border-amber-300 hover:bg-amber-100',
          ]"
          @click="pick(c)"
        >
          <span class="text-lg font-medium text-gray-800">{{ c.vehicle_number }}</span>
          <span :class="['text-xs', c.linked ? 'text-gray-500' : 'text-amber-800 font-medium']">{{ officeLabel(c) }}</span>
        </button>
      </div>
    </div>

    <div v-if="manualVisible" class="flex flex-col gap-2">
      <label class="text-sm text-gray-600" for="vehicle-number-input">{{ sessionId ? '候補に無いときは車両番号を入力' : '車両番号' }}</label>
      <input
        id="vehicle-number-input"
        data-testid="vehicle-number-input"
        :value="modelValue"
        type="text"
        placeholder="車両番号"
        class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
        @keyup.enter="submitManual"
      >
      <button
        data-testid="submit-vehicle-number"
        :disabled="!trimmed"
        class="w-full px-6 py-3 bg-blue-600 text-white rounded-xl font-medium disabled:opacity-50 hover:bg-blue-700 transition-colors"
        @click="submitManual"
      >
        登録して次へ
      </button>
    </div>
  </div>
</template>
