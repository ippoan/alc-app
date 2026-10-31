import { readVeinAddedFingerMode, writeVeinAddedFingerMode } from '~/utils/vein-added-finger-mode'
import type { VeinAddedFingerMode } from '~/utils/vein-added-finger-mode'

/**
 * 「この端末の指を足す」で足した指をモジュールに何として置くか、の端末設定 (Refs ippoan/alc-app#558)。
 * 値の意味と保存は `~/utils/vein-added-finger-mode`。デバイス設定の画面が使う。
 */

// 画面をまたいで同じ値を見せる (useAlarmDeviceSetting と同じ)
const mode = ref<VeinAddedFingerMode>('mixed')

export function useVeinAddedFingerSetting() {
  mode.value = readVeinAddedFingerMode()

  function setMode(v: VeinAddedFingerMode) {
    mode.value = v
    writeVeinAddedFingerMode(v)
  }

  return {
    mode: readonly(mode),
    setMode,
  }
}
