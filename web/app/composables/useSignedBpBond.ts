/**
 * 血圧計が端末にボンドされているか — **機種に依らない 1 か所** (Refs ippoan/alc-app#353)。
 *
 * ## なぜ独立した置き場所が要るか
 *
 * この値は「ファームが自分の鍵で署名して返した申告」(`AUTH SIGBP <pubkey> <sig> BP=<1|0>`)
 * で、**サーバが血圧を必須にするかどうかと一致する唯一の材料**。もともと
 * `useDeviceToken.ts` の module スコープに置いていたが、あちらは **CoreS3 (統合ハブ) に
 * 束縛**されている (`coreS3.request` / `coreS3.onClose` を直に呼ぶ)。
 *
 * ところが**血圧測定台は CoreS3 を持たず、ATOM S3 (VoiceS3R) を挿した PC** で、
 * CoreS3 経路を通らない。置き場所を `useDeviceToken` に残したままだと、測定台の
 * ボンド状態はどこにも入らず**永久に `null` (不明)** のままになる。
 *
 * **だからといって「測定台用の signedBpBonded」を別に生やさない** — 読み手
 * ({@link useBpUiEnabled} の表示判定と {@link useTenkoKiosk} の自動点呼の入口ガード) が
 * 2 つに分かれ、**片方だけ直す事故**が起きる。値は 1 つに固定し、**書き手の方を
 * 機種ごとに増やす**。
 *
 * ## 形
 *
 * - 読み手は {@link useSignedBpBond} の `readonly` な 2 つだけを見る (書き換えられない)
 * - 書き手 (機種ごとの経路) は {@link setSignedBpBond} を呼ぶ。いまは CoreS3 経路
 *   (`useDeviceToken.ts`) だけが呼ぶ。**ATOM S3 経路はまだ繋いでいない** (口だけ)
 */

/**
 * 直近の署名で分かった血圧計のボンド状態 (Refs ippoan/alc-app#336)。
 * **3 状態を潰さない** — `true` = ボンドあり (血圧が必須) / `false` = 血圧計が無いと
 * 確認できた (血圧なしで通る) / `null` = **不明** (`AUTH SIGNBP` が通らなかった・
 * 署名の相手が居ない・署名まで届かなかった)。サーバは「不明」を安全側 (血圧必須) に
 * 倒すので、画面はこの値で「この端末で血圧が必須になるか」を先に知れる。
 *
 * `useBleGateway.bpBonded` (gateway の `bp_bond` 通知) とは**別物**。あちらは署名の
 * 無い表示用のヒントで、サーバは見ない。ここは `/device/alarm-token` へ**署名つきで
 * 渡した値**そのもの — サーバの判断と一致するのはこちらだけ。
 */
const signedBpBonded = ref<boolean | null>(null)
/**
 * ボンド状態を**一度でも取りに行ったか** (Refs ippoan/alc-app#336)。
 * `signedBpBonded` の `null` には「まだ署名を試していない」(起動直後・探索中) と
 * 「試したが分からなかった」(古いファーム・署名の相手が居ない) の 2 つが乗るので、
 * **その 2 つを分ける印**。`isStartupJwtPending` と同じ流儀の「決まったかどうか」で、
 * `useBloodPressureSetting` の `bpConfirmed` (= `applied`) と同じ役どころ。
 *
 * **試す前に端末を締め出さない**ために要る — 画面はこれが false のあいだ判定しない。
 * 署名を試し終えたら (成功・失敗・署名の相手が居ない のいずれでも) true になる。
 */
const hasProbedBpBond = ref(false)

/**
 * 署名で分かったボンド状態を書き込む — **機種ごとの経路が共通で使う 1 本の口**
 * (Refs ippoan/alc-app#353)。
 *
 * 呼んだ時点で「取りに行った」({@link hasProbedBpBond}) も立つ。**分からなかった回も
 * `null` で呼ぶ** — 「試した結果として不明」と「まだ試していない」を分けるのが
 * `hasProbedBpBond` の役目なので、失敗経路が黙って帰ると画面は永久に `checking` のまま
 * 止まる。
 */
export function setSignedBpBond(bonded: boolean | null): void {
  signedBpBonded.value = bonded
  hasProbedBpBond.value = true
}

/** 署名つきの血圧計ボンド状態を**読む**ための 1 か所 (Refs ippoan/alc-app#353) */
export function useSignedBpBond() {
  return {
    /** 直近の署名で分かった血圧計のボンド状態 (#336)。true=あり / false=無いと確認できた / null=不明 */
    signedBpBonded: readonly(signedBpBonded),
    /** ボンド状態を一度でも取りに行ったか (#336)。false のあいだは `signedBpBonded` の null が「未取得」を意味する */
    hasProbedBpBond: readonly(hasProbedBpBond),
  }
}
