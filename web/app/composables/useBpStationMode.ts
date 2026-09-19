/**
 * この画面を**血圧測定台として扱うか** — 判定はここ 1 か所 (Refs ippoan/alc-app#368)。
 *
 * # 何を見るか
 *
 * **URL の印と端末の名乗りの OR**:
 *
 * - `?station=bp` … `manifest-bp.webmanifest` の `start_url`
 *   (`/?role=driver&tab=bp&station=bp`) で開かれたか
 * - `DEVICE bp-station` … 端末自身の名乗り。`useSerialArbiter` の probe が読んで
 *   決着させる (`arbitratedDeviceKind`)
 *
 * # なぜ名乗りを足したか
 *
 * 「測定台はこの長い URL で開いてください」と人に配る運用が 3 回事故を起こした
 * (PWA のインストール名が「点呼キオスク」になる / `?tab=bp` だけでは ATOM S3 の
 * 署名経路に入らない / `?station=bp` だけだと既定タブが通常点呼になる)。
 * **端末は自分で名乗っているのに URL でもう一度書かせていた**のが発生源なので、
 * 名乗りを一次情報にし、URL は「URL が言っている」という判断材料の 1 つとして残す。
 *
 * # URL を消さない理由
 *
 * `?station=bp` 付きの既存 URL とインストール済みの PWA を壊さないことが優先。
 * 名乗りを待たずに起動の時点で測定台として動けるので、既存端末の挙動は変わらない。
 *
 * # 未確定を測定台に倒さない
 *
 * `arbitratedDeviceKind` は 3 値で、決着前は `null`。この判定が true になるのは
 * **`'bp-station'` と決着したときだけ**で、未確定のあいだは false のまま =
 * 従来どおりキオスクとして振る舞う。CoreS3 と測定台が両方挿さっている PC は
 * arbiter 側が CoreS3 優先 (`'other'`) に倒すので、ここも false。
 *
 * # 読み手
 *
 * - `pages/index.vue` … 測定台の device JWT getter を `api.ts` へ入れるか
 * - `useBpUiEnabled` … 血圧 UI を出すか
 *
 * **値を 2 か所に書かない** — 読み手が分かれているので、片方だけ直す事故になる
 * (`useSignedBpBond` を 1 本にしたのと同じ理由)。
 */
export function useBpStationMode() {
  const route = useRoute()
  const { arbitratedDeviceKind } = useSerialArbiter()

  /**
   * URL が「測定台として起動した」と言っているか。`driverSubTab` と同じく
   * **起動時のクエリで 1 回だけ**評価する非リアクティブな値 (URL 同期は
   * `history.replaceState` で書くので `route.query` はそもそも動かない)。
   *
   * **`?tab=bp` では判定しない** — URL 同期はハンバーガーで血圧測定タブを選んだ
   * どの端末でも `?tab=bp` を書き込むため、通常端末でそれを選んでリロードすると
   * 「測定台として起動した」と誤認して点呼へ戻れなくなる (Refs ippoan/alc-app#353、
   * 裏取りで実測)。`tab=` は「いまどのタブか」、`station=` は「測定台として起動したか」
   * で問いが別。
   */
  const isBpStationUrl = route.query.station === 'bp'

  return {
    /** URL が測定台と言っているか (URL 同期が `station=bp` を書き戻すかの判断に使う) */
    isBpStationUrl,
    /** 測定台として扱うか (URL の印 ∪ 端末の名乗り) */
    isBpStation: computed(() => isBpStationUrl || arbitratedDeviceKind.value === 'bp-station'),
  }
}
