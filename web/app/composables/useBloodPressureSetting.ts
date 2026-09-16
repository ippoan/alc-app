/**
 * この端末で血圧計を使うかの設定 (Refs ippoan/alc-app-s3#135)。
 *
 * 血圧の表示・手入力欄・自動遷移のすべてがこの 1 つの値を見る。以前は
 * `utils/medical-inputs.ts` の表示フラグ定数が画面から血圧を一律に隠していたが、
 * 血圧計を繋ぐ端末と繋がない端末が混在するため、「この端末で使うか」の 1 系統へ寄せた。
 *
 * サーバ側の端末設定 (`devices.bp_enabled`) は別 PR で入る。それまでの値は
 * 下の既定値 1 か所だけが決める。**流し込み口はこの composable 1 本に絞る** —
 * 次の PR は `setBpEnabled()` を端末設定から呼ぶだけでよく、画面側は触らない。
 */

/** サーバ設定が届くまでの既定値。血圧計を繋いでいない端末が多数なので false */
const BP_ENABLED_DEFAULT = false

// 画面をまたいで同じ値を見せる (デバイス設定で変えた直後に点呼画面へ反映する)
const bpEnabled = ref(BP_ENABLED_DEFAULT)

export function useBloodPressureSetting() {
  /** 端末設定からの唯一の受け口 (次の PR で `devices.bp_enabled` を繋ぐ) */
  function setBpEnabled(v: boolean) {
    bpEnabled.value = v
  }

  return {
    /** true = この端末で血圧計を使う */
    bpEnabled: readonly(bpEnabled),
    setBpEnabled,
  }
}
