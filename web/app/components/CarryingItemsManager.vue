<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import type { CarryingItem, VehicleCategories, VehicleConditionInput } from '~/types'
import { getCarryingItems, createCarryingItem, updateCarryingItem, deleteCarryingItem, getVehicleCategories } from '~/utils/api'

const CATEGORIES = [
  { key: 'car_kind', label: '車種' },
  { key: 'use', label: '用途' },
  { key: 'car_shape', label: '車体' },
  { key: 'private_business', label: '自家用/事業用' },
] as const

type CategoryKey = typeof CATEGORIES[number]['key']

const items = ref<CarryingItem[]>([])
const loading = ref(false)
const nameInputRef = ref<HTMLInputElement | null>(null)

// 車検証マスタ
const vehicleCats = ref<VehicleCategories | null>(null)

// 新規フォーム
const newItemName = ref('')
const newItemRequired = ref(true)
const newConditions = ref<VehicleConditionInput[]>([])

// 編集
const editingId = ref<string | null>(null)
const editName = ref('')
const editRequired = ref(true)
const editConditions = ref<VehicleConditionInput[]>([])

// フィルタ
const filterCategory = ref<string>('all')

// 条件からカテゴリ別に集計
function conditionsByCategory(conditions: VehicleConditionInput[], cat: string): string[] {
  return conditions.filter(c => c.category === cat).map(c => c.value)
}

// 条件トグル
function toggleCondition(conditions: VehicleConditionInput[], cat: string, val: string): VehicleConditionInput[] {
  const exists = conditions.some(c => c.category === cat && c.value === val)
  if (exists) {
    return conditions.filter(c => !(c.category === cat && c.value === val))
  }
  return [...conditions, { category: cat, value: val }]
}

function isSelected(conditions: VehicleConditionInput[], cat: string, val: string): boolean {
  return conditions.some(c => c.category === cat && c.value === val)
}

// 条件のラベル表示
function conditionSummary(conditions: VehicleConditionInput[]): string {
  if (conditions.length === 0) return '全共通'
  const parts: string[] = []
  for (const cat of CATEGORIES) {
    const vals = conditionsByCategory(conditions, cat.key)
    if (vals.length > 0) parts.push(`${cat.label}: ${vals.join('|')}`)
  }
  return parts.join(' + ')
}

// 車検証のカテゴリ値取得
function catValues(cat: CategoryKey): string[] {
  if (!vehicleCats.value) return []
  const map: Record<CategoryKey, string[]> = {
    car_kind: vehicleCats.value.car_kinds,
    use: vehicleCats.value.uses,
    car_shape: vehicleCats.value.car_shapes,
    private_business: vehicleCats.value.private_businesses,
  }
  return map[cat]
}

// フィルタ用: 携行品で使われている全カテゴリ値
const usedCategories = computed(() => {
  const cats = new Set<string>()
  for (const item of items.value) {
    for (const c of item.vehicle_conditions) {
      cats.add(`${c.category}:${c.value}`)
    }
  }
  return cats
})

const filteredItems = computed(() => {
  if (filterCategory.value === 'all') return items.value
  if (filterCategory.value === 'common') return items.value.filter(i => i.vehicle_conditions.length === 0)
  // filterCategory = "car_kind:普通" etc
  const [cat, val] = filterCategory.value.split(':')
  return items.value.filter(i =>
    i.vehicle_conditions.length === 0 ||
    i.vehicle_conditions.some(c => c.category === cat && c.value === val)
  )
})

async function load() {
  loading.value = true
  try {
    items.value = await getCarryingItems('tenko-monitor')
  } catch (e) {
    console.error('携行品一覧取得エラー:', e)
  } finally {
    loading.value = false
  }
}

async function addItem() {
  if (!newItemName.value.trim()) return
  try {
    await createCarryingItem({
      item_name: newItemName.value.trim(),
      is_required: newItemRequired.value,
      sort_order: items.value.length,
      vehicle_conditions: newConditions.value.length > 0 ? newConditions.value : undefined,
    })
    newItemName.value = ''
    await load()
    nextTick(() => nameInputRef.value?.focus())
  } catch (e) {
    console.error('携行品追加エラー:', e)
  }
}

function startEdit(item: CarryingItem) {
  editingId.value = item.id
  editName.value = item.item_name
  editRequired.value = item.is_required
  editConditions.value = item.vehicle_conditions.map(c => ({ category: c.category, value: c.value }))
}

async function saveEdit(id: string) {
  try {
    await updateCarryingItem(id, {
      item_name: editName.value.trim(),
      is_required: editRequired.value,
      vehicle_conditions: editConditions.value,
    })
    editingId.value = null
    await load()
  } catch (e) {
    console.error('携行品更新エラー:', e)
  }
}

async function removeItem(id: string) {
  if (!confirm('この携行品を削除しますか？')) return
  try {
    await deleteCarryingItem(id)
    await load()
  } catch (e) {
    console.error('携行品削除エラー:', e)
  }
}

onMounted(() => {
  load()
  getVehicleCategories('tenko-monitor').then(v => { vehicleCats.value = v }).catch(() => {})
})
</script>

<template>
  <div class="space-y-4">
    <h3 class="text-lg font-bold">携行品マスタ管理</h3>
    <p class="text-sm text-gray-500">車両分類: カテゴリ内はOR (いずれか一致)、カテゴリ間はAND (すべて一致)</p>

    <!-- 追加フォーム -->
    <div class="bg-gray-50 p-3 rounded space-y-3">
      <!-- 車両分類選択 -->
      <div v-if="vehicleCats" class="text-xs space-y-2">
        <div class="text-gray-500">車両分類 (クリックでトグル、未選択=全共通)</div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div v-for="cat in CATEGORIES" :key="cat.key">
            <div class="font-medium text-gray-600 mb-1">{{ cat.label }}</div>
            <div class="flex flex-wrap gap-1">
              <button
                v-for="v in catValues(cat.key)" :key="v"
                class="px-1.5 py-0.5 rounded border transition-colors"
                :class="isSelected(newConditions, cat.key, v)
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-600 border-gray-300 hover:bg-blue-50 hover:border-blue-300'"
                @click="newConditions = toggleCondition(newConditions, cat.key, v)"
              >{{ v }}</button>
              <span v-if="catValues(cat.key).length === 0" class="text-gray-300">なし</span>
            </div>
          </div>
        </div>
        <div v-if="newConditions.length > 0" class="flex items-center gap-2 pt-1">
          <span class="text-gray-500">条件:</span>
          <span class="font-medium text-blue-700">{{ conditionSummary(newConditions) }}</span>
          <button class="text-gray-400 hover:text-red-500" @click="newConditions = []">全解除</button>
        </div>
      </div>

      <!-- 入力欄: 必須 → 品名 → 追加 -->
      <div class="flex items-center gap-2">
        <label class="flex items-center gap-1 text-sm whitespace-nowrap">
          <input v-model="newItemRequired" type="checkbox" />
          必須
        </label>
        <input
          ref="nameInputRef"
          v-model="newItemName"
          type="text"
          placeholder="携行品名"
          class="flex-1 border rounded px-3 py-1.5 text-sm"
          @keydown.enter="addItem"
        />
        <button
          class="bg-blue-600 text-white px-3 py-1.5 rounded text-sm hover:bg-blue-700 disabled:opacity-50"
          :disabled="!newItemName.trim()"
          @click="addItem"
        >
          追加
        </button>
      </div>
    </div>

    <!-- フィルタ -->
    <div class="flex items-center gap-2 flex-wrap">
      <span class="text-sm text-gray-500">表示:</span>
      <button
        class="px-2 py-1 rounded text-xs font-medium transition-colors"
        :class="filterCategory === 'all' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'"
        @click="filterCategory = 'all'"
      >全て</button>
      <button
        class="px-2 py-1 rounded text-xs font-medium transition-colors"
        :class="filterCategory === 'common' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'"
        @click="filterCategory = 'common'"
      >共通のみ</button>
      <template v-for="cat in CATEGORIES" :key="cat.key">
        <button
          v-for="v in catValues(cat.key).filter(v => usedCategories.has(cat.key + ':' + v))"
          :key="cat.key + ':' + v"
          class="px-2 py-1 rounded text-xs font-medium transition-colors"
          :class="filterCategory === cat.key + ':' + v ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'"
          @click="filterCategory = cat.key + ':' + v"
        >{{ cat.label }}:{{ v }}</button>
      </template>
    </div>

    <!-- 一覧 -->
    <div v-if="loading" class="text-center py-4 text-gray-400">読み込み中...</div>
    <div v-else-if="items.length === 0" class="text-center py-4 text-gray-400">携行品が登録されていません</div>
    <div v-else class="divide-y border rounded">
      <div v-for="item in filteredItems" :key="item.id" class="px-3 py-2">
        <!-- 編集モード -->
        <template v-if="editingId === item.id">
          <div class="space-y-2">
            <!-- 編集: 車両分類選択 -->
            <div v-if="vehicleCats" class="text-xs space-y-1">
              <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div v-for="cat in CATEGORIES" :key="cat.key">
                  <div class="font-medium text-gray-600 mb-0.5">{{ cat.label }}</div>
                  <div class="flex flex-wrap gap-1">
                    <button
                      v-for="v in catValues(cat.key)" :key="v"
                      class="px-1.5 py-0.5 rounded border transition-colors text-xs"
                      :class="isSelected(editConditions, cat.key, v)
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-600 border-gray-300 hover:bg-blue-50'"
                      @click="editConditions = toggleCondition(editConditions, cat.key, v)"
                    >{{ v }}</button>
                  </div>
                </div>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <label class="flex items-center gap-1 text-sm">
                <input v-model="editRequired" type="checkbox" />
                必須
              </label>
              <input v-model="editName" class="flex-1 border rounded px-2 py-1 text-sm" @keydown.enter="saveEdit(item.id)" />
              <button class="text-blue-600 text-sm" @click="saveEdit(item.id)">保存</button>
              <button class="text-gray-400 text-sm" @click="editingId = null">取消</button>
            </div>
          </div>
        </template>

        <!-- 通常表示 -->
        <template v-else>
          <div class="flex items-center gap-2">
            <span class="flex-1 text-sm">{{ item.item_name }}</span>
            <span v-if="item.vehicle_conditions.length === 0" class="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">共通</span>
            <span v-else class="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">{{ conditionSummary(item.vehicle_conditions) }}</span>
            <span v-if="item.is_required" class="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded">必須</span>
            <span v-else class="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">任意</span>
            <button class="text-gray-400 hover:text-blue-600 text-sm" @click="startEdit(item)">編集</button>
            <button class="text-gray-400 hover:text-red-600 text-sm" @click="removeItem(item.id)">削除</button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
