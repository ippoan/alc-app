/**
 * 指静脈で人を特定する入口 (Refs ippoan/vein-match#20, ippoan/alc-app#436)。
 * 点呼キオスク (`TenkoKiosk`)・血圧測定台 (`BloodPressureMeasurement`)・運行管理者の入口
 * (`RoleAuthGate`) が同じものを使う — **照合の手順と案内の音声を画面ごとに書き写さない**。
 *
 * ここが持つのは:
 * - Vein Station / Vein Base の接続と、照合に使う写しの同期 (起動時・つながったとき)
 * - 読み取り (`VEIN IDENTIFY` か、古い構成の `VEIN CAPTURE`) と、乗務員の特定
 * - 本人が先に決まっている画面 (`expectedEmployeeId`) では、その 1 人をモジュールに用意して照合する
 *   (Refs ippoan/alc-app-s3#352: モジュールの 91 人の上限を超えても照合できる)。照合は 1:N で、当たった ID が
 *   その人の枠のときだけ通す (`matchVeinModuleEmployee`)。照合は置いた 1 回の指を撮ってから行い (`VEIN IDENTIFY KEEP`)、
 *   通ったら、その 1 本で記録の一番古い 1 本を入れ替える (`rotateVeinModuleRecord`、画面を先へ進めた後に裏で)
 * - 指が置かれた合図 (`EVT VEIN FINGER`) で、待機中なら照合を始めること
 * - 読み取り中・撮り直し・失敗の理由の状態と、失敗の案内の音声 (`VEIN SAY FAILED`)
 *
 * 特定できた後に何をするか (顔認証へ進む・測定へ進む・権限を見る) は画面が `onEmployee` で決める。
 */
import type { ApiEmployee } from '~/types'
import type { RequestTokenScope } from '~/utils/api'
import type { VeinIdentifyOutcome } from '~/utils/vein-identify'
import type { VeinMatch } from '~/utils/vein-module'
import { identifyVeinModuleEmployee, matchVeinModuleEmployee, prepareVeinModuleRecord, retryOnVeinMiss, rotateVeinModuleRecord, usesVeinModule } from '~/utils/vein-module'
import { identifyVeinEmployee, syncVeinTemplates, VEIN_TEMPLATE_SYNC_INTERVAL_MS } from '~/utils/vein-identify'

export interface VeinEmployeeIdentifyOptions {
  /** 一致する人がいなかったときに出す理由 */
  missMessage: string
  /** 一致したのが承認待ちの記録だったときに出す理由 (`name` は引けなければ null) */
  pendingMessage: (name: string | null) => string
  /**
   * 特定できた人を渡す。先へ進めなかったときは画面に出す理由を返す (`null` なら進めた。
   * 理由を自分で別の場所に出したときも `null`)。`via` はモジュールの照合がどの層で当たったか
   * (`FP` = 指紋互換の層だけ → 撮り直しの提案に使う。古いファーム・モジュールを使わない構成は null)
   */
  onEmployee: (employee: ApiEmployee, via: 'FV' | 'FP' | null) => Promise<string | null> | string | null
  /** 指が置かれた合図で照合を始めてよいか (待機中か) */
  isIdle: () => boolean
  /** 照合を始める直前に呼ぶ (画面の前の結果を片付ける) */
  onStart?: () => void
  /**
   * 照合データの同期と、当たった人の照会をどの鍵で行うか (既定はキオスクの鍵)。運行管理者の入口は
   * 運行管理者席の鍵 (`manager-device`) — Vein Base を運行管理者席の鍵にした PC にはキオスクの鍵が無い
   */
  scope?: RequestTokenScope
  /**
   * 本人が先に (免許証・社員番号で) 決まっていれば、その乗務員の ID。返せば 1:N ではなく、その人の記録を
   * モジュールに用意して 1:1 で照合する。決まっていなければ null (1:N)
   */
  expectedEmployeeId?: () => string | null
  /** 1:1 で照合しようとした人に、承認済みの指静脈の記録が無かったときに出す理由 (既定は `missMessage`) */
  noRecordMessage?: string
  /** どの画面の照合か。診断ログ (`[vein] 照合開始 screen=…`) にだけ使う (例: manager / it-tenko / kiosk / bp) */
  label?: string
}

export function useVeinEmployeeIdentify(opts: VeinEmployeeIdentifyOptions) {
  const vein = useVeinSerial()
  /** 読み取りと特定の途中 */
  const busy = ref(false)
  /** 照合の途中でモジュールが撮り直しを求めた (`EVT VEIN AGAIN`)。ボタンの文言を「もう一度」に変える */
  const again = ref(false)
  /** 直前の照合が先へ進めなかった理由 */
  const error = ref<string | null>(null)
  /** Vein Station / Vein Base が繋がっていて照合できる */
  const ready = computed(() => vein.isSupported && vein.isConnected.value)

  /** 照合に使う写しを取る。モジュールで照合する構成は機体のモジュールも揃える */
  function sync(syncOpts: { ifOlderThanMs?: number } = {}) {
    return syncVeinTemplates({ ...syncOpts, module: usesVeinModule() ? vein : undefined, scope: opts.scope })
  }

  onMounted(() => {
    void vein.connect()
    void sync()
  })
  // つながったら、モジュールを揃える (起動時はまだつながっていない)
  watch(vein.isConnected, (c) => {
    if (c) void sync({ ifOlderThanMs: VEIN_TEMPLATE_SYNC_INTERVAL_MS })
  })

  /**
   * 不一致の自動のやり直しの前に、画面と機器の両方で「もう一度置いてください」を出す。
   * 機器は指の置き直しを黙って待つので、鳴らさないと画面が止まったように見える (2026-11-02 実機、23 秒待って NO_FINGER)
   */
  async function sayAgain(): Promise<void> {
    again.value = true
    await vein.say('AGAIN').catch(() => {})
  }

  /** 用意しかけの記録 (同じ人なら、免許証を読んだときに始めた書き込みを照合が待つ) */
  let prepared: { employeeId: string; promise: Promise<number | null> } | null = null

  /**
   * `employeeId` の記録をモジュールに用意する (無い・古ければサーバーから取って書く。約 2 秒)。
   * 免許証を読んだ時点で呼んでおけば、「指を置いて」の案内と書き込みが重なる。照合の ID を返す (記録が無ければ null)
   */
  function prepare(employeeId: string): Promise<number | null> {
    if (prepared?.employeeId !== employeeId) {
      const promise = prepareVeinModuleRecord(vein, employeeId, opts.scope)
      prepared = { employeeId, promise }
      // 失敗した用意は使い回さない (次の照合で取り直す)
      promise.catch(() => { prepared = null })
    }
    return prepared.promise
  }

  /** 免許証・社員番号で本人が決まった時点で、その人の記録を書き始める (モジュールを使う構成だけ。失敗は照合の時に出す) */
  function prewrite(employeeId: string): void {
    if (usesVeinModule()) prepare(employeeId).catch(() => {})
  }

  /** 本人が決まっている人を 1:1 で照合し、当たれば `onEmployee` へ渡す。先へ進めなかった理由を返す */
  async function verifyExpected(employeeId: string, prompt: boolean): Promise<string | null> {
    let moduleId: number | null
    try {
      moduleId = await prepare(employeeId)
    }
    catch (e) {
      return `指静脈の記録をこの端末に用意できませんでした (${(e as Error).message})`
    }
    finally {
      // 用意は 1 回の照合で使い切る (次の回までに枠を譲っているかもしれない)
      prepared = null
    }
    if (moduleId === null) return opts.noRecordMessage ?? opts.missMessage
    let match: VeinMatch | null
    try {
      if (prompt) await vein.say('PLACE')
      // 他人・不一致は 1 回だけ自動でやり直す (matchVeinModuleEmployee)
      const onAgain = () => { again.value = true }
      match = await matchVeinModuleEmployee(vein, employeeId, onAgain, sayAgain)
    }
    catch (e) {
      return `指静脈を読み取れませんでした (${(e as Error).message})`
    }
    if (match === null) return opts.missMessage
    const outcome = await identifyVeinModuleEmployee(match.id, opts.scope)
    const failure = await deliver(outcome, true)
    // 通った: 同じ置き方で撮った 1 本で一番古い 1 本を入れ替える (先へ進めた後に裏で。失敗しても照合の結果は変えない)
    if (outcome.kind === 'hit') void rotateVeinModuleRecord(vein, match, employeeId, opts.scope)
    return failure
  }

  /** 特定の結果を `onEmployee` へ渡すか、理由にする */
  async function deliver(outcome: VeinIdentifyOutcome, viaModule: boolean): Promise<string | null> {
    switch (outcome.kind) {
      case 'hit': return await opts.onEmployee(outcome.employee, viaModule ? vein.lastMatch.value?.via ?? null : null)
      case 'miss': return opts.missMessage
      case 'pending': return opts.pendingMessage(outcome.name)
      case 'error': return outcome.message
    }
  }

  /** 読み取って人を特定し、`onEmployee` へ渡す。先へ進めなかった理由を返す */
  async function readAndIdentify(prompt: boolean): Promise<string | null> {
    const viaModule = usesVeinModule()
    const expected = viaModule ? opts.expectedEmployeeId?.() ?? null : null
    if (expected) return await verifyExpected(expected, prompt)
    let read: string | number | null
    try {
      // 指の合図から始めたときは、もう置かれているので「指を置いて」は鳴らさない
      if (prompt) await vein.say('PLACE')
      // モジュール自身が照合して ID を返す (Refs ippoan/alc-app#436)
      // モジュールの不一致は 1 回だけ自動でやり直す (retryOnVeinMiss)
      const onAgain = () => { again.value = true }
      read = viaModule
        ? await retryOnVeinMiss(() => vein.identify(onAgain), id => id === null, sayAgain)
        : await vein.capture()
    }
    catch (e) {
      return `指静脈を読み取れませんでした (${(e as Error).message})`
    }
    const outcome = viaModule
      ? await identifyVeinModuleEmployee(read as number | null, opts.scope)
      : await identifyVeinEmployee(read as string)
    return await deliver(outcome, viaModule)
  }

  /** 照合を 1 回走らせる。繋がっていない・読み取り中なら何もしない */
  async function identify({ prompt = true }: { prompt?: boolean } = {}): Promise<void> {
    if (!ready.value || busy.value) return
    console.info(`[vein] 照合開始 screen=${opts.label ?? '-'} prompt=${prompt}`)
    opts.onStart?.()
    busy.value = true
    again.value = false
    error.value = null
    const failure = await readAndIdentify(prompt)
    if (failure) {
      error.value = failure
      // 案内の失敗は握り潰す (画面の理由が主)
      await vein.say('FAILED').catch(() => {})
    }
    busy.value = false
  }

  // 指が置かれた合図 (EVT VEIN FINGER) で照合を始める。待機中のときだけ。ボタンは古いファーム向けに残す
  const stopFingerWatch = vein.onFingerPlaced(() => {
    if (opts.isIdle()) void identify({ prompt: false })
  })
  onUnmounted(stopFingerWatch)

  return {
    ready,
    // 書ける形で返す: 血圧測定台は、カードで決めた人を指静脈で確かめる間 (1:1) も同じ状態を使う
    busy,
    again,
    error,
    identify,
    prewrite,
    sync,
  }
}
