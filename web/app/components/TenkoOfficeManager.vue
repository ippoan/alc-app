<script setup lang="ts">
import type { ApiEmployee, TenkoOffice, TenkoOfficeInput, TenkoOfficeVehicle } from '~/types'
import { createTenkoOffice, deleteTenkoOffice, getEmployees, getTenkoOffices, updateTenkoOffice } from '~/utils/api'

/**
 * 点呼の営業所 (システム管理者)。営業所ごとに所属の運行管理者 (兼務あり) と車両 (1 台 1 営業所) を決める。
 * 血圧の記録が足りず対面点呼に切り替えた点呼は、判定のとき車両の営業所と判定した運行管理者の所属営業所を比べ、
 * 同じなら対面点呼、別の営業所・グループ企業なら遠隔点呼とみなして記録する (告示 266 号 第四条 2 項)。
 * 車両の一覧は車両整備の車両マスタ。保存は営業所ごとに全部の欄と所属を置き換える。
 */

const ERRORS: Record<string, string> = {
  invalid_name: '営業所の名称を入力してください',
  too_long: '入力が長すぎます (1 欄 500 文字まで)',
  too_many_offices: '営業所は 100 件までです',
  invalid_manager: '運行管理者を選び直してください',
  invalid_vehicle: '車両を選び直してください',
  forbidden: 'システム管理者だけが変更できます',
}

/** 画面の 1 行 (id が null なら未保存の新しい営業所) */
interface Row extends TenkoOfficeInput {
  id: string | null
}

const rows = ref<Row[]>([])
const vehicles = ref<TenkoOfficeVehicle[]>([])
const managers = ref<ApiEmployee[]>([])
const loadError = ref('')
const busy = ref(false)
const rowError = ref<Record<string, string>>({})
const notice = ref('')

function messageOf(e: unknown, fallback: string): string {
  const message = e instanceof Error && e.message ? e.message : fallback
  const word = Object.keys(ERRORS).find(k => message.includes(k))
  return word ? ERRORS[word]! : message
}

function toRow(o: TenkoOffice): Row {
  return { ...o, company_name: o.company_name ?? '', address: o.address ?? '' }
}

async function load() {
  loadError.value = ''
  try {
    const [res, employees] = await Promise.all([getTenkoOffices(), getEmployees('admin')])
    rows.value = res.offices.map(toRow)
    vehicles.value = res.vehicles
    managers.value = employees.filter(e => e.role.includes('manager') || e.role.includes('admin'))
  }
  catch (e) {
    loadError.value = messageOf(e, '営業所を取得できませんでした')
  }
}

onMounted(load)

/** 行の鍵 (未保存の行は位置) */
function keyOf(row: Row, i: number): string {
  return row.id ?? `new-${i}`
}

function addOffice() {
  rows.value.push({ id: null, name: '', company_name: '', address: '', manager_ids: [], vehicle_ids: [] })
}

/** 車両がいま別の営業所に所属していればその名前 (選ぶと移ることを見せる) */
function otherOfficeName(v: TenkoOfficeVehicle, row: Row): string {
  if (!v.office_id || v.office_id === row.id) return ''
  return rows.value.find(r => r.id === v.office_id)?.name ?? ''
}

/** 保存・削除の共通の流れ。成功したら全部を読み直す (車両が別の営業所から移ることがあるため) */
async function act(row: Row, i: number, run: () => Promise<unknown>, done: string, fallback: string) {
  const key = keyOf(row, i)
  busy.value = true
  rowError.value = { ...rowError.value, [key]: '' }
  notice.value = ''
  try {
    await run()
    notice.value = `${row.name} を${done}しました`
    await load()
  }
  catch (e) {
    rowError.value = { ...rowError.value, [key]: messageOf(e, fallback) }
  }
  finally {
    busy.value = false
  }
}

function save(row: Row, i: number) {
  const body: TenkoOfficeInput = {
    name: row.name,
    company_name: row.company_name || null,
    address: row.address || null,
    manager_ids: row.manager_ids,
    vehicle_ids: row.vehicle_ids,
  }
  const id = row.id
  return act(row, i, () => id ? updateTenkoOffice(id, body) : createTenkoOffice(body), '保存', '保存できませんでした')
}

function remove(row: Row, i: number) {
  const id = row.id
  if (!id) {
    rows.value.splice(i, 1)
    return
  }
  return act(row, i, () => deleteTenkoOffice(id), '削除', '削除できませんでした')
}

const inputClass = 'w-full border rounded-lg px-2 py-1.5 text-sm'
</script>

<template>
  <div class="space-y-4" data-testid="tenko-offices">
    <div class="bg-white rounded-xl p-4 shadow-sm space-y-2">
      <p class="text-sm text-gray-600">
        営業所ごとに、所属する運行管理者と車両を選びます。血圧の記録が足りず対面点呼にした点呼は、判定のときに
        車両の営業所と判定した運行管理者の所属営業所を比べ、同じなら対面点呼、別の営業所・グループ企業なら遠隔点呼として記録します。
        所属が未設定のときは対面点呼として記録します。
      </p>
      <p class="text-xs text-gray-500">
        グループ企業の営業所は会社名を入れます。他社の営業所の運行管理者が行う点呼は、点呼の受委託の許可が前提です。
      </p>
      <p class="text-xs text-gray-500" data-testid="tenko-offices-cohabit-hint">
        同じ建物でも会社が違えば、会社ごとに別の営業所として登録します。自社の車両をグループ企業の営業所の運行管理者が判定すると、遠隔点呼として記録します。
      </p>
      <p class="text-xs text-gray-500">
        車両は車両整備の車両マスタに登録した車両から選びます (1 台は 1 つの営業所に所属します)。
      </p>
      <p v-if="loadError" class="text-sm text-red-600" data-testid="tenko-offices-load-error">{{ loadError }}</p>
      <p v-if="notice" class="text-sm text-green-700" data-testid="tenko-offices-notice">{{ notice }}</p>
    </div>

    <div
      v-for="(row, i) in rows"
      :key="keyOf(row, i)"
      class="bg-white rounded-xl p-4 shadow-sm space-y-3"
      data-testid="tenko-office"
    >
      <div class="grid gap-3 sm:grid-cols-3">
        <label class="text-sm">
          <span class="text-gray-500">営業所の名称</span>
          <input v-model="row.name" :class="inputClass" data-testid="tenko-office-name">
        </label>
        <label class="text-sm">
          <span class="text-gray-500">会社名 (グループ企業の営業所だけ)</span>
          <input v-model="row.company_name" :class="inputClass" placeholder="自社なら空欄" data-testid="tenko-office-company">
        </label>
        <label class="text-sm">
          <span class="text-gray-500">所在地</span>
          <input v-model="row.address" :class="inputClass" data-testid="tenko-office-address">
        </label>
      </div>

      <fieldset class="space-y-1">
        <legend class="text-sm text-gray-500">所属する運行管理者</legend>
        <p v-if="!managers.length" class="text-xs text-gray-500">運行管理者がまだいません</p>
        <div class="flex flex-wrap gap-x-4 gap-y-1">
          <label v-for="m in managers" :key="m.id" class="flex items-center gap-1 text-sm text-gray-800">
            <input v-model="row.manager_ids" type="checkbox" :value="m.id" data-testid="tenko-office-manager">
            {{ m.name }}
          </label>
        </div>
      </fieldset>

      <fieldset class="space-y-1">
        <legend class="text-sm text-gray-500">所属する車両</legend>
        <p v-if="!vehicles.length" class="text-xs text-gray-500">車両マスタに車両がありません</p>
        <div class="flex flex-wrap gap-x-4 gap-y-1">
          <label v-for="v in vehicles" :key="v.id" class="flex items-center gap-1 text-sm text-gray-800">
            <input v-model="row.vehicle_ids" type="checkbox" :value="v.id" data-testid="tenko-office-vehicle">
            {{ v.registration_number }}<template v-if="v.display_name"> ({{ v.display_name }})</template>
            <span v-if="otherOfficeName(v, row)" class="text-xs text-gray-500" data-testid="tenko-office-vehicle-elsewhere">— いまは {{ otherOfficeName(v, row) }}</span>
          </label>
        </div>
      </fieldset>

      <p v-if="rowError[keyOf(row, i)]" class="text-sm text-red-600" data-testid="tenko-office-error">{{ rowError[keyOf(row, i)] }}</p>
      <div class="flex gap-3">
        <button
          class="px-4 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-50"
          :disabled="busy"
          data-testid="tenko-office-save"
          @click="save(row, i)"
        >
          保存
        </button>
        <button
          class="text-sm text-red-600 hover:underline disabled:opacity-50"
          :disabled="busy"
          data-testid="tenko-office-delete"
          @click="remove(row, i)"
        >
          削除
        </button>
      </div>
    </div>

    <button class="text-sm text-blue-600 hover:underline" data-testid="tenko-offices-add" @click="addOffice">＋ 営業所を追加</button>
  </div>
</template>
