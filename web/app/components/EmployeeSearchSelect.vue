<script setup lang="ts">
import type { ApiEmployee } from '~/types'

// 乗務員の絞り込み入力 (Refs #333)。本番テナントは 397 名いるため <select> では探せない。
// native の <datalist> は日本語 IME 入力中に候補が出ない/出ても選べないことがあるため、
// フィルタとドロップダウンを自前で描画する (nuxt-trouble EmployeeNameInput.vue と同じ理由)。
// - 値 (v-model) は employee.id。未選択は空文字 = 「全乗務員」
// - 入力テキストは表示専用。確定していない打ちかけの文字は blur で捨て、表示と値を一致させる
const model = defineModel<string>({ required: true })

const props = withDefaults(defineProps<{
  employees: ApiEmployee[]
  placeholder?: string
}>(), { placeholder: '全乗務員 (名前・社員番号で検索)' })

const MAX_CANDIDATES = 10

const query = ref('')
const open = ref(false)
const focused = ref(false)
const highlight = ref(-1)

function employeeLabel(emp: ApiEmployee) {
  return emp.code ? `${emp.code} - ${emp.name}` : emp.name
}

function labelFor(id: string) {
  const emp = props.employees.find(e => e.id === id)
  return emp ? employeeLabel(emp) : ''
}

// 選択済みの氏名 (と社員番号) を入力欄に見せる。employees は onMounted で後から届くので
// 値と一覧の両方を見る。打鍵中 (focused) は上書きしない
watch([model, () => props.employees], () => {
  if (!focused.value) query.value = labelFor(model.value)
}, { immediate: true })

const candidates = computed(() => {
  const q = query.value.trim().toLowerCase()
  const list = q
    ? props.employees.filter(e =>
        e.name.toLowerCase().includes(q) || (e.code ? e.code.toLowerCase().includes(q) : false)
      )
    : props.employees
  return list.slice(0, MAX_CANDIDATES)
})

function selectEmployee(emp: ApiEmployee) {
  model.value = emp.id
  query.value = employeeLabel(emp)
  open.value = false
  highlight.value = -1
}

function clear() {
  model.value = ''
  query.value = ''
  open.value = false
  highlight.value = -1
}

// 乗務員一覧は onMounted で後から届く。届く前に「該当なし」を見せないよう開かない
function openMenu() {
  if (props.employees.length === 0) return
  open.value = true
}

function onInput() {
  // 打ちかけの間は未選択 (= 全乗務員) に戻す。候補を選ぶまで id は入らない
  model.value = ''
  openMenu()
  highlight.value = -1
}

function onFocus() {
  focused.value = true
  openMenu()
  highlight.value = -1
}

function onBlur() {
  focused.value = false
  open.value = false
  highlight.value = -1
  // 確定していない打ちかけの文字は捨てる (表示が実際の絞り込みとズレないように)
  query.value = labelFor(model.value)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    open.value = false
    highlight.value = -1
    return
  }
  if (e.key === 'ArrowDown' && !open.value) {
    e.preventDefault()
    openMenu()
    return
  }
  if (!open.value || candidates.value.length === 0) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    highlight.value = Math.min(highlight.value + 1, candidates.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    highlight.value = Math.max(highlight.value - 1, 0)
  } else if (e.key === 'Enter' && highlight.value >= 0) {
    e.preventDefault()
    selectEmployee(candidates.value[highlight.value]!)
  }
}
</script>

<template>
  <div class="relative">
    <input
      v-model="query"
      type="text"
      data-testid="employee-search-input"
      :placeholder="placeholder"
      autocomplete="off"
      class="w-full px-3 py-2 pr-7 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      :class="model ? 'border-blue-400 bg-blue-50' : ''"
      @input="onInput" @focus="onFocus" @blur="onBlur" @keydown="onKeydown"
    >
    <button
      v-if="query"
      type="button"
      data-testid="employee-search-clear"
      aria-label="乗務員の絞り込みを解除"
      class="absolute right-1 top-1/2 -translate-y-1/2 px-1.5 text-gray-400 hover:text-gray-600 text-sm"
      @mousedown.prevent="clear"
    >×</button>
    <div
      v-if="open"
      data-testid="employee-search-menu"
      class="absolute z-10 w-full mt-1 bg-white border rounded shadow-lg max-h-40 overflow-y-auto"
    >
      <!-- mousedown.prevent: 候補クリックで input の blur を先に発火させない -->
      <button
        v-for="(emp, idx) in candidates"
        :key="emp.id"
        type="button"
        data-testid="employee-search-option"
        class="w-full text-left px-3 py-1.5 text-sm"
        :class="idx === highlight ? 'bg-blue-100' : 'hover:bg-blue-50'"
        @mousedown.prevent
        @click="selectEmployee(emp)"
      >{{ emp.code ? `${emp.code} - ` : '' }}{{ emp.name }}</button>
      <div v-if="candidates.length === 0" data-testid="employee-search-empty" class="px-3 py-2 text-xs text-gray-400">該当なし</div>
    </div>
  </div>
</template>
