<script setup lang="ts">
import type { TenkoCompany, TenkoCompanyInput, TenkoConsignment, TenkoConsignmentInput, TenkoOffice } from '~/types'
import {
  createTenkoCompany, createTenkoConsignment, deleteTenkoCompany, deleteTenkoConsignment, getTenkoOffices,
  listTenkoConsignments, updateTenkoCompany, updateTenkoConsignment,
} from '~/utils/api'

/**
 * 点呼の届出の事業者 (システム管理者)。1 つのテナントに事業者 (会社) を複数登録し、行を選ぶと、親の画面が
 * その事業者の「書き込む値」と申請済みの控えに切り替わる。営業所の事業者は「点呼の営業所」の画面で選ぶ (ここでは読むだけ。
 * 営業所は 1 つの事業者だけ。車両は営業所に付いているので、営業所経由で事業者に紐づく)。
 * 受委託 (事業者間遠隔点呼) は委託・受託のどちらかが選んだ事業者の営業所なら出す (両方の事業者から見える)。
 * 一覧は親が持つ。ここで変えたら `changed` を出し、親が読み直す。
 */

const props = defineProps<{
  companies: TenkoCompany[]
  /** 選んでいる事業者の id (無ければ空) */
  modelValue: string
}>()
const emit = defineEmits<{
  'update:modelValue': [id: string]
  'changed': []
}>()

const ERRORS: Record<string, string> = {
  invalid_name: '事業者の名称を入力してください',
  too_long: '入力が長すぎます (名称は 500 文字、許可番号は 100 文字まで)',
  duplicate_name: '同じ名称の事業者がすでにあります',
  too_many_companies: '事業者は 100 件までです',
  office_without_company: '委託・受託の営業所は、先に「点呼の営業所」の画面で事業者を選んでください',
  same_company: '委託と受託は別の事業者の営業所にしてください',
  invalid_arrive_id: '到達番号は数字 15〜17 桁と末尾 1 字です',
  invalid_period: '期間は開始日と終了日を両方入れ、終了日は開始日以降・5 年未満にしてください',
  forbidden: 'システム管理者だけが変更できます',
}

function messageOf(e: unknown, fallback: string): string {
  const message = e instanceof Error && e.message ? e.message : fallback
  const word = Object.keys(ERRORS).find(k => message.includes(k))
  return word ? ERRORS[word]! : message
}

const offices = ref<TenkoOffice[]>([])
const consignments = ref<TenkoConsignment[]>([])
const loadError = ref('')
const busy = ref(false)

async function load() {
  loadError.value = ''
  try {
    const [res, cons] = await Promise.all([getTenkoOffices(), listTenkoConsignments()])
    offices.value = res.offices
    consignments.value = cons
  }
  catch (e) {
    loadError.value = messageOf(e, '営業所・受委託を取得できませんでした')
  }
}
onMounted(load)

/** 事業者・受委託を変えた後の読み直し (営業所の振り分けが動くので両方) */
async function reloadAll() {
  emit('changed')
  await load()
}

function officeName(id: string): string {
  return offices.value.find(o => o.id === id)?.name ?? '(消えた営業所)'
}

function officeNames(c: TenkoCompany): string {
  return c.office_ids.map(officeName).join('・')
}

// --- 事業者 ---

interface CompanyDraft extends TenkoCompanyInput {
  id: string | null
}
const draft = ref<CompanyDraft | null>(null)
const draftError = ref('')

function addCompany() {
  draftError.value = ''
  draft.value = { id: null, name: '', is_self: !props.companies.length }
}

function editCompany(c: TenkoCompany) {
  draftError.value = ''
  draft.value = { id: c.id, name: c.name, is_self: c.is_self }
}

/** 編集中の事業者に属する営業所の名前 (読むだけ。新しい事業者はまだ無い) */
const draftOffices = computed(() => {
  const c = props.companies.find(x => x.id === draft.value?.id)
  return (c ? officeNames(c) : '') || '営業所なし'
})

async function saveCompany() {
  const d = draft.value!
  busy.value = true
  draftError.value = ''
  const body: TenkoCompanyInput = { name: d.name.trim(), is_self: d.is_self }
  try {
    const saved = d.id ? await updateTenkoCompany(d.id, body) : await createTenkoCompany(body)
    draft.value = null
    if (!d.id) emit('update:modelValue', saved.id)
    await reloadAll()
  }
  catch (e) {
    draftError.value = messageOf(e, '保存できませんでした')
  }
  finally {
    busy.value = false
  }
}

const tableError = ref('')
async function removeCompany(c: TenkoCompany) {
  if (!confirm(`${c.name} を削除しますか？ 書き込む値と控えの振り分けも消え、営業所の事業者は未設定に戻ります。`)) return
  tableError.value = ''
  try {
    await deleteTenkoCompany(c.id)
    if (draft.value?.id === c.id) draft.value = null
    await reloadAll()
  }
  catch (e) {
    tableError.value = messageOf(e, '削除できませんでした')
  }
}

// --- 受委託 ---

const selected = computed(() => props.companies.find(c => c.id === props.modelValue))

/** 選んだ事業者の営業所が委託か受託に入っている受委託 */
const shownConsignments = computed(() => {
  const ids = selected.value?.office_ids ?? []
  return consignments.value.filter(c => ids.includes(c.consignor_office_id) || ids.includes(c.consignee_office_id))
})

interface ConsignmentDraft {
  id: string | null
  consignor_office_id: string
  consignee_office_id: string
  arrive_id: string
  permit_no: string
  permit_date: string
  valid_from: string
  valid_to: string
}
const cdraft = ref<ConsignmentDraft | null>(null)
const cdraftError = ref('')

function addConsignment() {
  cdraftError.value = ''
  cdraft.value = {
    id: null,
    consignor_office_id: selected.value?.office_ids[0] ?? '',
    consignee_office_id: '',
    arrive_id: '',
    permit_no: '',
    permit_date: '',
    valid_from: '',
    valid_to: '',
  }
}

function editConsignment(c: TenkoConsignment) {
  cdraftError.value = ''
  cdraft.value = {
    id: c.id,
    consignor_office_id: c.consignor_office_id,
    consignee_office_id: c.consignee_office_id,
    arrive_id: c.arrive_id ?? '',
    permit_no: c.permit_no ?? '',
    permit_date: c.permit_date ?? '',
    valid_from: c.valid_from ?? '',
    valid_to: c.valid_to ?? '',
  }
}

async function saveConsignment() {
  const d = cdraft.value!
  busy.value = true
  cdraftError.value = ''
  const body: TenkoConsignmentInput = {
    consignor_office_id: d.consignor_office_id,
    consignee_office_id: d.consignee_office_id,
    arrive_id: d.arrive_id.trim() || null,
    permit_no: d.permit_no.trim() || null,
    permit_date: d.permit_date || null,
    valid_from: d.valid_from || null,
    valid_to: d.valid_to || null,
  }
  try {
    if (d.id) await updateTenkoConsignment(d.id, body)
    else await createTenkoConsignment(body)
    cdraft.value = null
    await reloadAll()
  }
  catch (e) {
    cdraftError.value = messageOf(e, '保存できませんでした')
  }
  finally {
    busy.value = false
  }
}

const consignmentError = ref('')
async function removeConsignment(c: TenkoConsignment) {
  if (!confirm('この受委託を削除しますか？')) return
  consignmentError.value = ''
  try {
    await deleteTenkoConsignment(c.id)
    if (cdraft.value?.id === c.id) cdraft.value = null
    await reloadAll()
  }
  catch (e) {
    consignmentError.value = messageOf(e, '削除できませんでした')
  }
}

/** 事業者が付いている営業所だけが、受委託の相手に選べる */
const assignedOffices = computed(() => offices.value.filter(o => props.companies.some(c => c.office_ids.includes(o.id))))

function officeLabel(id: string): string {
  const o = offices.value.find(x => x.id === id)
  const owner = props.companies.find(c => c.office_ids.includes(id))
  return `${officeName(id)}${o && owner ? ` (${owner.name})` : ''}`
}

function period(c: TenkoConsignment): string {
  return c.valid_from && c.valid_to ? `${c.valid_from} 〜 ${c.valid_to}` : '-'
}

const inputClass = 'w-full border rounded-lg px-2 py-1.5 text-sm'
const iconButton = 'rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700'
</script>

<template>
  <div class="space-y-4" data-testid="tenko-companies">
    <!-- 事業者の表 -->
    <div class="bg-white rounded-xl p-4 shadow-sm space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="font-semibold text-gray-800">事業者</h3>
        <button
          class="px-3 py-1.5 rounded-lg border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"
          data-testid="tenko-company-add"
          @click="addCompany"
        >
          ＋ 事業者を追加
        </button>
      </div>
      <p class="text-xs text-gray-500">
        行を選ぶと、下の「書き込む値」と申請済みの控えがその事業者のものに切り替わります。営業所の事業者は「点呼の営業所」の画面で選びます (営業所は 1 つの事業者だけ)。
      </p>
      <p v-if="loadError" class="text-sm text-red-600" data-testid="tenko-company-load-error">{{ loadError }}</p>
      <p v-if="!companies.length" class="text-sm text-gray-500" data-testid="tenko-company-empty">事業者がまだありません。「事業者を追加」で登録してください。</p>
      <div v-else class="overflow-x-auto rounded-lg border border-gray-200">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-left text-xs font-medium text-gray-500">
            <tr>
              <th class="px-3 py-2">事業者</th>
              <th class="px-3 py-2">営業所</th>
              <th class="w-px px-3 py-2" />
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr
              v-for="c in companies"
              :key="c.id"
              class="cursor-pointer transition-colors"
              :class="modelValue === c.id ? 'bg-blue-50' : 'hover:bg-gray-50'"
              data-testid="tenko-company-row"
              @click="emit('update:modelValue', c.id)"
            >
              <td class="px-3 py-2.5">
                <span class="text-gray-900">{{ c.name }}</span>
                <span v-if="c.is_self" class="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20" data-testid="tenko-company-self">既定</span>
              </td>
              <td class="px-3 py-2.5 text-xs text-gray-600">{{ officeNames(c) || '営業所なし' }}</td>
              <td class="px-2 py-2.5" @click.stop>
                <div class="flex items-center justify-end gap-0.5">
                  <button :class="iconButton" title="編集" aria-label="編集" data-testid="tenko-company-edit" @click="editCompany(c)">
                    <svg class="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M13 4l3 3M4 16l1-4 8-8 3 3-8 8-4 1z" stroke-linecap="round" stroke-linejoin="round" /></svg>
                  </button>
                  <button :class="iconButton" title="削除" aria-label="削除" data-testid="tenko-company-delete" @click="removeCompany(c)">
                    <svg class="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" stroke-linecap="round" stroke-linejoin="round" /></svg>
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="tableError" class="text-sm text-red-600" data-testid="tenko-company-table-error">{{ tableError }}</p>

      <div v-if="draft" class="rounded-lg border border-gray-200 p-3 space-y-3" data-testid="tenko-company-form">
        <div class="grid gap-3 sm:grid-cols-[2fr_1fr] items-end">
          <label class="text-sm">
            <span class="text-gray-500">事業者の名称</span>
            <input v-model="draft.name" :class="inputClass" data-testid="tenko-company-name">
          </label>
          <label class="flex items-center gap-1 text-sm text-gray-800">
            <input v-model="draft.is_self" type="checkbox" data-testid="tenko-company-is-self">
            既定の事業者にする
          </label>
        </div>
        <div class="space-y-1" data-testid="tenko-company-offices">
          <p class="text-sm text-gray-500">この事業者の営業所</p>
          <p class="text-sm text-gray-800" data-testid="tenko-company-offices-list">{{ draftOffices }}</p>
          <p class="text-xs text-gray-500">営業所の事業者は「点呼の営業所」の画面で選びます。</p>
        </div>
        <div class="flex items-center gap-3">
          <button class="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm disabled:opacity-50" :disabled="busy" data-testid="tenko-company-save" @click="saveCompany">
            {{ busy ? '保存中…' : '保存' }}
          </button>
          <button class="text-sm text-gray-600 hover:underline" data-testid="tenko-company-cancel" @click="draft = null">やめる</button>
          <span v-if="draftError" class="text-sm text-red-600" data-testid="tenko-company-error">{{ draftError }}</span>
        </div>
      </div>
    </div>

    <!-- 受委託 (選んだ事業者の営業所が委託か受託に入っているもの) -->
    <div v-if="selected" class="bg-white rounded-xl p-4 shadow-sm space-y-3" data-testid="tenko-consignments">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="font-semibold text-gray-800">受委託 (事業者間遠隔点呼)</h3>
        <button
          class="px-3 py-1.5 rounded-lg border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"
          data-testid="tenko-consignment-add"
          @click="addConsignment"
        >
          ＋ 受委託を追加
        </button>
      </div>
      <p class="text-xs text-gray-500">{{ selected.name }} の営業所が、委託か受託のどちらかに入っているものを出します (相手の事業者の画面にも出ます)。</p>
      <p v-if="!shownConsignments.length" class="text-sm text-gray-500" data-testid="tenko-consignment-empty">この事業者の受委託はまだありません。</p>
      <div v-else class="overflow-x-auto rounded-lg border border-gray-200">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-left text-xs font-medium text-gray-500">
            <tr>
              <th class="px-3 py-2">委託の営業所</th>
              <th class="px-3 py-2">受託の営業所</th>
              <th class="px-3 py-2">到達番号</th>
              <th class="px-3 py-2">許可番号</th>
              <th class="px-3 py-2">許可日</th>
              <th class="px-3 py-2">期間</th>
              <th class="w-px px-3 py-2" />
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="c in shownConsignments" :key="c.id" data-testid="tenko-consignment-row">
              <td class="px-3 py-2.5">{{ officeLabel(c.consignor_office_id) }}</td>
              <td class="px-3 py-2.5">{{ officeLabel(c.consignee_office_id) }}</td>
              <td class="px-3 py-2.5 font-mono text-xs">{{ c.arrive_id || '-' }}</td>
              <td class="px-3 py-2.5" data-testid="tenko-consignment-permit">
                <span v-if="c.permit_no">{{ c.permit_no }}</span>
                <span v-else class="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-600/20">申請中</span>
              </td>
              <td class="whitespace-nowrap px-3 py-2.5 text-xs text-gray-600">{{ c.permit_date || '-' }}</td>
              <td class="whitespace-nowrap px-3 py-2.5 text-xs text-gray-600">{{ period(c) }}</td>
              <td class="px-2 py-2.5">
                <div class="flex items-center justify-end gap-0.5">
                  <button :class="iconButton" title="編集" aria-label="編集" data-testid="tenko-consignment-edit" @click="editConsignment(c)">
                    <svg class="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M13 4l3 3M4 16l1-4 8-8 3 3-8 8-4 1z" stroke-linecap="round" stroke-linejoin="round" /></svg>
                  </button>
                  <button :class="iconButton" title="削除" aria-label="削除" data-testid="tenko-consignment-delete" @click="removeConsignment(c)">
                    <svg class="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" stroke-linecap="round" stroke-linejoin="round" /></svg>
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="consignmentError" class="text-sm text-red-600" data-testid="tenko-consignment-table-error">{{ consignmentError }}</p>

      <div v-if="cdraft" class="rounded-lg border border-gray-200 p-3 space-y-3" data-testid="tenko-consignment-form">
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="text-sm">
            <span class="text-gray-500">委託の営業所</span>
            <select v-model="cdraft.consignor_office_id" :class="inputClass" data-testid="tenko-consignment-consignor">
              <option value="" disabled>選んでください</option>
              <option v-for="o in assignedOffices" :key="o.id" :value="o.id">{{ officeLabel(o.id) }}</option>
            </select>
          </label>
          <label class="text-sm">
            <span class="text-gray-500">受託の営業所</span>
            <select v-model="cdraft.consignee_office_id" :class="inputClass" data-testid="tenko-consignment-consignee">
              <option value="" disabled>選んでください</option>
              <option v-for="o in assignedOffices" :key="o.id" :value="o.id">{{ officeLabel(o.id) }}</option>
            </select>
          </label>
        </div>
        <div class="grid gap-3 sm:grid-cols-5">
          <label class="text-sm">
            <span class="text-gray-500">到達番号 (許可申請)</span>
            <input v-model="cdraft.arrive_id" :class="inputClass" inputmode="numeric" data-testid="tenko-consignment-arrive">
          </label>
          <label class="text-sm">
            <span class="text-gray-500">許可番号 (空なら申請中)</span>
            <input v-model="cdraft.permit_no" :class="inputClass" data-testid="tenko-consignment-permit-no">
          </label>
          <label class="text-sm">
            <span class="text-gray-500">許可日</span>
            <input v-model="cdraft.permit_date" type="date" :class="inputClass" data-testid="tenko-consignment-permit-date">
          </label>
          <label class="text-sm">
            <span class="text-gray-500">期間の開始</span>
            <input v-model="cdraft.valid_from" type="date" :class="inputClass" data-testid="tenko-consignment-valid-from">
          </label>
          <label class="text-sm">
            <span class="text-gray-500">期間の終了</span>
            <input v-model="cdraft.valid_to" type="date" :class="inputClass" data-testid="tenko-consignment-valid-to">
          </label>
        </div>
        <div class="flex items-center gap-3">
          <button class="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm disabled:opacity-50" :disabled="busy" data-testid="tenko-consignment-save" @click="saveConsignment">
            {{ busy ? '保存中…' : '保存' }}
          </button>
          <button class="text-sm text-gray-600 hover:underline" data-testid="tenko-consignment-cancel" @click="cdraft = null">やめる</button>
          <span v-if="cdraftError" class="text-sm text-red-600" data-testid="tenko-consignment-error">{{ cdraftError }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
