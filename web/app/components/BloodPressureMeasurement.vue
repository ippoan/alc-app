<script setup lang="ts">
import type { FaceAuthResult } from '~/types'
import { getEmployeeByCode, getEmployeeByNfcId, startMeasurement, updateMeasurement } from '~/utils/api'
import { devTiming } from '~/utils/dev-timing'
import { checkFaceApproval } from '~/utils/face-approval'
import { employeeNotFoundByCode, employeeNotFoundByNfc, employeeLookupFailureMessage } from '~/utils/employee-lookup-messages'
import { prepareVeinModuleRecord, usesVeinModule } from '~/utils/vein-module'
import { VEIN_TEMPLATE_SYNC_INTERVAL_MS } from '~/utils/vein-identify'
import { restartVeinAndReload } from '~/utils/vein-restart'

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
 *   つながっていれば、「指を置いて照合」とカードの枠を横に並べる (カードは縦を詰めた表示)。
 *   手順は点呼キオスク (`TenkoKiosk`) の指静脈と同じ。つながっていなければカードだけの画面のまま。
 * - **指静脈で特定したときは顔認証を飛ばして測定へ進む** (指静脈が本人確認そのもの)。顔の審査
 *   (`applyFaceApproval`) も通さないので、審査中・却下でも止めない。カードで特定したときは従来どおり顔認証。
 * - 血圧を受けたらすぐ完了の段へ進み、保存は裏で行う。保存中は次の人へ進ませず、失敗したら完了の段でやり直せる (Refs ippoan/alc-app#436)
 * - 保存が済んだ完了の段は、結果の下に最初の画面 (指・カード・社員番号) も出し、{@link DONE_RETURN_SECONDS} 秒の
 *   カウントダウンで最初の画面へ戻る。「次の人へ」を押さなくても、次の人が指を置く・カードをかざすとそのまま進む
 */

type BpStep = 'nfc' | 'face_auth' | 'measure' | 'done' | 'vein' | 'vein_list' | 'bp_ble' | 'vein_pending' | 'thermo_test'

const { bpUiState } = useBpUiEnabled()
const { latestBloodPressure } = useBleGateway()
const veinSerial = useVeinSerial()
// 照合の手順・接続・写しの同期・指の合図は 3 つの入口で共通 (useVeinEmployeeIdentify)。
// 読み取り中 (`vein.busy`)・撮り直し・理由は、カードで決めた人の 1:1 の確かめ (下) も使う
const vein = useVeinEmployeeIdentify({
  missMessage: '照合できませんでした。もう一度置くか、下のカードか社員番号で進んでください',
  pendingMessage: name => `${name ?? 'この人'}さんの指静脈は未承認です。下の「未承認の指静脈」から運行管理者が承認してください`,
  onEmployee: (emp) => {
    proceedWithVeinEmployee(emp)
    return null
  },
  // 待機中 (カード待ちで、カードの照会も指静脈の読み取りも走っていない) のときだけ
  isIdle: () => (step.value === 'nfc' || doneSettled.value) && !vein.busy.value && employeeLookups.value === 0,
  onStart: () => {
    leaveDone()
    error.value = null
  },
})
/** Vein Station が繋がっていて、指静脈で照合できる (ボタンをカードの横に出す) */
const veinReady = vein.ready

const step = ref<BpStep>('nfc')
// ファームの更新を始めてよいかの材料 (Refs ippoan/alc-app#403)。カード待ちでなければ機体を使用中。
// 指静脈を読んでいる間も使用中 (段は `nfc` のまま)
useKioskScreen().declareDeviceBusy(() => step.value !== 'nfc' || vein.busy.value)
/** 段が `nfc` のままカードの照合を待っている件数 (応答が返るまで `step` は動かない) */
const employeeLookups = ref(0)
// 本番 flip 後の新版への載せ替えを、カード待ちのこの画面でも許す (Refs ippoan/alc-app#387)。
// 測定台はタッチを待って開いたままになるので、申告しないと古い版を永久に掴み続ける。
// カード・指静脈の照合中は段が `nfc` でも下ろす (リロードするとタッチが無かったことになる)
useKioskScreen().declareSafeToReload(
  () => step.value === 'nfc' && employeeLookups.value === 0 && !vein.busy.value,
)

// 次の人を待つ段に戻ったとき: 前回の同期から時間がたっていれば取り直す
watch(step, (s) => {
  devTiming('bp.step', { step: s })
  if (s === 'nfc') void vein.sync({ ifOlderThanMs: VEIN_TEMPLATE_SYNC_INTERVAL_MS })
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
  vein.busy.value = true
  vein.again.value = false
  vein.error.value = null
  try {
    const moduleId = await prepareVeinModuleRecord(veinSerial, emp.id)
    if (moduleId === null) return 'no_record'
    await veinSerial.say('PLACE')
    if (await veinSerial.verify(moduleId, () => { vein.again.value = true })) return 'verified'
    await veinSerial.say('FAILED').catch(() => {})
    return '指静脈は一致しませんでした (カード・社員番号で本人を確認済みのため、このまま測定します)'
  }
  catch (e) {
    // 端末のファームが古い (VEIN VERIFY が無い)・モジュールが応答しない・記録を書けなかった等
    return `指静脈を確かめられませんでした (${(e as Error).message})。カード・社員番号で本人を確認済みのため、このまま測定します`
  }
  finally {
    vein.busy.value = false
  }
}

/** 指静脈の記録が無かった乗務員。登録画面をこの人で開く (カード・社員番号を打ち直させない) */
const registrationEmployee = ref<{ id: string; name: string } | null>(null)

/**
 * カード・社員番号で特定したら、Vein Station がつながっていれば指静脈 (1:1) で確かめて測定へ。
 * 顔認証は使わない (Refs ippoan/alc-app#436): 指静脈の記録が無ければその人で登録へ、外れ・失敗は
 * 理由を出してカード・社員番号の本人確認のまま測定へ。Vein Station がつながっていない端末だけ、
 * 今までどおり顔認証へ進む (顔の審査で止めたら進まない)
 */
async function proceedWithEmployee(emp: { id: string; name: string; face_approval_status?: string }) {
  if (usesVeinModule() && veinSerial.isConnected.value) {
    const outcome = await verifyIdentifiedByVein(emp)
    if (outcome === 'no_record') {
      registrationEmployee.value = { id: emp.id, name: emp.name }
      step.value = 'vein'
      return
    }
    proceedWithVeinEmployee(emp)
    if (outcome !== 'verified') measureNotice.value = outcome
    return
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
  leaveDone()
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

// 血圧を待っている間、Vein Station の BLE が止まっていないかを 1 秒ごとに確かめる
const bleWatch = useBleWatch(veinSerial, computed(() => step.value === 'measure'))
/** 止まりの警告から Vein Station を再起動している / 頼めなかった理由 */
const veinRestarting = ref(false)
const veinRestartError = ref<string | null>(null)

/** 遠隔で操作していると USB の抜き差しができないので、画面から再起動する (後でページを読み直す) */
async function onRestartVein() {
  veinRestarting.value = true
  veinRestartError.value = null
  try {
    await restartVeinAndReload(veinSerial.restart)
  }
  catch (e) {
    veinRestartError.value = e instanceof Error ? e.message : String(e)
    veinRestarting.value = false
  }
}

/** BleStatus の「次へ」。血圧が来る前に押されたら進めずに促す */
function onMeasureNext() {
  if (latestBloodPressure.value) return
  measureNotice.value = '血圧がまだ測れていません。血圧計で測ってください'
}

/** 完了の段で、最初の画面へ戻るまでの秒数 */
const DONE_RETURN_SECONDS = 10

/** 完了の段で保存が済んだ (保存中でも失敗でもない)。このときだけ次の人の入口を出し、カウントダウンする */
const doneSettled = computed(() => step.value === 'done' && !isSaving.value && !saveError.value)
/** 最初の画面へ戻るまでの残り秒数。カウントダウンしていなければ null */
const doneLeft = ref<number | null>(null)
let doneTimer: ReturnType<typeof setInterval> | null = null

function stopDoneCountdown() {
  if (doneTimer) clearInterval(doneTimer)
  doneTimer = null
  doneLeft.value = null
}

watch(doneSettled, (settled) => {
  stopDoneCountdown()
  if (!settled) return
  doneLeft.value = DONE_RETURN_SECONDS
  doneTimer = setInterval(() => {
    doneLeft.value = (doneLeft.value ?? 1) - 1
    if (doneLeft.value <= 0) reset()
  }, 1000)
})
onUnmounted(stopDoneCountdown)

/** 完了の段のまま次の人が始めた (指・カード・社員番号)。前の人の結果を片付けて最初の段へ */
function leaveDone() {
  if (step.value !== 'done') return
  step.value = 'nfc'
  employeeId.value = ''
  employeeName.value = ''
  saveJob = null
  savedReading.value = null
}

function reset() {
  step.value = 'nfc'
  employeeId.value = ''
  employeeName.value = ''
  code.value = ''
  error.value = null
  vein.error.value = null
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
    <VeinRegistration v-if="step === 'vein'" :employee="registrationEmployee" @close="step = 'nfc'; registrationEmployee = null" />

    <!-- この端末の指静脈の一覧 (ID ↔ 乗務員、空き、モジュールの人数) -->
    <VeinModuleList v-else-if="step === 'vein_list'" @close="step = 'nfc'" />
    <BpBluetoothSettings v-else-if="step === 'bp_ble'" @close="step = 'nfc'" />
    <ThermoTest v-else-if="step === 'thermo_test'" @close="step = 'nfc'" />
    <VeinPendingApproval v-else-if="step === 'vein_pending'" @close="step = 'nfc'" />

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

      <!-- Step 1: 指を置く (主) / カードをかざす・社員番号を打つ (予備)。完了の段でも保存が済めば結果の下に出す -->
      <div v-if="step === 'nfc' || doneSettled" data-testid="bp-entry" class="bg-white rounded-2xl p-4 shadow-sm" :class="{ 'order-last': doneSettled }">
        <h2 class="text-lg font-semibold text-gray-700 mb-4">乗務員ID</h2>
        <!-- 指静脈 (Refs ippoan/alc-app#436) とカードを横に並べる。Vein Station が無い端末ではカードだけ -->
        <div :class="veinReady ? 'grid grid-cols-2 gap-3' : ''">
          <div v-if="veinReady" class="flex flex-col">
            <button
              data-testid="vein-identify"
              :disabled="vein.busy.value"
              class="flex-1 w-full px-4 py-4 bg-emerald-600 text-white rounded-2xl text-xl font-bold disabled:opacity-50 hover:bg-emerald-700 transition-colors"
              @click="vein.identify()"
            >
              {{ vein.busy.value ? (vein.again.value ? 'もう一度置いてください…' : '指を置いてください…') : '指を置いて照合' }}
            </button>
            <p v-if="vein.error.value" data-testid="vein-error" class="mt-2 text-sm text-red-600">{{ vein.error.value }}</p>
          </div>
          <NfcStatus :compact="veinReady" @read="onNfcRead" />
        </div>
        <h3 class="mt-6 mb-2 text-sm font-medium text-gray-500">社員番号で進む</h3>
        <EmployeeCodeKeypad v-model="code" @submit="onCodeSubmit" />
      </div>

      <!-- Step 2: 顔認証 -->
      <div v-if="step === 'face_auth'" class="bg-white rounded-2xl p-4 shadow-sm">
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
        <div v-if="bleWatch.state.value !== 'ok'" data-testid="ble-watch-warning" class="mt-3 text-sm text-red-600 text-center">
          <p>血圧計との通信が止まっています。Vein Station を再起動してください</p>
          <button
            data-testid="ble-watch-restart"
            :disabled="veinRestarting"
            class="mt-2 w-full px-4 py-3 rounded-xl bg-amber-500 text-white font-medium disabled:opacity-50"
            @click="onRestartVein"
          >
            {{ veinRestarting ? '再起動しています… (数秒後に画面を読み込み直します)' : 'Vein Station を再起動' }}
          </button>
          <p v-if="veinRestartError" data-testid="ble-watch-restart-error" class="mt-1">{{ veinRestartError }}</p>
        </div>
      </div>

      <!-- Step 4: 完了 -->
      <div v-else-if="step === 'done'" class="bg-white rounded-2xl p-4 shadow-sm text-center">
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
        <p v-if="doneLeft !== null" data-testid="bp-done-countdown" class="mt-4 text-sm text-gray-500">
          あと {{ doneLeft }} 秒で最初の画面に戻ります (下で次の人がそのまま始められます)
        </p>
        <button
          :disabled="isSaving"
          class="w-full mt-3 px-4 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
          @click="reset"
        >
          次の人へ
        </button>
      </div>
    </template>

    <div v-if="step === 'nfc' && veinSerial.isConnected.value" class="grid grid-cols-2 gap-3">
      <button
        class="w-full px-4 py-3 bg-white border border-blue-600 text-blue-700 rounded-xl font-medium hover:bg-blue-50 transition-colors"
        @click="registrationEmployee = null; step = 'vein'; error = null"
      >
        指静脈を登録する
      </button>
      <button
        data-testid="vein-module-list-open"
        class="w-full px-4 py-3 bg-white border border-gray-300 text-gray-700 rounded-xl font-medium hover:bg-gray-50 transition-colors"
        @click="step = 'vein_list'; error = null"
      >
        この端末の指静脈の一覧
      </button>
      <button
        data-testid="vein-pending-open"
        class="col-span-2 w-full px-4 py-3 bg-white border border-amber-500 text-amber-700 rounded-xl font-medium hover:bg-amber-50 transition-colors"
        @click="step = 'vein_pending'; error = null"
      >
        未承認の指静脈 (運行管理者の指で承認)
      </button>
      <button
        data-testid="bp-ble-open"
        class="col-span-2 w-full px-4 py-3 bg-white border border-gray-300 text-gray-700 rounded-xl font-medium hover:bg-gray-50 transition-colors"
        @click="step = 'bp_ble'; error = null"
      >
        血圧計 (Bluetooth) の設定・ペアリング
      </button>
      <button
        data-testid="thermo-test-open"
        class="col-span-2 w-full px-4 py-3 bg-white border border-gray-300 text-gray-700 rounded-xl font-medium hover:bg-gray-50 transition-colors"
        @click="step = 'thermo_test'; error = null"
      >
        体温計の受信テスト (続けて測る)
      </button>
    </div>
  </div>
</template>
