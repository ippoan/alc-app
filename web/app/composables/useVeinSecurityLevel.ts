/**
 * 指静脈モジュールの照合の厳しさ (安全レベル) を端末設定に合わせる (Refs ippoan/alc-app-s3#352)。
 * 設定の意味と保存は `~/utils/vein-security-level`。
 *
 * Vein がつながるたびにモジュールの今の値を読み (`VEIN SECURITY` の応答の行は診断ログにも残る)、設定が
 * `0`〜`2` で今の値と違えば書く。設定を変えたときも、つながっていればその場で書く。
 * 古いファーム (`VEIN SECURITY` が無い) や失敗は黙って次の接続に回す (点呼の画面を止めない)。
 */
import { readVeinSecuritySetting, writeVeinSecuritySetting } from '~/utils/vein-security-level'
import type { VeinSecuritySetting } from '~/utils/vein-security-level'

// シングルトン: 1 台の PC につながる Vein は 1 台。画面をまたいで同じ値を見せる
const setting = ref<VeinSecuritySetting>('keep')
/** モジュールの今の値 (読めていなければ null) */
const moduleLevel = ref<number | null>(null)
let started = false

export function useVeinSecurityLevel() {
  const vein = useVeinSerial()
  setting.value = readVeinSecuritySetting()

  /** モジュールの値を読み、設定と違えば書く。読めた (書いた) 値を返す。失敗は null */
  async function apply(): Promise<number | null> {
    if (!vein.isConnected.value) return null
    try {
      let level = await vein.security()
      const want = setting.value
      if (want !== 'keep' && level !== want) {
        level = await vein.security(want)
        console.info(`[vein] 照合の厳しさを ${want} にしました (モジュールの値 ${level})`)
      }
      moduleLevel.value = level
      return level
    }
    catch (e) {
      console.warn('[vein] 照合の厳しさを読めませんでした (古いファームか、機体が応答しない):', e)
      return null
    }
  }

  function setSetting(v: VeinSecuritySetting): void {
    setting.value = v
    writeVeinSecuritySetting(v)
    void apply()
  }

  /** 起動から 1 回だけ配線する (画面をまたいで 1 本) */
  function start(): void {
    if (started || !import.meta.client) return
    started = true
    watch(vein.isConnected, (connected) => {
      if (connected) void apply()
      else moduleLevel.value = null
    }, { immediate: true })
  }

  return {
    setting: readonly(setting),
    moduleLevel: readonly(moduleLevel),
    setSetting,
    apply,
    start,
  }
}
