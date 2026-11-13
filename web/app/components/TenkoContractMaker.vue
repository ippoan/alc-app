<script setup lang="ts">
import type { TenkoCompany, TenkoConsignment, TenkoOffice } from '~/types'
import { getTenkoFilingSettings, getTenkoOffices, listTenkoConsignments } from '~/utils/api'
import {
  bureauOf, buildContract, contractOfficeName, defaultOffice, fiveYearsEnd, missingContractFields, type ContractRequest,
} from '~/utils/consignment-contract'
import { jstTodayDate } from '~/utils/jst'
import { saveBytes } from '~/utils/tenko-forms'

/**
 * 事業者間遠隔点呼の受委託の契約書を作る (システム管理者)。委託者 (甲) と受託者 (乙) の事業者・営業所を選び、
 * 各事業者の「書き込む値」(名称・住所・代表者) と期間を雛形に差し込んで docx を保存させる。
 * 営業所の既定は本社 (名前に「本社」を含む営業所)。期間の既定は、選んだ営業所の組の受委託に登録した期間。
 */

const props = defineProps<{ companies: TenkoCompany[] }>()

const offices = ref<TenkoOffice[]>([])
const consignments = ref<TenkoConsignment[]>([])
const loadError = ref('')

onMounted(async () => {
  try {
    const [res, cons] = await Promise.all([getTenkoOffices(), listTenkoConsignments()])
    offices.value = res.offices
    consignments.value = cons
  }
  catch {
    loadError.value = '営業所・受委託を取得できませんでした'
  }
})

const kouCompany = ref('')
const otsuCompany = ref('')
const kouOffice = ref('')
const otsuOffice = ref('')
const validFrom = ref('')
const validTo = ref('')
const contractDay = ref(jstTodayDate())
const bureau = ref('')

function officesOf(companyId: string): TenkoOffice[] {
  return offices.value.filter(o => o.company_id === companyId)
}

/** 事業者の既定: 甲は先頭、乙は甲と別の先頭 */
watch(() => props.companies, (cs) => {
  if (!cs.some(c => c.id === kouCompany.value)) kouCompany.value = cs[0]?.id ?? ''
  if (!cs.some(c => c.id === otsuCompany.value) || otsuCompany.value === kouCompany.value) {
    otsuCompany.value = cs.find(c => c.id !== kouCompany.value)?.id ?? ''
  }
}, { immediate: true })

/** 事業者を変えたら (営業所を読んだら) 営業所を本社に戻す */
watch([kouCompany, offices], () => { kouOffice.value = defaultOffice(officesOf(kouCompany.value))?.id ?? '' }, { immediate: true })
watch([otsuCompany, offices], () => { otsuOffice.value = defaultOffice(officesOf(otsuCompany.value))?.id ?? '' }, { immediate: true })

/** 選んだ営業所の組の受委託があれば、その期間と乙の営業所の運輸局を既定にする */
watch([kouOffice, otsuOffice, consignments], () => {
  const c = consignments.value.find(x => x.consignor_office_id === kouOffice.value && x.consignee_office_id === otsuOffice.value)
  if (c?.valid_from && c.valid_to) {
    validFrom.value = c.valid_from
    validTo.value = c.valid_to
  }
  bureau.value = bureauOf(offices.value.find(o => o.id === otsuOffice.value)?.address)
}, { immediate: true })

/** 開始日を入れたら終了日を 5 年 (開始日の 5 年後の前日) にする。終了日は後から直せる */
function onFromInput() {
  validTo.value = fiveYearsEnd(validFrom.value)
}

const problem = computed(() => {
  if (!kouCompany.value || !otsuCompany.value) return '委託と受託の事業者を選んでください'
  if (kouCompany.value === otsuCompany.value) return '委託と受託は別の事業者にしてください'
  if (!kouOffice.value || !otsuOffice.value) return '委託と受託の営業所を選んでください (下の営業所の表で事業者を付けます)'
  if (!validFrom.value || !validTo.value || validTo.value < validFrom.value) return '期間は開始日と終了日を入れ、終了日は開始日以降にしてください'
  return ''
})

const busy = ref(false)
const error = ref('')
const missing = ref<string[]>([])

function officeLabel(id: string): string {
  return contractOfficeName(offices.value.find(o => o.id === id)!.name)
}

async function download() {
  busy.value = true
  error.value = ''
  missing.value = []
  try {
    /** 名称は事業者の表の名称 (書き込む値の名称が空のとき) */
    const settingsOf = async (id: string) => {
      const s = await getTenkoFilingSettings(id)
      return { ...s, operator_name: s.operator_name || props.companies.find(c => c.id === id)!.name }
    }
    const [kou, otsu] = await Promise.all([settingsOf(kouCompany.value), settingsOf(otsuCompany.value)])
    const req: ContractRequest = {
      kou: { settings: kou, office: officeLabel(kouOffice.value) },
      otsu: { settings: otsu, office: officeLabel(otsuOffice.value) },
      validFrom: validFrom.value,
      validTo: validTo.value,
      contractDate: contractDay.value,
      bureau: bureau.value.trim() || bureauOf(otsu.operator_address),
    }
    missing.value = missingContractFields(req)
    const { bytes, filename } = await buildContract(req)
    saveBytes(bytes, filename, 'docx')
  }
  catch (e) {
    error.value = e instanceof Error && e.message ? e.message : '契約書を作成できませんでした'
  }
  finally {
    busy.value = false
  }
}

const inputClass = 'border rounded-lg px-2 py-1'
</script>

<template>
  <div class="bg-white rounded-xl p-4 shadow-sm space-y-3" data-testid="tenko-contract">
    <h3 class="font-semibold text-gray-800">受委託の契約書を作る</h3>
    <p class="text-sm text-gray-600">
      事業者間遠隔点呼の業務の管理の委託受託契約書を、事業者の表の名称・住所・代表者を入れた Word で保存します。
      営業所は本社が既定です。期間は、選んだ営業所の受委託に登録した期間が既定です。開始日を入れると、終了日は 5 年 (開始日の 5 年後の前日) になります。
    </p>
    <p v-if="loadError" class="text-sm text-red-600" data-testid="tenko-contract-load-error">{{ loadError }}</p>
    <div class="grid gap-3 sm:grid-cols-2 text-sm">
      <fieldset class="space-y-1">
        <legend class="text-gray-500">委託する事業者 (甲)</legend>
        <select v-model="kouCompany" :class="inputClass" class="w-full" data-testid="tenko-contract-kou-company">
          <option v-for="c in companies" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <select v-model="kouOffice" :class="inputClass" class="w-full" data-testid="tenko-contract-kou-office">
          <option v-for="o in officesOf(kouCompany)" :key="o.id" :value="o.id">{{ o.name }}</option>
        </select>
      </fieldset>
      <fieldset class="space-y-1">
        <legend class="text-gray-500">受託する事業者 (乙)</legend>
        <select v-model="otsuCompany" :class="inputClass" class="w-full" data-testid="tenko-contract-otsu-company">
          <option v-for="c in companies" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <select v-model="otsuOffice" :class="inputClass" class="w-full" data-testid="tenko-contract-otsu-office">
          <option v-for="o in officesOf(otsuCompany)" :key="o.id" :value="o.id">{{ o.name }}</option>
        </select>
      </fieldset>
    </div>
    <div class="flex flex-wrap items-end gap-4 text-sm">
      <label class="flex flex-col">
        <span class="text-gray-500">期間の開始日</span>
        <input v-model="validFrom" type="date" :class="inputClass" data-testid="tenko-contract-from" @input="onFromInput">
      </label>
      <label class="flex flex-col">
        <span class="text-gray-500">期間の終了日</span>
        <input v-model="validTo" type="date" :class="inputClass" data-testid="tenko-contract-to">
      </label>
      <label class="flex flex-col">
        <span class="text-gray-500">契約日</span>
        <input v-model="contractDay" type="date" :class="inputClass" data-testid="tenko-contract-date">
      </label>
      <label class="flex flex-col">
        <span class="text-gray-500">延長を許可する運輸局長</span>
        <input v-model="bureau" type="text" placeholder="九州運輸局長" :class="inputClass" data-testid="tenko-contract-bureau">
      </label>
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <button
        class="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm disabled:opacity-50"
        data-testid="tenko-contract-download"
        :disabled="busy || !!problem"
        @click="download"
      >
        {{ busy ? '作成中…' : '契約書をダウンロード' }}
      </button>
      <span v-if="problem" class="text-sm text-gray-500" data-testid="tenko-contract-problem">{{ problem }}</span>
    </div>
    <p v-if="missing.length" class="text-sm text-amber-700" data-testid="tenko-contract-missing">
      事業者の表に入っていないため空欄にしました: {{ missing.join('・') }}
    </p>
    <p v-if="error" class="text-sm text-red-600" data-testid="tenko-contract-error">{{ error }}</p>
  </div>
</template>
