<script setup lang="ts">
import type { ApiEmployee, TenkoCompany, TenkoOffice, TenkoOfficeCarinsBase, TenkoOfficeCarinsBaseKey, TenkoOfficeInput, TenkoOfficeVehicle } from '~/types'
import { createTenkoOffice, deleteTenkoOffice, getEmployees, getTenkoOffices, listCamHostKeys, listTenkoCompanies, updateTenkoOffice } from '~/utils/api'
import { lastDeviceId } from '~/utils/token-selection'

/** 保存・削除が通ったら出す (「点呼の届出」の画面で事業者の表を読み直すため) */
const emit = defineEmits<{ saved: [] }>()

/**
 * 点呼の営業所 (システム管理者)。営業所ごとに所属の運行管理者 (兼務あり) と車両を決める。車両の所属は基本を車検証の
 * 「使用の本拠の位置 + 使用者」の組で決め (組は 1 営業所)、手で選んだ車両 (1 台 1 営業所) はその上書きにする。
 * 血圧の記録が足りず対面点呼に切り替えた点呼は、判定のとき車両の営業所と判定した運行管理者の所属営業所を比べ、
 * 同じなら対面点呼、別の営業所・グループ企業なら遠隔点呼とみなして記録する (告示 266 号 第四条 2 項)。
 * 手で選ぶ車両の一覧は車両整備の車両マスタ。点呼端末 (点呼に使う機体 = CoreS3・Vein Station の、用途 kiosk の機体の鍵。
 * 端末 ID はキオスクの鍵の `X-Device-Id` と同じ `alarm:<指紋>`) も営業所に所属させ、キオスクの車両番号の候補で
 * その営業所の車両を先に出す。保存は営業所ごとに全部の欄と所属を置き換える。
 */

const ERRORS: Record<string, string> = {
  invalid_name: '営業所の名称を入力してください',
  too_long: '入力が長すぎます (1 欄 500 文字まで)',
  too_many_offices: '営業所は 100 件までです',
  invalid_manager: '運行管理者を選び直してください',
  invalid_vehicle: '車両を選び直してください',
  invalid_carins_base: '車検証の使用の本拠・使用者を選び直してください',
  invalid_device: '点呼端末を選び直してください',
  invalid_company: '事業者を選び直してください',
  forbidden: 'システム管理者だけが変更できます',
}

/** 画面の 1 行 (id が null なら未保存の新しい営業所) */
interface Row extends TenkoOfficeInput {
  id: string | null
}

const rows = ref<Row[]>([])
const vehicles = ref<TenkoOfficeVehicle[]>([])
const carinsBases = ref<TenkoOfficeCarinsBase[]>([])
/** 点呼端末 (用途 kiosk の機体の鍵)。読めなくても営業所の設定は止めない */
const devices = ref<{ device_id: string, label: string | null }[]>([])

/** このブラウザで最後にキオスクの鍵を取った機体 (= この端末)。一覧の先頭に出して印を付ける */
const thisDeviceId = lastDeviceId('kiosk')

/**
 * 点呼端末の表示名。同じ名前の機体 (cores3 が何台も) を見分けられるよう、鍵の指紋の頭 8 桁を必ず添える
 * (`VeinFleetManager` と同じ切り出し)。名前の無い機体は「名前の無い機体」
 */
function deviceName(d: { device_id: string, label: string | null }): string {
  return `${d.label || '名前の無い機体'} ${d.device_id.slice(6, 14)}`
}
/** 登録済みの事業者。読めなくても営業所の設定は止めない */
const companies = ref<TenkoCompany[]>([])
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
    carinsBases.value = res.carins_bases
    managers.value = employees.filter(e => e.role.includes('manager') || e.role.includes('admin'))
    companies.value = await listTenkoCompanies().catch(() => [])
    const keys = await listCamHostKeys().then(r => r.keys, () => [])
    devices.value = [...keys.filter(k => k.device_id === thisDeviceId), ...keys.filter(k => k.device_id !== thisDeviceId)]
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
  rows.value.push({ id: null, name: '', company_id: null, company_name: '', address: '', manager_ids: [], vehicle_ids: [], carins_bases: [], device_ids: [] })
}

/** 車両・車検証の組がいま別の営業所に所属していればその名前 (選ぶと移ることを見せる) */
function otherOfficeName(item: { office_id: string | null }, row: Row): string {
  if (!item.office_id || item.office_id === row.id) return ''
  return rows.value.find(r => r.id === item.office_id)?.name ?? ''
}

/** 営業所の会社の表示名。事業者を選んでいれば事業者名、無ければ以前の会社名 (どちらも無ければ空) */
function companyLabel(o: { company_id: string | null, company_name: string | null }): string {
  return (o.company_id && companies.value.find(c => c.id === o.company_id)?.name) || o.company_name || ''
}

/** 端末がほかにも所属している営業所の名前 (端末は複数の営業所に所属できる。選んでも移らない) */
function deviceAlsoIn(deviceId: string, row: Row): string {
  return rows.value.filter(r => r.id !== row.id && r.device_ids.includes(deviceId)).map(r => companyLabel(r) ? `${companyLabel(r)} ${r.name}` : r.name).join('、')
}

/** チェックボックスの値 (組の 2 項目だけ。v-model の配列と形をそろえる) */
function baseKey(b: TenkoOfficeCarinsBase): TenkoOfficeCarinsBaseKey {
  return { use_base: b.use_base, user_name: b.user_name }
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
    emit('saved')
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
    company_id: row.company_id,
    company_name: row.company_name || null,
    address: row.address || null,
    manager_ids: row.manager_ids,
    vehicle_ids: row.vehicle_ids,
    carins_bases: row.carins_bases,
    device_ids: row.device_ids,
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
        営業所の事業者は、登録した事業者から選びます (事業者は「点呼の届出」の事業者の表で登録します)。他社の営業所の運行管理者が行う点呼は、点呼の受委託の許可が前提です。
      </p>
      <p class="text-xs text-gray-500" data-testid="tenko-offices-cohabit-hint">
        同じ建物でも会社が違えば、会社ごとに別の営業所として登録します。自社の車両をグループ企業の営業所の運行管理者が判定すると、遠隔点呼として記録します。
      </p>
      <p class="text-xs text-gray-500">
        車両の所属は、車検証の「使用の本拠の位置」と「使用者」の組ごとに営業所を選んで決めます。車検証と違う営業所に置く車両や、
        車検証の無い車両だけ、車両整備の車両マスタから手で選びます (手で選んだ所属が優先します)。
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
          <span class="text-gray-500">事業者</span>
          <select v-model="row.company_id" :class="inputClass" data-testid="tenko-office-company">
            <option :value="null">未設定</option>
            <option v-for="c in companies" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <span v-if="!row.company_id && row.company_name" class="text-xs text-gray-400" data-testid="tenko-office-company-legacy">以前の会社名: {{ row.company_name }}</span>
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
        <legend class="text-sm text-gray-500">車検証の使用の本拠・使用者</legend>
        <p v-if="!carinsBases.length" class="text-xs text-gray-500">車検証が取り込まれていません</p>
        <div class="flex flex-col gap-1">
          <label v-for="b in carinsBases" :key="`${b.use_base}\n${b.user_name}`" class="flex items-center gap-1 text-sm text-gray-800">
            <input v-model="row.carins_bases" type="checkbox" :value="baseKey(b)" data-testid="tenko-office-carins-base">
            {{ b.use_base }} / {{ b.user_name }}
            <span class="text-xs text-gray-500">({{ b.vehicle_count }} 台)</span>
            <span v-if="otherOfficeName(b, row)" class="text-xs text-gray-500" data-testid="tenko-office-carins-base-elsewhere">— いまは {{ otherOfficeName(b, row) }}</span>
          </label>
        </div>
      </fieldset>

      <fieldset class="space-y-1">
        <legend class="text-sm text-gray-500">手で選ぶ車両 (車検証と違うとき・車検証の無い車両)</legend>
        <p v-if="!vehicles.length" class="text-xs text-gray-500">車両マスタに車両がありません</p>
        <div class="flex flex-wrap gap-x-4 gap-y-1">
          <label v-for="v in vehicles" :key="v.id" class="flex items-center gap-1 text-sm text-gray-800">
            <input v-model="row.vehicle_ids" type="checkbox" :value="v.id" data-testid="tenko-office-vehicle">
            {{ v.registration_number }}<template v-if="v.display_name"> ({{ v.display_name }})</template>
            <span v-if="otherOfficeName(v, row)" class="text-xs text-gray-500" data-testid="tenko-office-vehicle-elsewhere">— いまは {{ otherOfficeName(v, row) }}</span>
          </label>
        </div>
      </fieldset>

      <fieldset class="space-y-1">
        <legend class="text-sm text-gray-500">置いてある点呼端末 (車両番号の候補でこの営業所の車両を先に出す。1 台を複数の営業所で共用できる)</legend>
        <p v-if="!devices.length" class="text-xs text-gray-500">点呼端末がありません</p>
        <div class="flex flex-wrap gap-x-4 gap-y-1">
          <label v-for="d in devices" :key="d.device_id" class="flex items-center gap-1 text-sm text-gray-800">
            <input v-model="row.device_ids" type="checkbox" :value="d.device_id" data-testid="tenko-office-device">
            {{ deviceName(d) }}
            <span v-if="d.device_id === thisDeviceId" class="text-xs font-medium text-blue-700" data-testid="tenko-office-this-device">(この端末)</span>
            <span v-if="deviceAlsoIn(d.device_id, row)" class="text-xs text-gray-500" data-testid="tenko-office-device-elsewhere">— ほかに {{ deviceAlsoIn(d.device_id, row) }}</span>
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
