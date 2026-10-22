<script setup lang="ts">
import type { FaceAuthResult } from '~/types'
import { getEmployeeByCode, getEmployeeByNfcId, startMeasurement, updateMeasurement } from '~/utils/api'
import { devTiming } from '~/utils/dev-timing'
import { checkFaceApproval } from '~/utils/face-approval'
import { employeeNotFoundByCode, employeeNotFoundByNfc, employeeLookupFailureMessage } from '~/utils/employee-lookup-messages'
import { identifyVeinModuleEmployee, prepareVeinModuleRecord, usesVeinModule } from '~/utils/vein-module'
import { identifyVeinEmployee, syncVeinTemplates, VEIN_TEMPLATE_SYNC_INTERVAL_MS } from '~/utils/vein-identify'

/**
 * 血圧だけを測る端末の画面 (Refs ippoan/alc-app-s3#135)。
 *
 * 測る場所と点呼する場所を分けたいという要望から、**カードをかざす → 顔認証 →
 * 血圧を測る → 完了**だけを行う。指静脈で特定したときは顔認証を挟まない (下記)。ここで測った値は「直近の血圧」として後から
 * 点呼が引き当てる (引き当て側は別 PR)。
 *
 * - **点呼のセッションは作らない。** `useTenkoKiosk` も `saveMeasurement` も使わない —
 *   前者は点呼のセッションが前提の作りで、後者は `record_as_tenko: true` を固定で送る。
 *   保存は通常点呼と同じ `startMeasurement` → `updateMeasurement` の口を使い、
 *   `record_as_tenko` を**付けない**ので点呼の記録にはならない。
 * - 顔の扱いは `utils/face-approval.ts` の判定 1 か所に従う。**未登録なら飛ばせる**
 *   (乗務員の点呼と同じ方針)。審査中・却下は登録済みなので従来どおり弾く。
 * - 血圧計が使えない端末では案内だけを出す。判定は**生の `bpEnabled` ではなく
 *   `useBpUiEnabled()` の `bpUiState`** を見る (Refs ippoan/alc-app#353) —
 *   測定台は `devices` に行を持たず `deviceId` が構造的に空なので、サーバ設定
 *   (`devices.bp_enabled`) は**永久に false** で、直参照だと測定台が 1 台も測れない。
 *   `checking` (まだ署名を取りに行っていない) は**「使わない設定」に倒さず待つ** —
 *   倒すと起動直後に必ず詰まる。
 * - Vein Station (指静脈読み取り端末) がつながっているときだけ、カード待ちの段に
 *   指静脈の登録 (`VeinRegistration`) への入口を出す (Refs ippoan/vein-match#20)。
 *   血圧計の有無とは関係しないので、血圧計が見つからない端末でも出す。
 * - 乗務員の特定は**指静脈が主、カードは予備** (Refs ippoan/alc-app#436)。Vein Station が
 *   つながっていれば、カード待ちの段の上に「指を置いて照合」を大きく出し、カードは下に置く。
 *   手順は点呼キオスク (`TenkoKiosk`) の指静脈と同じ。つながっていなければカードだけの画面のまま。
 * - **指静脈で特定したときは顔認証を飛ばして測定へ進む** (指静脈が本人確認そのもの)。顔の審査
 *   (`applyFaceApproval`) も通さないので、審査中・却下でも止めない。カードで特定したときは従来どおり顔認証。
 * - 血圧を受けたらすぐ完了の段へ進み、保存は裏で行う。保存中は次の人へ進ませず、失敗したら完了の段でやり直せる (Refs ippoan/alc-app#436)
 */

type BpStep = 'nfc' | 'face_auth' | 'measure' | 'done' | 'vein'

const { bpUiState } = useBpUiEnabled()
const { latestBloodPressure } = useBleGateway()
const veinSerial = useVeinSerial()
/** あわせて端末のモジュールも揃える (`syncVeinModule`、測定台も同じ。Refs ippoan/alc-app#436) */
function syncVein(opts: { ifOlderThanMs?: number } = {}) {
  return syncVeinTemplates({ ...opts, module: usesVeinModule() ? veinSerial : undefined })
}
onMounted(() => {
  void veinSerial.connect()
  // オフラインの指静脈照合に使う写しを取る (点呼キオスクと同じ)
  void syncVein()
})
// Vein Station がつながったら、モジュールを揃える (起動時はまだつながっていない)
watch(veinSerial.isConnected, (c) => {
  if (c) void syncVein({ ifOlderThanMs: VEIN_TEMPLATE_SYNC_INTERVAL_MS })
})

const step = ref<BpStep>('nfc')
/** 指静脈を読んで乗務員を特定している間 (段が `measure` へ進むまで) true */
const veinBusy = ref(false)
const veinError = ref<string | null>(null)
/** 照合の途中でモジュールが撮り直しを求めた (`EVT VEIN AGAIN`)。ボタンの文言を「もう一度」に変える */
const veinAgain = ref(false)
// ファームの更新を始めてよいかの材料 (Refs ippoan/alc-app#403)。カード待ちでなければ機体を使用中。
// 指静脈を読んでいる間も使用中 (段は `nfc` のまま)
useKioskScreen().declareDeviceBusy(() => step.value !== 'nfc' || veinBusy.value)
/** 段が `nfc` のままカードの照合を待っている件数 (応答が返るまで `step` は動かない) */
const employeeLookups = ref(0)
// 本番 flip 後の新版への載せ替えを、カード待ちのこの画面でも許す (Refs ippoan/alc-app#387)。
// 測定台はタッチを待って開いたままになるので、申告しないと古い版を永久に掴み続ける。
// カード・指静脈の照合中は段が `nfc` でも下ろす (リロードするとタッチが無かったことになる)
useKioskScreen().declareSafeToReload(
  () => step.value === 'nfc' && employeeLookups.value === 0 && !veinBusy.value,
)

// 次の人を待つ段に戻ったとき: 前回の同期から時間がたっていれば取り直す
watch(step, (s) => {
  devTiming('bp.step', { step: s })
  if (s === 'nfc') void syncVein({ ifOlderThanMs: VEIN_TEMPLATE_SYNC_INTERVAL_MS })
})
const employeeId = ref('')
const employeeName = ref('')
const error = ref<string | null>(null)
const measureNotice = ref<string | null>(null)
const isSaving = ref(false)
const saveError = ref<string | null>(null)
const savedReading = ref<{ systolic: number; diastolic: number; pulse?: number } | null>(null)

// 顔が未登録の乗務員は顔認証を飛ばせる (判定は utils/face-approval.ts、通すかは入口が決める)
const faceSkippable = ref(false)
const faceSkipNotice = ref<string | null>(null)

/** 通してよければ true。通す場合はスキップ可否も控える */
function applyFaceApproval(emp: { name: string; face_approval_status?: string }): boolean {
  const approval = checkFaceApproval(emp)
  if (approval.kind === 'blocked') { error.value = approval.message; return false }
  faceSkippable.value = approval.kind === 'unregistered'
  faceSkipNotice.value = approval.kind === 'unregistered'
    ? `${approval.message}。顔認証をスキップして進めます`
    : null
  return true
}

/** 乗務員を控える (カード・指静脈どちらの入口も通る) */
function selectEmployee(emp: { id: string; name: string }) {
  employeeId.value = emp.id
  employeeName.value = emp.name
}

/**
 * カード・社員番号で本人が決まった乗務員を、指静脈で確かめる (Refs ippoan/alc-app#436)。
 * その人の記録をこの端末のモジュールに用意し (無ければ DB から取ってきて書く)、ID を指定した 1:1 で照合する。
 * 当たれば `'verified'`、指静脈の記録が無ければ `'no_record'`、外れ・失敗は画面に出す文言
 */
async function verifyIdentifiedByVein(emp: { id: string; name: string }): Promise<'verified' | 'no_record' | string> {
  veinBusy.value = true
  veinAgain.value = false
  veinError.value = null
  try {
    const moduleId = await prepareVeinModuleRecord(veinSerial, emp.id)
    if (moduleId === null) return 'no_record'
    await veinSerial.say('PLACE')
    if (await veinSerial.verify(moduleId, () => { veinAgain.value = true })) return 'verified'
    await veinSerial.say('FAILED').catch(() => {})
    return '指静脈で確認できませんでした。顔認証で進みます'
  }
  catch (e) {
    return `指静脈を確かめられませんでした (${(e as Error).message})。顔認証で進みます`
  }
  finally {
    veinBusy.value = false
  }
}

/**
 * カード・社員番号で特定したら、Vein Station がつながっていれば指静脈 (1:1) で確かめて測定へ。
 * つながっていない・指静脈の記録が無い・外れたときは顔認証へ進む (顔の審査で止めたら進まない)
 */
async function proceedWithEmployee(emp: { id: string; name: string; face_approval_status?: string }) {
  if (usesVeinModule() && veinSerial.isConnected.value) {
    const outcome = await verifyIdentifiedByVein(emp)
    if (outcome === 'verified') return proceedWithVeinEmployee(emp)
    if (outcome !== 'no_record') error.value = outcome
  }
  if (!applyFaceApproval(emp)) return
  selectEmployee(emp)
  step.value = 'face_auth'
}

/**
 * 指静脈で特定したら顔認証を挟まず測定へ進む (Refs ippoan/alc-app#436)。指静脈が本人確認そのもの。
 * 顔を使わないので `applyFaceApproval` は通さず、顔の審査中・却下でも止めない。
 */
function proceedWithVeinEmployee(emp: { id: string; name: string }) {
  selectEmployee(emp)
  faceSkippable.value = false
  faceSkipNotice.value = null
  skipFaceAuth()
}

/** カード・社員番号で乗務員を引き、引けたら本人確認へ (どちらも同じ手順) */
async function lookupEmployee(find: () => Promise<{ id: string; name: string; face_approval_status?: string }>, notFound: string) {
  error.value = null
  employeeLookups.value += 1
  try {
    await proceedWithEmployee(await find())
  } catch (e) {
    error.value = employeeLookupFailureMessage(e, notFound)
  } finally {
    employeeLookups.value -= 1
  }
}

function onNfcRead(nfcId: string) {
  return lookupEmployee(() => getEmployeeByNfcId(nfcId), employeeNotFoundByNfc(nfcId))
}

// 社員番号のキーパッド (`EmployeeCodeKeypad`) が打った番号。カードを持っていないときの入口
const code = ref('')

function onCodeSubmit(c: string) {
  return lookupEmployee(() => getEmployeeByCode(c, 'bp-station'), employeeNotFoundByCode(c))
}

/** 指静脈で乗務員を特定する (手順は TenkoKiosk と同じ)。失敗したら画面に出す理由を返す */
async function identifyByVein(prompt: boolean): Promise<string | null> {
  const viaModule = usesVeinModule()
  let read: string | number | null
  try {
    // 指の合図から始めたときは、もう置かれているので「指を置いて」は鳴らさない
    if (prompt) await veinSerial.say('PLACE')
    // モジュール自身が照合して ID を返す (Refs ippoan/alc-app#436)
    read = viaModule ? await veinSerial.identify(() => { veinAgain.value = true }) : await veinSerial.capture()
  } catch (e) {
    return `指静脈を読み取れませんでした (${(e as Error).message})`
  }
  const outcome = viaModule
    ? await identifyVeinModuleEmployee(read as number | null)
    : await identifyVeinEmployee(read as string)
  if (outcome.kind === 'miss') return '照合できませんでした。もう一度置くか、下のカードか社員番号で進んでください'
  if (outcome.kind === 'error') return outcome.message
  proceedWithVeinEmployee(outcome.employee)
  return null
}

async function onVeinIdentify({ prompt = true }: { prompt?: boolean } = {}) {
  if (veinBusy.value) return
  veinBusy.value = true
  veinAgain.value = false
  veinError.value = null
  error.value = null
  const failure = await identifyByVein(prompt)
  if (failure) {
    veinError.value = failure
    // 案内の失敗は握り潰す (画面の理由が主)
    await veinSerial.say('FAILED').catch(() => {})
  }
  veinBusy.value = false
}

// 指が置かれた合図 (EVT VEIN FINGER) で照合を始める。待機中 (カード待ちで、カードの照会も
// 指静脈の読み取りも走っていない) のときだけ。ボタンは古いファーム向けに残す
const isVeinIdle = computed(
  () => step.value === 'nfc' && !veinBusy.value && employeeLookups.value === 0,
)
const stopFingerWatch = veinSerial.onFingerPlaced(() => {
  if (isVeinIdle.value) void onVeinIdentify({ prompt: false })
})
onUnmounted(stopFingerWatch)

function onFaceAuthResult(result: FaceAuthResult) {
  if (!result.verified) return
  measureNotice.value = null
  step.value = 'measure'
}

function skipFaceAuth() {
  onFaceAuthResult({ verified: true, similarity: 0, skipped: true })
}

/** 保存 1 件ぶん。`measurementId` は start が通った回に控え、やり直しは update から行う */
interface SaveJob {
  employeeId: string
  bp: NonNullable<typeof latestBloodPressure.value>
  measurementId: string | null
}
let saveJob: SaveJob | null = null

/**
 * 血圧を 1 件だけ保存する。`record_as_tenko` を送らないので点呼の記録は作られない。
 * アルコール値は無いので `alcohol_value` / `result_type` は触らない。
 * 段は動かさない (完了の段は値を受けた時点で出ている)。成功・失敗は `isSaving` / `saveError` で表す。
 */
async function save(job: SaveJob) {
  isSaving.value = true
  saveError.value = null
  const t0 = Date.now()
  devTiming('bp.save.begin')
  try {
    if (!job.measurementId) {
      job.measurementId = (await startMeasurement(job.employeeId)).id
      devTiming('bp.save.start-done', { ms: Date.now() - t0 })
    }
    await updateMeasurement(job.measurementId, {
      status: 'completed',
      systolic: job.bp.systolic,
      diastolic: job.bp.diastolic,
      pulse: job.bp.pulse,
      medical_measured_at: job.bp.measuredAt.toISOString(),
    })
    devTiming('bp.save.update-done', { ms: Date.now() - t0 })
  } catch (e) {
    devTiming('bp.save.failed', { ms: Date.now() - t0 })
    saveError.value = e instanceof Error ? e.message : '血圧の保存に失敗しました'
  } finally {
    isSaving.value = false
  }
}

// 血圧が届いたらすぐ完了の段へ進み、保存は裏で走らせる。BleStatus が mount 時に読み値を消すので、
// 前の人の値では発火しない (immediate にしないのも同じ理由)。完了の段では弾くので二重に保存しない
watch(latestBloodPressure, (bp) => {
  if (!bp || step.value !== 'measure') return
  savedReading.value = { systolic: bp.systolic, diastolic: bp.diastolic, pulse: bp.pulse }
  step.value = 'done'
  // 保存中に reset されても別の人の ID で保存しないよう、今の乗務員 ID をここで固定する
  saveJob = { employeeId: employeeId.value, bp, measurementId: null }
  void save(saveJob)
})

/** 完了の段の「もう一度保存」。同じ値・同じ ID で、通っていた手前の段は飛ばして続ける */
function onRetrySave() {
  if (!saveJob || isSaving.value) return
  void save(saveJob)
}

/** BleStatus の「次へ」。血圧が来る前に押されたら進めずに促す */
function onMeasureNext() {
  if (latestBloodPressure.value) return
  measureNotice.value = '血圧がまだ測れていません。血圧計で測ってください'
}

function reset() {
  step.value = 'nfc'
  employeeId.value = ''
  employeeName.value = ''
  code.value = ''
  error.value = null
  veinError.value = null
  measureNotice.value = null
  saveError.value = null
  saveJob = null
  savedReading.value = null
  faceSkippable.value = false
  faceSkipNotice.value = null
}
</script>

<template>
  <div class="w-full max-w-md mx-auto p-4 flex flex-col gap-4">
    <!-- 指静脈の登録 (入口は下のボタン) -->
    <VeinRegistration v-if="step === 'vein'" @close="step = 'nfc'" />

    <!-- まだ署名を取りに行っている最中: 待つ (ここで「使わない」に倒すと起動直後に詰まる) -->
    <div v-else-if="bpUiState === 'checking'" class="bg-white rounded-2xl p-4 shadow-sm text-center">
      <h2 class="text-lg font-semibold text-gray-700 mb-2">血圧測定</h2>
      <div class="flex items-center justify-center gap-3 py-2 text-sm text-gray-500">
        <span class="inline-block w-5 h-5 border-2 border-gray-300 border-t-blue-600 rounded-full animate-spin" />
        血圧計を確認しています...
      </div>
    </div>

    <!-- 血圧計が使えない端末: 何も測らせない -->
    <div v-else-if="bpUiState !== 'show'" class="bg-white rounded-2xl p-4 shadow-sm text-center">
      <h2 class="text-lg font-semibold text-gray-700 mb-2">血圧測定</h2>
      <p class="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
        血圧計が見つかりません
      </p>
      <p class="mt-2 text-xs text-gray-500">
        血圧計の電源が入っていて、この端末とペアリング済みか確認してください。
      </p>
    </div>

    <template v-else>
      <div v-if="error" class="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
        {{ error }}
      </div>

      <!-- Step 1: 指を置く (主) / カードをかざす・社員番号を打つ (予備) -->
      <div v-if="step === 'nfc'" class="bg-white rounded-2xl p-4 shadow-sm">
        <h2 class="text-lg font-semibold text-gray-700 mb-4">乗務員ID</h2>
        <!-- 指静脈 (Refs ippoan/alc-app#436)。Vein Station が無い端末ではカードだけ -->
        <template v-if="veinSerial.isSupported && veinSerial.isConnected.value">
          <button
            data-testid="vein-identify"
            :disabled="veinBusy"
            class="w-full px-6 py-8 bg-emerald-600 text-white rounded-2xl text-2xl font-bold disabled:opacity-50 hover:bg-emerald-700 transition-colors"
            @click="onVeinIdentify()"
          >
            {{ veinBusy ? (veinAgain ? 'もう一度置いてください…' : '指を置いてください…') : '指を置いて照合' }}
          </button>
          <p v-if="veinError" data-testid="vein-error" class="mt-2 text-sm text-red-600">{{ veinError }}</p>
          <h3 class="mt-6 mb-2 text-sm font-medium text-gray-500">カードで進む</h3>
        </template>
        <NfcStatus @read="onNfcRead" />
        <h3 class="mt-6 mb-2 text-sm font-medium text-gray-500">社員番号で進む</h3>
        <EmployeeCodeKeypad v-model="code" @submit="onCodeSubmit" />
      </div>

      <!-- Step 2: 顔認証 -->
      <div v-else-if="step === 'face_auth'" class="bg-white rounded-2xl p-4 shadow-sm">
        <h2 class="text-lg font-semibold text-gray-700 mb-4">顔認証</h2>
        <p class="text-sm text-gray-500 mb-2">{{ employeeName }}さん</p>
        <!-- 顔が未登録: 顔写真なしで進める (審査中・却下はここまで来ない) -->
        <template v-if="faceSkippable">
          <p class="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4">
            {{ faceSkipNotice }}
          </p>
          <button
            class="w-full px-4 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
            @click="skipFaceAuth"
          >
            顔認証をスキップして進む
          </button>
        </template>
        <FaceAuth
          v-else
          :employee-id="employeeId"
          mode="verify"
          @result="onFaceAuthResult"
        />
      </div>

      <!-- Step 3: 血圧を測る -->
      <div v-else-if="step === 'measure'" class="bg-white rounded-2xl p-4 shadow-sm">
        <h2 class="text-lg font-semibold text-gray-700 mb-2">血圧測定</h2>
        <p class="text-sm text-gray-500 mb-4">{{ employeeName }}さん</p>
        <BleStatus @next="onMeasureNext" @skip="reset" />
        <p v-if="measureNotice" class="mt-3 text-sm text-amber-700 text-center">{{ measureNotice }}</p>
      </div>

      <!-- Step 4: 完了 -->
      <div v-else class="bg-white rounded-2xl p-4 shadow-sm text-center">
        <h2 class="text-lg font-semibold text-gray-700 mb-2">測定完了</h2>
        <p class="text-sm text-gray-500 mb-4">{{ employeeName }}さん</p>
        <p v-if="savedReading" class="text-3xl font-mono font-bold text-blue-700">
          {{ savedReading.systolic }}<span class="text-lg font-normal">/</span>{{ savedReading.diastolic }}
          <span class="text-sm font-normal text-gray-500">mmHg</span>
        </p>
        <p v-if="savedReading?.pulse" class="mt-1 text-sm text-gray-500">
          脈拍 {{ savedReading.pulse }} bpm
        </p>
        <p v-if="isSaving" class="mt-3 text-sm text-gray-500">保存中...</p>
        <template v-else-if="saveError">
          <p class="mt-3 text-sm text-red-600">{{ saveError }}</p>
          <button
            data-testid="retry-save"
            class="w-full mt-3 px-4 py-3 bg-white border border-blue-600 text-blue-700 rounded-xl font-medium hover:bg-blue-50 transition-colors"
            @click="onRetrySave"
          >
            もう一度保存
          </button>
        </template>
        <button
          :disabled="isSaving"
          class="w-full mt-6 px-4 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
          @click="reset"
        >
          次の人へ
        </button>
      </div>
    </template>

    <button
      v-if="step === 'nfc' && veinSerial.isConnected.value"
      class="w-full px-4 py-3 bg-white border border-blue-600 text-blue-700 rounded-xl font-medium hover:bg-blue-50 transition-colors"
      @click="step = 'vein'; error = null"
    >
      指静脈を登録する
    </button>
  </div>
</template>
