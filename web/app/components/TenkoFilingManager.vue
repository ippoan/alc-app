<script setup lang="ts">
import { getTenkoFilingSettings, putTenkoFilingSettings } from '~/utils/api'
import { jstTodayDate } from '~/utils/jst'
import {
  BUSINESS_TYPES, EGOV_OFFICE_SLOTS, FILING_LEAD_DAYS, OFFICE_ROLES, TENKO_FORMS, buildFilledForm, earliestStartDate,
  emptySettings, isNotification, saveBytes,
  type FilingKind, type FilingSettings, type TenkoForm,
} from '~/utils/tenko-forms'

/**
 * 点呼の届出 (システム管理者)。遠隔点呼・自動点呼の届出と自動点呼機器の認定申請の様式に、
 * テナントに保存した値を差し込んでダウンロードさせる。提出は人が手で行う (e-Gov アプリ・国交省へのメール)。
 * ダウンロードは保存前の入力のままでも書き込む (保存は次に開いたときのため)。
 */

const ERRORS: Record<string, string> = {
  invalid_business_number: '事業者番号は半角数字 12 桁で入力してください',
  invalid_business_type: '事業種別を選び直してください',
  invalid_office: '営業所・車庫の名称と、実施・被実施の別を入力してください',
  too_many_offices: '営業所・車庫は 20 件までです',
  too_long: '入力が長すぎます (1 欄 500 文字まで)',
  forbidden: 'システム管理者だけが変更できます',
}

const settings = ref<FilingSettings>(emptySettings())
const loadError = ref('')
const saving = ref(false)
const saveError = ref('')
const notice = ref('')

const kind = ref<FilingKind>('remote')
const applyDate = ref(jstTodayDate())
const startDate = ref('')
/** 実施予定日の下限 (申請日の 10 日後)。申請日を後ろへずらして下限を割ったら、予定日を空に戻す */
const minStartDate = computed(() => earliestStartDate(applyDate.value))
watch(minStartDate, (min) => {
  if (min && startDate.value && startDate.value < min) startDate.value = ''
})
const busyForm = ref('')
const downloadError = ref('')

function messageOf(e: unknown, fallback: string): string {
  const message = e instanceof Error && e.message ? e.message : fallback
  const word = Object.keys(ERRORS).find(k => message.includes(k))
  return word ? ERRORS[word]! : message
}

onMounted(async () => {
  try {
    settings.value = { ...emptySettings(), ...(await getTenkoFilingSettings()) }
  }
  catch (e) {
    loadError.value = messageOf(e, '設定を取得できませんでした')
  }
})

function addOffice() {
  settings.value.offices.push({ name: '', address: '', role: settings.value.offices.length ? 2 : 1 })
}

function removeOffice(i: number) {
  settings.value.offices.splice(i, 1)
}

async function save() {
  saving.value = true
  saveError.value = ''
  notice.value = ''
  try {
    settings.value = { ...emptySettings(), ...(await putTenkoFilingSettings(settings.value)) }
    notice.value = '保存しました'
  }
  catch (e) {
    saveError.value = messageOf(e, '保存できませんでした')
  }
  finally {
    saving.value = false
  }
}

const forms = computed(() => TENKO_FORMS.filter(f => f.kinds.includes(kind.value)))

async function download(form: TenkoForm) {
  busyForm.value = form.id
  downloadError.value = ''
  try {
    const { bytes, filename } = await buildFilledForm(form, settings.value, {
      kind: kind.value,
      applyDate: applyDate.value,
      startDate: isNotification(kind.value) ? startDate.value : '',
    })
    saveBytes(bytes, filename, form.ext)
  }
  catch (e) {
    downloadError.value = messageOf(e, '様式を作れませんでした')
  }
  finally {
    busyForm.value = ''
  }
}

/** 文字の欄 (ラベルと欄の名前) */
const OPERATOR_FIELDS = [
  ['operator_name', '氏名又は名称'],
  ['operator_address', '住所'],
  ['operator_representative', '代表者氏名'],
  ['operator_contact_name', '担当者氏名'],
  ['operator_contact_phone', '電話番号'],
  ['operator_contact_email', 'メールアドレス'],
] as const

const APPLICANT_FIELDS = [
  ['applicant_name', '氏名又は名称 (製作事業者名)'],
  ['applicant_kana', 'フリガナ'],
  ['applicant_address', '住所'],
  ['applicant_contact_name', '担当者名'],
  ['applicant_contact_dept', '所属・役職'],
  ['applicant_contact_phone', '電話番号'],
  ['applicant_contact_email', 'メールアドレス'],
  ['product_url', '機器の概要のウェブサイトの URL (様式2)'],
] as const

const inputClass = 'w-full border rounded-lg px-2 py-1.5 text-sm'
</script>

<template>
  <div class="space-y-4" data-testid="tenko-filing">
    <div class="bg-white rounded-xl p-4 shadow-sm space-y-2">
      <p class="text-sm text-gray-600">
        遠隔点呼・自動点呼の届出と、自動点呼機器の認定申請の様式を、「書き込む値」を書き込んだ状態でダウンロードします (一番下)。
        届出は e-Gov アプリから、認定申請は国交省 安全政策課へメールで、人が提出します。
        様式の原本は毎週取り直している最新版 (ippoan/tenko-forms) を使います。
      </p>
      <p v-if="loadError" class="text-sm text-red-600" data-testid="tenko-filing-load-error">{{ loadError }}</p>
    </div>

    <!-- 設定 -->
    <div class="bg-white rounded-xl p-4 shadow-sm space-y-4" data-testid="tenko-filing-settings">
      <h3 class="font-semibold text-gray-800">書き込む値</h3>

      <div class="grid gap-3 sm:grid-cols-3">
        <label class="text-sm">
          <span class="text-gray-500">事業者番号 (許可書の 12 桁)</span>
          <input v-model="settings.business_number" :class="inputClass" inputmode="numeric" maxlength="12" data-testid="tenko-filing-business-number">
        </label>
        <label class="text-sm">
          <span class="text-gray-500">屋号等</span>
          <input v-model="settings.trade_name" :class="inputClass">
        </label>
        <label class="text-sm">
          <span class="text-gray-500">事業種別</span>
          <select v-model="settings.business_type" :class="inputClass">
            <option :value="null">未選択</option>
            <option v-for="(t, i) in BUSINESS_TYPES" :key="t" :value="i + 1">{{ i + 1 }} {{ t }}</option>
          </select>
        </label>
      </div>

      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-sm text-gray-500">点呼に係る営業所・車庫 (届出の申請 1 件目から順に書きます。車庫は管轄の営業所名も含めて)</span>
          <button class="text-sm text-blue-600 hover:underline" data-testid="tenko-filing-add-office" @click="addOffice">＋ 追加</button>
        </div>
        <div v-for="(o, i) in settings.offices" :key="i" class="grid gap-2 sm:grid-cols-[2fr_3fr_1fr_auto] items-center">
          <input v-model="o.name" :class="inputClass" placeholder="名称">
          <input v-model="o.address" :class="inputClass" placeholder="所在地">
          <select v-model="o.role" :class="inputClass">
            <option v-for="(r, j) in OFFICE_ROLES" :key="r" :value="j + 1">{{ r }}</option>
          </select>
          <button class="text-sm text-red-600 hover:underline" @click="removeOffice(i)">削除</button>
        </div>
      </div>

      <div class="grid gap-3 sm:grid-cols-3">
        <label class="text-sm">
          <span class="text-gray-500">使用する機器の名称</span>
          <input v-model="settings.device_name" :class="inputClass">
        </label>
        <label class="text-sm">
          <span class="text-gray-500">認定番号 (業務前自動点呼機器)</span>
          <input v-model="settings.auto_cert_pre" :class="inputClass">
        </label>
        <label class="text-sm">
          <span class="text-gray-500">認定番号 (業務後自動点呼機器)</span>
          <input v-model="settings.auto_cert_post" :class="inputClass">
        </label>
      </div>

      <fieldset class="space-y-2">
        <legend class="text-sm font-medium text-gray-700">届け出る事業者 (別紙7)</legend>
        <div class="grid gap-3 sm:grid-cols-2">
          <label v-for="[key, label] in OPERATOR_FIELDS" :key="key" class="text-sm">
            <span class="text-gray-500">{{ label }}</span>
            <input v-model="settings[key]" :class="inputClass">
          </label>
        </div>
      </fieldset>

      <fieldset class="space-y-2">
        <legend class="text-sm font-medium text-gray-700">自動点呼機器の認定申請者 (様式1・様式2)</legend>
        <div class="grid gap-3 sm:grid-cols-2">
          <label v-for="[key, label] in APPLICANT_FIELDS" :key="key" class="text-sm">
            <span class="text-gray-500">{{ label }}</span>
            <input v-model="settings[key]" :class="inputClass">
          </label>
        </div>
      </fieldset>

      <div class="flex items-center gap-3">
        <button
          class="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm disabled:opacity-50"
          data-testid="tenko-filing-save"
          :disabled="saving"
          @click="save"
        >
          {{ saving ? '保存中…' : '保存' }}
        </button>
        <span v-if="notice" class="text-sm text-green-700" data-testid="tenko-filing-notice">{{ notice }}</span>
        <span v-if="saveError" class="text-sm text-red-600" data-testid="tenko-filing-save-error">{{ saveError }}</span>
      </div>
    </div>
    <!-- ダウンロード -->
    <div class="bg-white rounded-xl p-4 shadow-sm space-y-3" data-testid="tenko-filing-download">
      <h3 class="font-semibold text-gray-800">記入済みの様式をダウンロード</h3>
      <div class="flex flex-wrap items-end gap-4 text-sm">
        <label class="flex items-center gap-1">
          <input v-model="kind" type="radio" value="remote" data-testid="tenko-filing-kind-remote"> 遠隔点呼の実施の届出
        </label>
        <label class="flex items-center gap-1">
          <input v-model="kind" type="radio" value="auto" data-testid="tenko-filing-kind-auto"> 自動点呼の実施の届出 (認定後)
        </label>
        <label class="flex items-center gap-1">
          <input v-model="kind" type="radio" value="nintei" data-testid="tenko-filing-kind-nintei"> 自動点呼機器の認定申請
        </label>
        <label class="flex flex-col">
          <span class="text-gray-500">申請日</span>
          <input v-model="applyDate" type="date" class="border rounded-lg px-2 py-1">
        </label>
        <label v-if="isNotification(kind)" class="flex flex-col">
          <span class="text-gray-500">実施予定日 (申請の {{ FILING_LEAD_DAYS }} 日後以降)</span>
          <input v-model="startDate" type="date" :min="minStartDate || undefined" class="border rounded-lg px-2 py-1" data-testid="tenko-filing-start-date">
        </label>
      </div>
      <ul class="divide-y">
        <li v-for="form in forms" :key="form.id" class="flex items-center justify-between py-2">
          <span class="text-sm">{{ form.label }}</span>
          <button
            class="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm disabled:opacity-50"
            :data-testid="`tenko-filing-dl-${form.id}`"
            :disabled="!!busyForm"
            @click="download(form)"
          >
            {{ busyForm === form.id ? '作成中…' : '記入済みをダウンロード' }}
          </button>
        </li>
      </ul>
      <p class="text-sm text-gray-600" data-testid="tenko-filing-kind-note">
        <template v-if="kind === 'nintei'">
          認定申請は一歩庵点呼の製作元が国交省 物流・自動車局 安全政策課へメールで出します (e-Gov ではありません)。
          審査で追加資料・現品の提示・デモンストレーションを求められることがあります。様式3-1・3-2 (自己チェック表) と根拠資料は別に用意します。
        </template>
        <template v-else>
          実施の届出は e-Gov アプリから、営業所を管轄する運輸支局へ、実施予定日の原則 {{ FILING_LEAD_DAYS }} 日前までに出します。
        </template>
      </p>
      <p v-if="kind === 'auto' && !settings.auto_cert_pre && !settings.auto_cert_post" class="text-sm text-amber-700">
        自動点呼の届出には国交省の認定番号が要ります。認定が出たら下の「認定番号」に入力してください。
      </p>
      <p v-if="settings.offices.length > EGOV_OFFICE_SLOTS" class="text-sm text-amber-700">
        e-Gov の参考様式に書けるのは営業所・車庫 {{ EGOV_OFFICE_SLOTS }} 件までです。6 件目からは別紙にしてください。
      </p>
      <p v-if="downloadError" class="text-sm text-red-600" data-testid="tenko-filing-download-error">{{ downloadError }}</p>
    </div>

  </div>
</template>
