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
  applied.value = true
}

/**
 * サーバの設定が決まったか (初回読み込みが遅れて届いても上書きしないための印)。
 * `bpEnabled` が false のとき、「サーバが false と答えた (この端末では未使用)」と
 * 「まだサーバに聞けていない (未登録・取得失敗)」を画面が区別するために公開する
 * (Refs ippoan/alc-app#322)。
 */
const applied = ref(false)
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
      if (!applied.value) setBpEnabled(settings.bp_enabled)
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
    /** true = サーバの設定が決まった (false でも「未使用と確認できた」ことを表す) */
    bpConfirmed: readonly(applied),
    setBpEnabled,
  }
}

/**
 * 「この端末で血圧を使うか」の表示判定 (Refs ippoan/alc-app#347)。
 *
 * 点呼の経路 (`BleStatus` / `ManualMedicalInput` / `TenkoKiosk`) は**ここだけ**を見る。
 * 以前は `bpEnabled || hasBpHardware` を各画面が写していたが、その 2 つは
 * **CoreS3 キオスクでは両方 false になりうる**:
 *
 * - `bpEnabled` はサーバの `devices.bp_enabled` を `deviceId` で引く。CoreS3 端末は
 *   `devices` に行が無く `deviceId` が構造的に空なので、永久に false
 * - `hasBpHardware` の元になる gateway の `bp_bond` 通知は**値が変わった瞬間に 1 行**
 *   しか出ない。画面が後から読み込み直すと取りこぼす (pull で問い合わせる口が無い)
 *
 * そこで**署名つきでサーバへ渡した値** `signedBpBonded` (`useSignedBpBond`) を 3 本目の
 * 材料に足す — サーバの判断と一致するのはこれだけ。`hasProbedBpBond` で
 * 「まだ取りに行っていない」を分け、**試す前に「未使用」と断じない**
 * (`useSignedBpBond.ts` の `hasProbedBpBond` の doc と同じ流儀)。
 *
 * **読む先は機種に依らない 1 か所** (Refs ippoan/alc-app#353) — CoreS3 キオスク
 * (`useDeviceToken`) も血圧測定台の ATOM S3 も、同じ値へ書き込む。読み手がここと
 * `useTenkoKiosk.isBpRequirementUnknown` の 2 つに分かれているので、**値を機種ごとに
 * 分けると片方だけ直す事故**になる。
 *
 * **`refreshSignedBpBonded()` はここから呼ばない (読むだけ)** — あれは backoff を
 * 解くので、自動点呼の入口ガード (`useTenkoKiosk.isBpRequirementUnknown`) の
 * 「試す前に止めない」判定と競合する。
 *
 * `useBloodPressureSetting()` の戻り値には足していない。中で `useBleGateway()` を
 * 呼ぶと、血圧の段を持たない画面 (端末設定・通常点呼・血圧測定) にも gateway の
 * 副作用が広がるため、**必要な画面だけが呼ぶ 2 本目の口**にした。
 */
export type BpUiState =
  /** 血圧を使う (入力欄・測定値カードを出す) */
  | 'show'
  /** この端末では未使用と確認できた */
  | 'unused'
  /** まだ確認できていない (署名をまだ取りに行っていない) — 判定しない */
  | 'checking'
  /** 試したが分からなかった。ブラウザ側の端末登録も無い */
  | 'unregistered'
  /** 試したが分からなかった。端末登録はあるがサーバ設定が取れていない */
  | 'unavailable'

export function useBpUiEnabled() {
  const { bpEnabled, bpConfirmed } = useBloodPressureSetting()
  const { hasBpHardware } = useBleGateway()
  const { signedBpBonded, hasProbedBpBond } = useSignedBpBond()
  const { deviceId } = useAuth()

  const bpUiState = computed<BpUiState>(() => {
    // 1 つでも「使う」と言っていれば出す (未登録端末でも血圧計が在れば出す、Refs #322)
    if (bpEnabled.value || hasBpHardware.value || signedBpBonded.value === true) return 'show'
    // サーバが false と答えた / 署名で「血圧計は無い」と確認できた
    if (bpConfirmed.value || (hasProbedBpBond.value && signedBpBonded.value === false)) return 'unused'
    // まだ一度も取りに行っていない — ここで「未使用」に倒さない
    if (!hasProbedBpBond.value) return 'checking'
    return deviceId.value ? 'unavailable' : 'unregistered'
  })

  return {
    /** 血圧の「使う / 未使用 / 未確認」の描き分け用 */
    bpUiState,
    /** true = 血圧 UI (状態表示・測定値カード・手入力欄) を出し、血圧の到着を待つ */
    showBpUi: computed(() => bpUiState.value === 'show'),
  }
}
