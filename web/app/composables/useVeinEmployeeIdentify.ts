/**
 * 指静脈で人を特定する入口 (Refs ippoan/vein-match#20, ippoan/alc-app#436)。
 * 点呼キオスク (`TenkoKiosk`)・血圧測定台 (`BloodPressureMeasurement`)・運行管理者の入口
 * (`RoleAuthGate`) が同じものを使う — **照合の手順と案内の音声を画面ごとに書き写さない**。
 *
 * ここが持つのは:
 * - Vein Station / Vein Base の接続と、照合に使う写しの同期 (起動時・つながったとき)
 * - 読み取り (`VEIN IDENTIFY` か、古い構成の `VEIN CAPTURE`) と、乗務員の特定
 * - 指が置かれた合図 (`EVT VEIN FINGER`) で、待機中なら照合を始めること
 * - 読み取り中・撮り直し・失敗の理由の状態と、失敗の案内の音声 (`VEIN SAY FAILED`)
 *
 * 特定できた後に何をするか (顔認証へ進む・測定へ進む・権限を見る) は画面が `onEmployee` で決める。
 */
import type { ApiEmployee } from '~/types'
import type { RequestTokenScope } from '~/utils/api'
import { identifyVeinModuleEmployee, usesVeinModule } from '~/utils/vein-module'
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

  /** 読み取って人を特定し、`onEmployee` へ渡す。先へ進めなかった理由を返す */
  async function readAndIdentify(prompt: boolean): Promise<string | null> {
    const viaModule = usesVeinModule()
    let read: string | number | null
    try {
      // 指の合図から始めたときは、もう置かれているので「指を置いて」は鳴らさない
      if (prompt) await vein.say('PLACE')
      // モジュール自身が照合して ID を返す (Refs ippoan/alc-app#436)
      read = viaModule ? await vein.identify(() => { again.value = true }) : await vein.capture()
    }
    catch (e) {
      return `指静脈を読み取れませんでした (${(e as Error).message})`
    }
    const outcome = viaModule
      ? await identifyVeinModuleEmployee(read as number | null, opts.scope)
      : await identifyVeinEmployee(read as string)
    switch (outcome.kind) {
      case 'hit': return await opts.onEmployee(outcome.employee, viaModule ? vein.lastMatch.value?.via ?? null : null)
      case 'miss': return opts.missMessage
      case 'pending': return opts.pendingMessage(outcome.name)
      case 'error': return outcome.message
    }
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
    sync,
  }
}
