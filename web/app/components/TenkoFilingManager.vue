<script setup lang="ts">
import { downloadFilingArchive, getTenkoFilingSettings, listFilingArchives, putTenkoFilingSettings, saveFilingArchive, type FilingArchive } from '~/utils/api'
import { ARRIVE_FILE, checkEgovFiling, fillSettingsFromFiling, parseEgovZip, type EgovFiling, type EgovFinding } from '~/utils/egov-filing'
import { jstTodayDate } from '~/utils/jst'
import {
  BUSINESS_TYPES, EGOV_OFFICE_SLOTS, FALLBACK_DEVICE_NAME, FILING_LEAD_DAYS, OFFICE_ROLES, TENKO_FORMS, buildFilledForm,
  deviceNameOptions, earliestStartDate, emptySettings, fetchProductInfo, saveBytes,
  type FilingKind, type FilingSettings, type ProductInfo, type TenkoForm,
} from '~/utils/tenko-forms'

/**
 * 点呼の届出 (システム管理者)。遠隔点呼・自動点呼の実施の届出の様式に、テナントに保存した値を差し込んで
 * ダウンロードさせる。提出は人が手で行う (e-Gov アプリ)。ダウンロードは保存前の入力のままでも書き込む。
 * 機器の名称と認定番号の既定は製品の設定 (tenko-forms の product/ippoan-tenko.json) から入れる (版を上げると切り替わる)。
 * 自動点呼機器の認定申請は製作元の手続なので、ここではなく auth.ippoan.org の開発者専用ページで作る。
 */

const ERRORS: Record<string, string> = {
  invalid_business_number: '事業者番号は半角数字 12 桁で入力してください',
  invalid_business_type: '事業種別を選び直してください',
  invalid_office: '営業所・車庫の名称と、実施・被実施の別を入力してください',
  too_many_offices: '営業所・車庫は 20 件までです',
  too_long: '入力が長すぎます (1 欄 500 文字まで)',
  invalid_postal_code: '郵便番号は半角数字 7 桁で入力してください',
  invalid_corporate_number: '法人番号は半角数字 13 桁で入力してください',
  too_many_partners: '受委託の相手の会社は 10 社までです',
  invalid_partner: '受委託の相手の会社と、その営業所の名称を入力してください',
  forbidden: 'システム管理者だけが変更できます',
}

const settings = ref<FilingSettings>(emptySettings())
const product = ref<ProductInfo>({ deviceName: FALLBACK_DEVICE_NAME, certPre: null, certPost: null })
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
  product.value = await fetchProductInfo()
  try {
    settings.value = adopt(await getTenkoFilingSettings())
  }
  catch (e) {
    loadError.value = messageOf(e, '設定を取得できませんでした')
  }
})

/** 読んだ値を画面の値にする。機器の名称・認定番号が空なら製品の設定の値を入れる */
function adopt(s: FilingSettings): FilingSettings {
  return {
    ...emptySettings(),
    ...s,
    device_name: s.device_name || product.value.deviceName,
    auto_cert_pre: s.auto_cert_pre || product.value.certPre,
    auto_cert_post: s.auto_cert_post || product.value.certPost,
  }
}

function addOffice() {
  settings.value.offices.push({ name: '', address: '', role: settings.value.offices.length ? 2 : 1 })
}

function removeOffice(i: number) {
  settings.value.offices.splice(i, 1)
}

function addPartner() {
  settings.value.partners.push({ name: '', address: null, representative: null, offices: [] })
}

function removePartner(i: number) {
  settings.value.partners.splice(i, 1)
}

async function save() {
  saving.value = true
  saveError.value = ''
  notice.value = ''
  try {
    settings.value = adopt(await putTenkoFilingSettings(settings.value))
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

/** 機器の名称は選択の欄で文字を選べないので、e-Gov の欄へ貼れるようにコピーする (手で打つと版の書き方が揺れる) */
const deviceNameCopied = ref(false)
async function copyDeviceName() {
  await navigator.clipboard.writeText(settings.value.device_name ?? '')
  deviceNameCopied.value = true
  setTimeout(() => { deviceNameCopied.value = false }, 2000)
}

async function download(form: TenkoForm) {
  busyForm.value = form.id
  downloadError.value = ''
  try {
    const { bytes, filename } = await buildFilledForm(form, settings.value, {
      kind: kind.value,
      applyDate: applyDate.value,
      startDate: startDate.value,
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

/** e-Gov の申請データ (一時保存・申請済みの控えの zip) を読み、保存した値と規則に照らした結果 */
interface EgovCheck {
  file: string
  bytes: Uint8Array
  /** ファイル名が `{到達番号}.zip` なら到達番号 (申請済みの控え)。でなければ空 */
  arriveId: string
  filing: EgovFiling | null
  findings: EgovFinding[]
  error: string
  saved: string
}
const egovChecks = ref<EgovCheck[]>([])

function runCheck(c: EgovCheck): EgovCheck {
  if (!c.filing) return c
  return { ...c, findings: checkEgovFiling(c.filing, settings.value, jstTodayDate()) }
}

async function checkEgovFiles(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files!)
  egovChecks.value = await Promise.all(files.map(async (f) => {
    const base = { file: f.name, arriveId: ARRIVE_FILE.exec(f.name)?.[1] ?? '', saved: '' }
    try {
      const bytes = new Uint8Array(await f.arrayBuffer())
      return runCheck({ ...base, bytes, filing: parseEgovZip(bytes), findings: [], error: '' })
    }
    catch (err) {
      return { ...base, bytes: new Uint8Array(), filing: null, findings: [], error: messageOf(err, '読めませんでした') }
    }
  }))
  input.value = ''
}

/** 申請データの値で「書き込む値」の空の欄を埋める (保存は「保存」で)。照らし直す */
function adoptFromFiling(c: EgovCheck) {
  settings.value = fillSettingsFromFiling(c.filing!, settings.value)
  notice.value = '申請データの値を空の欄に入れました。「保存」を押すと残ります'
  egovChecks.value = egovChecks.value.map(runCheck)
}

/** 申請済みの控えの一覧 */
const archives = ref<FilingArchive[]>([])
const archivesError = ref('')
async function loadArchives() {
  try {
    archives.value = await listFilingArchives()
    archivesError.value = ''
  }
  catch (e) {
    archivesError.value = messageOf(e, '控えの一覧を取得できませんでした')
  }
}
onMounted(loadArchives)

/** 申請済みの控えを到達番号で保存する (同じ到達番号は上書き) */
async function saveArchive(c: EgovCheck) {
  const f = c.filing!
  const meta = {
    procedure: f.procedure,
    procName: f.procName,
    reportKind: f.reportKind,
    tenkoType: f.tenkoType,
    startDate: f.startDate || f.entrust?.startDate || '',
    offices: f.offices.map(o => o.name),
    destinations: f.destinations,
  }
  try {
    await saveFilingArchive(c.arriveId, c.bytes, c.file, meta)
    egovChecks.value = egovChecks.value.map(x => x === c ? { ...x, saved: '控えを保存しました' } : x)
    await loadArchives()
  }
  catch (e) {
    egovChecks.value = egovChecks.value.map(x => x === c ? { ...x, saved: messageOf(e, '控えを保存できませんでした') } : x)
  }
}

const archiveError = ref('')
async function downloadArchive(a: FilingArchive) {
  archiveError.value = ''
  try {
    await downloadFilingArchive(a.id, a.name)
  }
  catch (e) {
    archiveError.value = messageOf(e, '控えをダウンロードできませんでした')
  }
}

/** 控えの要約 (保存のときに画面が付けたもの) */
function archiveSummary(a: FilingArchive): string {
  const m = (a.meta ?? {}) as Record<string, unknown>
  const parts = [m.reportKind, m.tenkoType, m.startDate ? `開始 ${String(m.startDate)}` : '']
  const offices = Array.isArray(m.offices) ? (m.offices as string[]).join('・') : ''
  return [...parts.filter(Boolean).map(String), offices].filter(Boolean).join(' / ') || String(m.procName ?? '')
}

/** 文字の欄 (ラベルと欄の名前) */
const OPERATOR_FIELDS = [
  ['operator_name', '氏名又は名称'],
  ['operator_kana', '氏名又は名称のフリガナ'],
  ['operator_corporate_number', '法人番号 (半角 13 桁)'],
  ['operator_postal_code', '郵便番号 (半角 7 桁)'],
  ['operator_address', '住所'],
  ['operator_address_kana', '住所のフリガナ'],
  ['operator_phone', '事業者の電話番号'],
  ['operator_representative', '代表者氏名'],
  ['operator_representative_kana', '代表者氏名のフリガナ'],
  ['operator_representative_title', '代表者の役職'],
  ['operator_contact_name', '担当者氏名'],
  ['operator_contact_kana', '担当者氏名のフリガナ'],
  ['operator_contact_dept', '担当者の部門名'],
  ['operator_contact_phone', '電話番号'],
  ['operator_contact_email', 'メールアドレス'],
  ['operator_contact_postal_code', '担当者の郵便番号 (事業者と違うときだけ)'],
  ['operator_contact_address', '担当者の住所 (事業者と違うときだけ)'],
] as const

const inputClass = 'w-full border rounded-lg px-2 py-1.5 text-sm'
</script>

<template>
  <div class="space-y-4" data-testid="tenko-filing">
    <div class="bg-white rounded-xl p-4 shadow-sm space-y-2">
      <p class="text-sm text-gray-600">
        遠隔点呼・自動点呼の実施の届出の様式を、「書き込む値」を書き込んだ状態でダウンロードします (一番下)。
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
          <span class="text-gray-500">事業者番号 (任意・半角 12 桁)</span>
          <input v-model="settings.business_number" :class="inputClass" inputmode="numeric" maxlength="12" placeholder="例: 012345678901" data-testid="tenko-filing-business-number">
          <span class="block text-xs text-gray-500 mt-1" data-testid="tenko-filing-business-number-hint">
            一般貨物自動車運送事業の許可のときに交付された許可書に書かれた 12 桁の番号です。0 で始まるときは 0 も入れます。e-Gov では任意の欄なので、分からなければ空欄のまま出せます。
          </span>
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
          <select v-model="o.role" :class="inputClass" data-testid="tenko-filing-office-role">
            <option v-for="(r, j) in OFFICE_ROLES" :key="r" :value="j + 1">{{ r }}</option>
          </select>
          <button class="text-sm text-red-600 hover:underline" @click="removeOffice(i)">削除</button>
        </div>
      </div>

      <div class="grid gap-3 sm:grid-cols-3">
        <label class="text-sm">
          <span class="text-gray-500">使用する機器の名称</span>
          <span class="flex items-center gap-2">
            <select v-model="settings.device_name" :class="inputClass" data-testid="tenko-filing-device-name">
              <option v-for="name in deviceNameOptions(settings.device_name, product.deviceName)" :key="name" :value="name">{{ name }}</option>
            </select>
            <button type="button" class="shrink-0 text-sm text-blue-600 hover:underline" data-testid="tenko-filing-device-name-copy" @click.prevent="copyDeviceName">
              {{ deviceNameCopied ? 'コピーしました' : 'コピー' }}
            </button>
          </span>
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

      <fieldset class="space-y-2" data-testid="tenko-filing-partners">
        <div class="flex items-center justify-between">
          <legend class="text-sm font-medium text-gray-700">受委託の相手の会社 (事業者間遠隔点呼の受委託の許可申請の委託者・受託者)</legend>
          <button class="text-sm text-blue-600 hover:underline" data-testid="tenko-filing-add-partner" @click="addPartner">＋ 追加</button>
        </div>
        <div v-for="(p, i) in settings.partners" :key="i" class="border rounded-lg p-3 space-y-2" data-testid="tenko-filing-partner">
          <div class="grid gap-2 sm:grid-cols-[2fr_3fr_2fr_auto] items-center">
            <input v-model="p.name" :class="inputClass" placeholder="氏名又は名称">
            <input v-model="p.address" :class="inputClass" placeholder="住所">
            <input v-model="p.representative" :class="inputClass" placeholder="代表者氏名">
            <button class="text-sm text-red-600 hover:underline" data-testid="tenko-filing-remove-partner" @click="removePartner(i)">削除</button>
          </div>
          <div v-for="(o, j) in p.offices" :key="j" class="grid gap-2 sm:grid-cols-[2fr_3fr_auto] items-center pl-4">
            <input v-model="o.name" :class="inputClass" placeholder="営業所の名称">
            <input v-model="o.address" :class="inputClass" placeholder="営業所の所在地">
            <button class="text-sm text-red-600 hover:underline" data-testid="tenko-filing-remove-partner-office" @click="p.offices.splice(j, 1)">削除</button>
          </div>
          <button class="text-sm text-blue-600 hover:underline pl-4" data-testid="tenko-filing-add-partner-office" @click="p.offices.push({ name: '', address: null })">＋ 営業所を追加</button>
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
        <label class="flex flex-col">
          <span class="text-gray-500">申請日</span>
          <input v-model="applyDate" type="date" class="border rounded-lg px-2 py-1">
        </label>
        <label class="flex flex-col">
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
        実施の届出は e-Gov アプリから、営業所を管轄する運輸支局へ、実施予定日の原則 {{ FILING_LEAD_DAYS }} 日前までに出します。
      </p>
      <p v-if="kind === 'auto' && !settings.auto_cert_pre && !settings.auto_cert_post" class="text-sm text-amber-700">
        自動点呼の届出には国交省の認定番号が要ります。認定が出ると、製品の設定から上の「認定番号」に自動で入ります。
      </p>
      <p v-if="settings.offices.length > EGOV_OFFICE_SLOTS" class="text-sm text-amber-700">
        e-Gov の参考様式に書けるのは営業所・車庫 {{ EGOV_OFFICE_SLOTS }} 件までです。6 件目からは別紙にしてください。
      </p>
      <p v-if="downloadError" class="text-sm text-red-600" data-testid="tenko-filing-download-error">{{ downloadError }}</p>
    </div>

    <!-- e-Gov の申請データの確認 -->
    <div class="bg-white rounded-xl p-4 shadow-sm space-y-3" data-testid="tenko-filing-egov-check">
      <h3 class="font-semibold text-gray-800">e-Gov の申請データを確かめる</h3>
      <p class="text-sm text-gray-600">
        e-Gov アプリで一時保存した申請データや、申請済みの控え (到達番号の名前の zip) を選ぶと、上の「書き込む値」と規則 (開始日・添付・提出先・申請者情報・受委託の相手) に照らして食い違いを出します。
        ファイルはこのブラウザの中で読みます。「控えとして保存」を押したときだけ、到達番号で保管します (e-Gov からは申請書・添付を後で取り出せないため)。
      </p>
      <input type="file" accept=".zip" multiple class="text-sm" data-testid="tenko-filing-egov-input" @change="checkEgovFiles">
      <div v-for="c in egovChecks" :key="c.file" class="border rounded-lg p-3 space-y-1 text-sm" data-testid="tenko-filing-egov-result">
        <div class="font-medium">{{ c.file }}</div>
        <p v-if="c.error" class="text-red-600">{{ c.error }}</p>
        <template v-else>
          <p v-if="c.filing!.procedure === 'filing'" class="text-gray-600">
            {{ c.filing!.reportKind }} / {{ c.filing!.tenkoType }} / 開始日 {{ c.filing!.startDate || '-' }} / 提出先 {{ c.filing!.destinations.join('、') || '-' }}
          </p>
          <p v-else-if="c.filing!.entrust" class="text-gray-600" data-testid="tenko-filing-egov-entrust">
            受委託の許可申請 / 委託者 {{ c.filing!.entrust.consignor.name || '-' }} → 受託者 {{ c.filing!.entrust.consignee.name || '-' }} / 期間 {{ c.filing!.entrust.startDate || '-' }} 〜 {{ c.filing!.entrust.endDate || '-' }} / 提出先 {{ c.filing!.destinations.join('、') || '-' }}
          </p>
          <p v-else class="text-gray-600">{{ c.filing!.procName || c.filing!.procId || '手続名なし' }}</p>
          <ul v-if="c.findings.length" class="space-y-0.5">
            <li v-for="(x, i) in c.findings" :key="i" :class="x.level === 'error' ? 'text-red-600' : 'text-amber-700'">
              {{ x.level === 'error' ? '要修正' : '確認' }}: {{ x.message }}
            </li>
          </ul>
          <p v-else class="text-green-700">食い違いは見つかりませんでした</p>
          <div class="flex flex-wrap items-center gap-3 pt-1">
            <button class="text-sm text-blue-600 hover:underline" data-testid="tenko-filing-egov-adopt" @click="adoptFromFiling(c)">
              空の欄にこの申請データの値を入れる
            </button>
            <button v-if="c.arriveId" class="text-sm text-blue-600 hover:underline" data-testid="tenko-filing-egov-archive" @click="saveArchive(c)">
              控えとして保存 (到達番号 {{ c.arriveId }})
            </button>
            <span v-if="c.saved" class="text-sm text-gray-700" data-testid="tenko-filing-egov-archive-result">{{ c.saved }}</span>
          </div>
        </template>
      </div>
    </div>

    <!-- 申請済みの控え -->
    <div class="bg-white rounded-xl p-4 shadow-sm space-y-3" data-testid="tenko-filing-archives">
      <h3 class="font-semibold text-gray-800">申請済みの控え</h3>
      <p v-if="archivesError" class="text-sm text-red-600" data-testid="tenko-filing-archives-error">{{ archivesError }}</p>
      <p v-else-if="!archives.length" class="text-sm text-gray-500">まだありません。上で到達番号の名前の zip を読み、「控えとして保存」を押してください。</p>
      <table v-else class="w-full text-sm">
        <thead>
          <tr class="text-left text-gray-500">
            <th class="py-1">到達番号</th>
            <th class="py-1">中身</th>
            <th class="py-1">保存</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in archives" :key="a.id" class="border-t" data-testid="tenko-filing-archive-row">
            <td class="py-1 font-mono">{{ a.id }}</td>
            <td class="py-1">{{ archiveSummary(a) }}</td>
            <td class="py-1">{{ a.saved_at.slice(0, 10) }}</td>
            <td class="py-1 text-right">
              <button class="text-blue-600 hover:underline" data-testid="tenko-filing-archive-download" @click="downloadArchive(a)">ダウンロード</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="archiveError" class="text-sm text-red-600" data-testid="tenko-filing-archive-error">{{ archiveError }}</p>
    </div>

  </div>
</template>
