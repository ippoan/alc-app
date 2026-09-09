import { isClient } from '~/utils/env'

/**
 * この端末で警告デバイス (Atom VoiceS3R / USB) を使うかの設定。
 *
 * 警告デバイスをつなぐ PC は運行管理者の 1 台だけ。他の PC / タブレットで「運行管理者」
 * タブを開いてもバーやポート探索が出ないよう、端末ごとに localStorage へ持つ (#135)。
 *
 * - `'on'`  → true (使う)
 * - `'off'` → false (使わない)
 * - 未設定  → null (登録前 / 既存の端末。ManagerAlarmBar が問いかけカードを出す)
 */
const STORAGE_KEY = 'alc-alarm-device'

// 画面をまたいで同じ値を見せる (デバイス設定で変えた直後にバーへ反映する)
const enabled = ref<boolean | null>(null)

function readStored(): boolean | null {
  if (!isClient) return null
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'on') return true
    if (v === 'off') return false
    return null
  } catch {
    // private mode 等で localStorage が使えない環境では未設定扱い
    return null
  }
}

export function useAlarmDeviceSetting() {
  enabled.value = readStored()

  function setEnabled(v: boolean) {
    enabled.value = v
    if (!isClient) return
    try {
      localStorage.setItem(STORAGE_KEY, v ? 'on' : 'off')
    } catch {
      // 保存できなくても、このセッションのあいだは値を保つ
    }
  }

  return {
    /** true = 使う / false = 使わない / null = 未設定 */
    enabled: readonly(enabled),
    setEnabled,
  }
}
