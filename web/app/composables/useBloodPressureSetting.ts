/**
 * この端末で血圧計を使うかの設定 (Refs ippoan/alc-app-s3#135)。
 *
 * 血圧の表示・手入力欄・自動遷移のすべてがこの 1 つの値を見る。以前は
 * `utils/medical-inputs.ts` の表示フラグ定数が画面から血圧を一律に隠していたが、
 * 血圧計を繋ぐ端末と繋がない端末が混在するため、「この端末で使うか」の 1 系統へ寄せた。
 *
 * 正本はサーバの端末設定 (`devices.bp_enabled`) — 端末の中だけに持つと端末を
 * 入れ替えたときに消えるため。**流し込み口は `setBpEnabled()` 1 本**で、端末設定の
 * 画面 (DeviceSettings) と、下の初回読み込みの両方がここを通る。
 */

/** サーバ設定が届くまでの既定値。血圧計を繋いでいない端末が多数なので false */
const BP_ENABLED_DEFAULT = false

// 画面をまたいで同じ値を見せる (デバイス設定で変えた直後に点呼画面へ反映する)
const bpEnabled = ref(BP_ENABLED_DEFAULT)

/** 端末設定からの唯一の受け口 */
function setBpEnabled(v: boolean) {
  bpEnabled.value = v
  applied = true
}

/** サーバの設定が決まったか (初回読み込みが遅れて届いても上書きしないための印) */
let applied = false
/** サーバへ読みに行ったか。アプリの生存期間で 1 回だけ */
let loadStarted = false

/**
 * サーバの端末設定を 1 回だけ読んで流し込む。端末設定の画面を開かない端末
 * (キオスク) でもサーバの設定が効くよう、**この composable を最初に使った画面**が
 * 引き金になる。取得できない端末 (未登録・オフライン・旧 API) は既定 (false) の
 * まま進む — 点呼を止めないため。
 */
function loadFromServerOnce() {
  if (loadStarted) return
  loadStarted = true
  void (async () => {
    try {
      const { deviceId, deviceSettingsToken } = useAuth()
      if (!deviceId.value) return
      const settings = await getDeviceSettings(deviceId.value, deviceSettingsToken.value)
      // 待っている間に端末設定の画面から決まっていたら、そちらが新しい
      if (!applied) setBpEnabled(settings.bp_enabled)
    } catch {
      // 取得できなければ既定のまま (画面は体温だけで進む)
    }
  })()
}

export function useBloodPressureSetting() {
  loadFromServerOnce()

  return {
    /** true = この端末で血圧計を使う */
    bpEnabled: readonly(bpEnabled),
    setBpEnabled,
  }
}
