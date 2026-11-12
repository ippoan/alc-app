<script setup lang="ts">
import {
  downloadFilingArchive, fetchFilingArchive, getEgovApplyStatus, getTenkoFilingSettings, listFilingArchives, logoutEgov,
  listTenkoCompanies, putTenkoFilingSettings, saveFilingArchive, setFilingArchiveCompanies,
  type EgovApplyStatus, type FilingArchive,
} from '~/utils/api'
import type { TenkoCompany } from '~/types'
import {
  ARRIVE_FILE, ARRIVE_ID, checkEgovFiling, fillSettingsFromFiling, listEgovZipFiles, parseEgovZip,
  type EgovFiling, type EgovFinding,
} from '~/utils/egov-filing'
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
 *
 * 事業者ごと: 上の事業者の表で選んだ事業者の「書き込む値」と申請済みの控えを出す (事業者は TenkoCompanyManager)。
 * どの事業者にも付いていない控えは「振り分けていない控え」として全事業者の画面に出し、付けられるようにする。
 *
 * 申請済みの控え (Refs #676): 行ごとに e-Gov での状況 (e-Gov にログインしたとき) と egov-check の詳細へのリンクを出す。
 * `?arrive=<到達番号>` で、その控えの中身 (申請書・添付・照らした結果) を直接開く。egov-check とは統合しない
 * (あちらは e-Gov の手続一般を見る道具)。e-Gov のトークンは server route の HttpOnly の cookie にだけある。
 */

/** egov-check (ippoan/nuxt-egov) の申請の詳細 */
const EGOV_CHECK_APPLY = 'https://egov-check.ippoan.org/apply/'

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
  company_required: '事業者を選んでください',
  invalid_company: '事業者を選び直してください',
  forbidden: 'システム管理者だけが変更できます',
}

/** 事業者の一覧と、いま選んでいる事業者 (無ければ空) */
const companies = ref<TenkoCompany[]>([])
const companyId = ref('')

/** 一覧を読み、選んでいる事業者が無ければ既定の事業者 (無ければ先頭) を選ぶ */
async function loadCompanies() {
  try {
    companies.value = await listTenkoCompanies()
  }
  catch (e) {
    loadError.value = messageOf(e, '事業者を取得できませんでした')
    return
  }
  if (!companies.value.some(c => c.id === companyId.value)) {
    companyId.value = (companies.value.find(c => c.is_self) ?? companies.value[0])?.id ?? ''
  }
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
  await loadCompanies()
})

/** 選んだ事業者の書き込む値を読む (切り替えが早いときは、古い応答を捨てる) */
watch(companyId, async (id) => {
  loadError.value = ''
  notice.value = ''
  saveError.value = ''
  if (!id) {
    settings.value = emptySettings()
    return
  }
  try {
    const s = await getTenkoFilingSettings(id)
    if (id === companyId.value) settings.value = adopt(s)
  }
  catch (e) {
    if (id === companyId.value) loadError.value = messageOf(e, '設定を取得できませんでした')
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
    settings.value = adopt(await putTenkoFilingSettings(companyId.value, settings.value))
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
    return
  }
  await loadEgovStatuses()
}

/** 選んだ事業者の控えと、どの事業者にも付いていない控え (全事業者の画面に出す) */
const shownArchives = computed(() => [
  ...archives.value.filter(a => a.company_ids.includes(companyId.value)),
  ...archives.value.filter(a => !a.company_ids.length),
])

function companyNames(a: FilingArchive): string {
  return a.company_ids.map(id => companies.value.find(c => c.id === id)?.name ?? '').filter(Boolean).join('・')
}

/** 保存の後、選んでいる事業者を控えに付ける (すでに付いている事業者は残す) */
async function attachSelected(arriveId: string) {
  if (!companyId.value) return
  const current = archives.value.find(a => a.id === arriveId)?.company_ids ?? []
  await setFilingArchiveCompanies(arriveId, [...new Set([...current, companyId.value])])
}

/** 付け替えの欄を開いている控え (到達番号) と、その選び */
const assigning = ref('')
const assignIds = ref<string[]>([])
const assignError = ref('')

function startAssign(a: FilingArchive) {
  assignError.value = ''
  assignIds.value = [...a.company_ids]
  assigning.value = assigning.value === a.id ? '' : a.id
}

async function saveAssign(a: FilingArchive) {
  assignError.value = ''
  try {
    await setFilingArchiveCompanies(a.id, assignIds.value)
    assigning.value = ''
    await loadArchives()
  }
  catch (e) {
    assignError.value = messageOf(e, '事業者を付けられませんでした')
  }
}

/** URL の 1 つのクエリを書き換える (画面の他のクエリは残す。履歴は増やさない) */
function setQuery(key: string, value: string | null) {
  const u = new URL(window.location.href)
  if (value) u.searchParams.set(key, value)
  else u.searchParams.delete(key)
  window.history.replaceState(window.history.state, '', `${u.pathname}${u.search}`)
}

onMounted(async () => {
  const q = new URLSearchParams(window.location.search)
  if (q.get('egov') === 'ng') {
    egovLoginFailed.value = true
    setQuery('egov', null)
  }
  const arrive = q.get('arrive') ?? ''
  if (arrive) await openArchive(arrive)
  await loadArchives()
  // 事業者が付いている控えを直接開いたときは、その事業者を選んだ状態にする
  const owners = archives.value.find(a => a.id === arrive)?.company_ids ?? []
  if (owners.length && !owners.includes(companyId.value)) companyId.value = owners[0]!
})

/** e-Gov での状況を出すか (本番のソフトウェア ID に戻り先を登録してから 'on') */
const egovEnabled = useRuntimeConfig().public.egovLogin === 'on'
/** 控えの到達番号ごとの e-Gov での状況 (文字は取れなかった理由) */
const egovStatuses = ref<Record<string, EgovApplyStatus | string>>({})
const egovLoginNeeded = ref(false)
const egovLoginFailed = ref(false)

async function loadEgovStatuses() {
  if (!egovEnabled) return
  let needLogin = false
  const entries = await Promise.all(archives.value.map(async (a): Promise<[string, EgovApplyStatus | string | null]> => {
    try {
      const st = await getEgovApplyStatus(a.id)
      if (!st) needLogin = true
      return [a.id, st]
    }
    catch (e) {
      return [a.id, messageOf(e, 'e-Gov の状況を取得できませんでした')]
    }
  }))
  egovLoginNeeded.value = needLogin
  egovStatuses.value = Object.fromEntries(entries.filter((x): x is [string, EgovApplyStatus | string] => x[1] !== null))
}

/** e-Gov のログインの入口 (済んだらいまの画面へ戻る) */
function egovLoginHref(): string {
  return `/api/egov/login?return=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`
}

async function egovLogout() {
  await logoutEgov()
  egovStatuses.value = {}
  egovLoginNeeded.value = true
}

/** 状況のバッジの文字 (取れなかったら「取得できません」、未ログインなら「未確認」) */
function egovLabel(st: EgovApplyStatus | string | undefined): string {
  if (typeof st === 'object') return st.status
  return st ? '取得できません' : '未確認'
}

/** 状況のバッジの色 (egov-check の一覧と同じ区分: 到達・審査中・手続終了・取下げ) */
function egovTone(st: EgovApplyStatus | string | undefined): string {
  if (typeof st === 'string') return 'bg-red-50 text-red-700 ring-red-600/20'
  const s = st?.status ?? ''
  if (s.includes('手続終了')) return 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
  if (s.includes('審査中')) return 'bg-amber-50 text-amber-800 ring-amber-600/20'
  if (s.includes('取下げ')) return 'bg-gray-100 text-gray-600 ring-gray-500/20'
  if (s.includes('到達')) return 'bg-blue-50 text-blue-700 ring-blue-600/20'
  return 'bg-gray-50 text-gray-500 ring-gray-400/20'
}

/**
 * e-Gov アプリの「ステータス」の段。API v2 の申請案件取得が返すのは到達日時と呼んだ時点の状況だけで、
 * 段ごとの日時・履歴は無い (e-Gov の電子申請 API の FAQ 3)。なので日時は到達だけ出す
 */
const EGOV_STAGES = ['到達', '審査中', '審査終了', '手続終了'] as const

/** いまの段の位置 (取下げ・知らない状況は -1) */
function egovStageIndex(status: string): number {
  if (status.includes('取下げ')) return -1
  for (let i = EGOV_STAGES.length - 1; i >= 0; i--) {
    if (status.includes(EGOV_STAGES[i]!)) return i
  }
  return -1
}

/** 開いている控えの e-Gov での状況 (一覧で取ったもの) */
const openedEgov = computed(() => opened.value ? egovStatuses.value[opened.value.arriveId] : undefined)

/** 一覧の行の 2 段目: 手続名・提出先・到達日時 */
function egovLine(st: EgovApplyStatus): string {
  return [st.proc_name, st.submission_destination, `到達 ${st.arrive_date.slice(0, 16)}`].filter(Boolean).join(' ・ ')
}

/** 開いた控えに並べる、申請案件取得が返す項目 (空の項目は出さない) */
function egovFields(st: EgovApplyStatus): [string, string][] {
  const rows: [string, string][] = [
    ['手続名', st.proc_name],
    ['提出先', st.submission_destination],
    ['到達日時', st.arrive_date],
    ['法人名', st.corporation_name],
    ['申請者', st.applicant_name],
    ['提出したアカウント', st.applied_account],
    ['納付状況', st.pay_status],
  ]
  return rows.filter(([, v]) => v)
}

/** 通知・公文書の件数 (1 件以上は目立たせる。補正の連絡は通知で来る) */
function egovCounts(st: EgovApplyStatus): { label: string, n: number }[] {
  return [{ label: '通知', n: st.notice_count }, { label: '公文書', n: st.doc_count }]
}

/** 開いている控えの中身 (`?arrive=`) */
interface OpenedArchive {
  arriveId: string
  loading: boolean
  /** その到達番号の控えが未保存 */
  missing: boolean
  error: string
  filing: EgovFiling | null
  files: { path: string, name: string, size: number, url: string }[]
  saved: string
}
const opened = ref<OpenedArchive | null>(null)

function mimeOf(name: string): string {
  if (/\.pdf$/i.test(name)) return 'application/pdf'
  if (/\.xml$/i.test(name)) return 'application/xml'
  return 'application/octet-stream'
}

function closeArchive() {
  opened.value?.files.forEach(f => URL.revokeObjectURL(f.url))
  opened.value = null
  setQuery('arrive', null)
}

async function openArchive(arriveId: string) {
  opened.value?.files.forEach(f => URL.revokeObjectURL(f.url))
  const base: OpenedArchive = { arriveId, loading: true, missing: false, error: '', filing: null, files: [], saved: '' }
  opened.value = base
  setQuery('arrive', arriveId)
  if (!ARRIVE_ID.test(arriveId)) {
    opened.value = { ...base, loading: false, error: '到達番号の形ではありません' }
    return
  }
  try {
    const bytes = await fetchFilingArchive(arriveId)
    if (!bytes) {
      opened.value = { ...base, loading: false, missing: true }
      return
    }
    const files = listEgovZipFiles(bytes).map(f => ({
      path: f.path,
      name: f.name,
      size: f.bytes.length,
      url: URL.createObjectURL(new Blob([f.bytes as BlobPart], { type: mimeOf(f.name) })),
    }))
    let filing: EgovFiling | null = null
    let error = ''
    try {
      filing = parseEgovZip(bytes)
    }
    catch (e) {
      error = messageOf(e, '申請データを読めませんでした')
    }
    opened.value = { ...base, loading: false, filing, files, error }
  }
  catch (e) {
    opened.value = { ...base, loading: false, error: messageOf(e, '控えを取得できませんでした') }
  }
}

/** 開いている控えを、いまの「書き込む値」と規則に照らした結果 */
const openedFindings = computed(() => opened.value?.filing ? checkEgovFiling(opened.value.filing, settings.value, jstTodayDate()) : [])

/** 未保存の到達番号に、手元の zip を控えとして保存する (ファイル名でなく開いている到達番号で) */
async function saveMissing(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files![0]!
  const o = opened.value!
  input.value = ''
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    await saveFilingArchive(o.arriveId, bytes, file.name, archiveMeta(parseEgovZip(bytes)))
    await attachSelected(o.arriveId)
  }
  catch (err) {
    opened.value = { ...o, saved: messageOf(err, '控えを保存できませんでした') }
    return
  }
  await openArchive(o.arriveId)
  await loadArchives()
}

/** 申請済みの控えを到達番号で保存する (同じ到達番号は上書き) */
function archiveMeta(f: EgovFiling): Record<string, unknown> {
  return {
    procedure: f.procedure,
    procName: f.procName,
    reportKind: f.reportKind,
    tenkoType: f.tenkoType,
    startDate: f.startDate || f.entrust?.startDate || '',
    offices: f.offices.map(o => o.name),
    destinations: f.destinations,
  }
}

async function saveArchive(c: EgovCheck) {
  try {
    await saveFilingArchive(c.arriveId, c.bytes, c.file, archiveMeta(c.filing!))
    await attachSelected(c.arriveId)
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

    <TenkoCompanyManager v-model="companyId" :companies="companies" @changed="loadCompanies" />

    <!-- 開いている控えの中身 (?arrive=) -->
    <div v-if="opened" class="bg-white rounded-xl p-4 shadow-sm space-y-3" data-testid="tenko-filing-opened">
      <div class="flex items-center justify-between gap-3">
        <h3 class="font-semibold text-gray-800">申請済みの控え (到達番号 <span class="font-mono">{{ opened.arriveId }}</span>)</h3>
        <div class="flex items-center gap-3 text-sm">
          <a :href="`${EGOV_CHECK_APPLY}${opened.arriveId}`" target="_blank" rel="noopener" class="text-blue-600 hover:underline" data-testid="tenko-filing-opened-egov-check">egov-check で e-Gov の状況を見る</a>
          <button class="text-gray-600 hover:underline" data-testid="tenko-filing-opened-close" @click="closeArchive">閉じる</button>
        </div>
      </div>
      <div v-if="egovEnabled && openedEgov" class="rounded-lg border border-gray-200 px-4 py-3" data-testid="tenko-filing-opened-egov">
        <p v-if="typeof openedEgov === 'string'" class="text-sm text-red-600">{{ openedEgov }}</p>
        <template v-else>
          <div class="flex items-center justify-between gap-3">
            <span class="text-sm font-medium text-gray-800">e-Gov のステータス: {{ openedEgov.status }}</span>
            <span class="flex gap-2">
              <span
                v-for="c in egovCounts(openedEgov)"
                :key="c.label"
                class="text-xs"
                :class="c.n ? 'font-medium text-amber-700' : 'text-gray-400'"
              >{{ c.label }} {{ c.n }}</span>
            </span>
          </div>
          <ol v-if="egovStageIndex(openedEgov.status) >= 0" class="mt-3 grid grid-cols-4" data-testid="tenko-filing-opened-egov-stages">
            <li
              v-for="(stage, i) in EGOV_STAGES"
              :key="stage"
              class="relative flex flex-col items-center gap-1 text-center"
              :data-state="i < egovStageIndex(openedEgov.status) ? 'done' : i === egovStageIndex(openedEgov.status) ? 'current' : 'todo'"
            >
              <span
                v-if="i > 0"
                class="absolute right-1/2 top-2 h-0.5 w-full -translate-y-1/2"
                :class="i <= egovStageIndex(openedEgov.status) ? 'bg-blue-500' : 'bg-gray-200'"
              />
              <span
                class="relative z-10 h-4 w-4 rounded-full border-2"
                :class="i < egovStageIndex(openedEgov.status) ? 'border-blue-500 bg-blue-500'
                  : i === egovStageIndex(openedEgov.status) ? 'border-blue-500 bg-white ring-4 ring-blue-100' : 'border-gray-300 bg-white'"
              />
              <span class="text-xs" :class="i === egovStageIndex(openedEgov.status) ? 'font-semibold text-blue-700' : i < egovStageIndex(openedEgov.status) ? 'text-gray-700' : 'text-gray-400'">{{ stage }}</span>
              <span v-if="i === 0" class="text-[11px] text-gray-500">{{ openedEgov.arrive_date.slice(0, 16) }}</span>
            </li>
          </ol>
          <dl class="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr_auto_1fr]" data-testid="tenko-filing-opened-egov-fields">
            <template v-for="[label, value] in egovFields(openedEgov)" :key="label">
              <dt class="text-gray-500">{{ label }}</dt>
              <dd class="text-gray-800">{{ value }}</dd>
            </template>
          </dl>
          <div v-if="openedEgov.notices.length" class="mt-3 space-y-1" data-testid="tenko-filing-opened-egov-notices">
            <div class="text-xs font-medium text-gray-600">通知</div>
            <div v-for="(n, i) in openedEgov.notices" :key="i" class="rounded-md bg-amber-50 px-3 py-1.5 text-xs">
              <span v-if="n.type" class="mr-1 rounded bg-amber-100 px-1 text-amber-800">{{ n.type }}</span>
              <span class="font-medium text-gray-800">{{ n.title || '件名なし' }}</span>
              <span class="ml-2 text-gray-500">{{ n.issue_date.slice(0, 16) }}<template v-if="n.issuer"> ・{{ n.issuer }}</template></span>
              <span v-if="n.correct_expired_date" class="ml-2 font-medium text-red-600">補正期限 {{ n.correct_expired_date }}</span>
            </div>
          </div>
          <div v-if="openedEgov.documents.length" class="mt-3 space-y-1" data-testid="tenko-filing-opened-egov-documents">
            <div class="text-xs font-medium text-gray-600">公文書</div>
            <div v-for="(d, i) in openedEgov.documents" :key="i" class="rounded-md bg-gray-50 px-3 py-1.5 text-xs">
              <span class="font-medium text-gray-800">{{ d.title || '件名なし' }}</span>
              <span class="ml-2 text-gray-500">{{ d.issue_date.slice(0, 16) }}</span>
              <span class="ml-2" :class="d.downloaded_date ? 'text-gray-500' : 'text-amber-700'">
                {{ d.downloaded_date ? '取得済み' : `未取得${d.expired_date ? ` (取得期限 ${d.expired_date})` : ''}` }}
              </span>
            </div>
          </div>
          <p class="mt-3 text-[11px] text-gray-400">審査開始・審査終了・手続終了の日時は e-Gov の API から取れないため出していません (e-Gov アプリのマイページで見られます)。公文書と通知の本文は egov-check で開けます。</p>
        </template>
      </div>
      <p v-if="opened.loading" class="text-sm text-gray-500">読み込み中…</p>
      <template v-else-if="opened.missing">
        <p class="text-sm text-amber-700" data-testid="tenko-filing-opened-missing">
          この到達番号の控えは未保存です。e-Gov アプリのマイページでこの申請の申請データ (zip) を取り出し、ここで選ぶと控えとして保存します。
        </p>
        <input type="file" accept=".zip" class="text-sm" data-testid="tenko-filing-opened-save-input" @change="saveMissing">
        <p v-if="opened.saved" class="text-sm text-red-600" data-testid="tenko-filing-opened-save-error">{{ opened.saved }}</p>
      </template>
      <template v-else>
        <p v-if="opened.error" class="text-sm text-red-600" data-testid="tenko-filing-opened-error">{{ opened.error }}</p>
        <template v-if="opened.filing">
          <p v-if="opened.filing.procedure === 'filing'" class="text-sm text-gray-600" data-testid="tenko-filing-opened-summary">
            {{ opened.filing.reportKind }} / {{ opened.filing.tenkoType }} / 申請日 {{ opened.filing.applyDate || '-' }} / 開始日 {{ opened.filing.startDate || '-' }} / 提出先 {{ opened.filing.destinations.join('、') || '-' }}
          </p>
          <p v-else-if="opened.filing.entrust" class="text-sm text-gray-600" data-testid="tenko-filing-opened-summary">
            受委託の許可申請 / 委託者 {{ opened.filing.entrust.consignor.name || '-' }} → 受託者 {{ opened.filing.entrust.consignee.name || '-' }} / 期間 {{ opened.filing.entrust.startDate || '-' }} 〜 {{ opened.filing.entrust.endDate || '-' }}
          </p>
          <p v-else class="text-sm text-gray-600" data-testid="tenko-filing-opened-summary">{{ opened.filing.procName || opened.filing.procId || '手続名なし' }}</p>
          <ul v-if="openedFindings.length" class="space-y-0.5 text-sm" data-testid="tenko-filing-opened-findings">
            <li v-for="(x, i) in openedFindings" :key="i" :class="x.level === 'error' ? 'text-red-600' : 'text-amber-700'">
              {{ x.level === 'error' ? '要修正' : '確認' }}: {{ x.message }}
            </li>
          </ul>
          <p v-else class="text-sm text-green-700">いまの「書き込む値」と規則に照らして、食い違いは見つかりませんでした</p>
        </template>
        <div class="text-sm">
          <div class="text-gray-500">中のファイル (申請書・添付)</div>
          <ul class="divide-y" data-testid="tenko-filing-opened-files">
            <li v-for="f in opened.files" :key="f.path" class="flex items-center justify-between py-1">
              <span class="truncate" :title="f.path">{{ f.name }}</span>
              <span class="flex items-center gap-3 shrink-0">
                <span class="text-gray-400">{{ Math.ceil(f.size / 1024) }} KB</span>
                <a :href="f.url" target="_blank" rel="noopener" class="text-blue-600 hover:underline">開く</a>
                <a :href="f.url" :download="f.name" class="text-blue-600 hover:underline">保存</a>
              </span>
            </li>
          </ul>
        </div>
      </template>
    </div>

    <!-- 設定 -->
    <div v-if="!companyId" class="bg-white rounded-xl p-4 shadow-sm" data-testid="tenko-filing-no-company">
      <p class="text-sm text-gray-600">事業者を追加してください</p>
    </div>
    <div v-else class="bg-white rounded-xl p-4 shadow-sm space-y-4" data-testid="tenko-filing-settings">
      <h3 class="font-semibold text-gray-800">書き込む値<span class="ml-2 text-sm font-normal text-gray-500" data-testid="tenko-filing-company-name">{{ companies.find(c => c.id === companyId)?.name }}</span></h3>

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
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="font-semibold text-gray-800">申請済みの控え</h3>
        <button
          v-if="egovEnabled && !egovLoginNeeded && Object.keys(egovStatuses).length"
          class="text-xs text-gray-500 hover:text-gray-800"
          data-testid="tenko-filing-egov-logout"
          @click="egovLogout"
        >
          e-Gov からログアウト
        </button>
      </div>
      <div
        v-if="egovEnabled && (egovLoginNeeded || egovLoginFailed)"
        class="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-blue-50 px-3 py-2.5 text-sm"
        data-testid="tenko-filing-egov-login"
      >
        <span v-if="egovLoginFailed" class="text-red-600" data-testid="tenko-filing-egov-login-failed">e-Gov にログインできませんでした。もう一度お試しください。</span>
        <span v-else class="text-blue-900">e-Gov にログインすると、控えごとに e-Gov での状況 (ステータス・通知・公文書) が出ます。</span>
        <a
          v-if="egovLoginNeeded"
          :href="egovLoginHref()"
          class="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-blue-700"
          data-testid="tenko-filing-egov-login-button"
        >e-Gov にログイン</a>
      </div>
      <p v-if="archivesError" class="text-sm text-red-600" data-testid="tenko-filing-archives-error">{{ archivesError }}</p>
      <p v-else-if="!shownArchives.length" class="text-sm text-gray-500">まだありません。上で到達番号の名前の zip を読み、「控えとして保存」を押してください。</p>
      <div v-else class="overflow-x-auto rounded-lg border border-gray-200">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-left text-xs font-medium text-gray-500">
            <tr>
              <th class="px-3 py-2">到達番号</th>
              <th v-if="egovEnabled" class="px-3 py-2">e-Gov の状況</th>
              <th class="px-3 py-2">控え保存</th>
              <th class="w-px px-3 py-2" />
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <template v-for="a in shownArchives" :key="a.id">
            <tr
              class="cursor-pointer transition-colors"
              :class="opened?.arriveId === a.id ? 'bg-blue-50' : 'hover:bg-gray-50'"
              title="中身を見る"
              data-testid="tenko-filing-archive-row"
              @click="openArchive(a.id)"
            >
              <td class="px-3 py-2.5">
                <div class="font-mono text-sm text-gray-900">
                  {{ a.id }}
                  <span v-if="!a.company_ids.length" class="ml-2 rounded-full bg-amber-50 px-2 py-0.5 font-sans text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-600/20" data-testid="tenko-filing-archive-unassigned">振り分けていない控え</span>
                  <span v-else class="ml-2 font-sans text-xs text-gray-500" data-testid="tenko-filing-archive-companies">{{ companyNames(a) }}</span>
                </div>
                <div v-if="typeof egovStatuses[a.id] === 'object'" class="mt-0.5 text-xs text-gray-600" data-testid="tenko-filing-archive-egov-line">
                  {{ egovLine(egovStatuses[a.id] as EgovApplyStatus) }}
                </div>
                <div v-if="archiveSummary(a)" class="mt-0.5 text-xs text-gray-500" data-testid="tenko-filing-archive-summary">{{ archiveSummary(a) }}</div>
              </td>
              <td v-if="egovEnabled" class="px-3 py-2.5">
                <div class="flex flex-wrap items-center gap-2">
                  <span
                    class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset"
                    :class="egovTone(egovStatuses[a.id])"
                    :title="typeof egovStatuses[a.id] === 'string' ? egovStatuses[a.id] as string : undefined"
                    data-testid="tenko-filing-archive-egov"
                  >
                    <span class="h-1.5 w-1.5 rounded-full bg-current" />
                    {{ egovLabel(egovStatuses[a.id]) }}
                  </span>
                  <template v-if="typeof egovStatuses[a.id] === 'object'">
                    <span
                      v-for="c in egovCounts(egovStatuses[a.id] as EgovApplyStatus)"
                      :key="c.label"
                      class="text-xs"
                      :class="c.n ? 'font-medium text-amber-700' : 'text-gray-400'"
                      data-testid="tenko-filing-archive-count"
                    >{{ c.label }} {{ c.n }}</span>
                  </template>
                </div>
              </td>
              <td class="whitespace-nowrap px-3 py-2.5 text-xs text-gray-500">{{ a.saved_at.slice(0, 10) }}</td>
              <td class="px-2 py-2.5" @click.stop>
                <div class="flex items-center justify-end gap-0.5">
                  <button
                    class="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                    title="事業者を付け替える"
                    aria-label="事業者を付け替える"
                    data-testid="tenko-filing-archive-assign"
                    @click="startAssign(a)"
                  >
                    <svg class="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 10l7-7h7v7l-7 7-7-7zM13 7h.01" stroke-linecap="round" stroke-linejoin="round" /></svg>
                  </button>
                  <a
                    :href="`${EGOV_CHECK_APPLY}${a.id}`"
                    target="_blank"
                    rel="noopener"
                    class="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                    title="egov-check で開く"
                    aria-label="egov-check で開く"
                    data-testid="tenko-filing-archive-egov-check"
                  >
                    <svg class="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M11 3h6v6M17 3l-8 8M15 11v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" stroke-linecap="round" stroke-linejoin="round" /></svg>
                  </a>
                  <button
                    class="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                    title="zip をダウンロード"
                    aria-label="zip をダウンロード"
                    data-testid="tenko-filing-archive-download"
                    @click="downloadArchive(a)"
                  >
                    <svg class="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M10 3v10M6 9l4 4 4-4M4 16h12" stroke-linecap="round" stroke-linejoin="round" /></svg>
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="assigning === a.id" class="bg-gray-50" data-testid="tenko-filing-archive-assign-row">
              <td :colspan="egovEnabled ? 4 : 3" class="px-3 py-2.5">
                <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  <span class="text-gray-500">付ける事業者 (複数可)</span>
                  <label v-for="c in companies" :key="c.id" class="flex items-center gap-1 text-gray-800">
                    <input v-model="assignIds" type="checkbox" :value="c.id" data-testid="tenko-filing-archive-assign-company">
                    {{ c.name }}
                  </label>
                  <button class="rounded-lg bg-blue-600 px-3 py-1 text-xs text-white" data-testid="tenko-filing-archive-assign-save" @click="saveAssign(a)">保存</button>
                  <span v-if="assignError" class="text-red-600" data-testid="tenko-filing-archive-assign-error">{{ assignError }}</span>
                </div>
              </td>
            </tr>
            </template>
          </tbody>
        </table>
      </div>
      <p v-if="archiveError" class="text-sm text-red-600" data-testid="tenko-filing-archive-error">{{ archiveError }}</p>
    </div>

  </div>
</template>
