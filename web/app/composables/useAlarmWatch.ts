/**
 * 据置警告デバイス (Atom VoiceS3R / USB) の見張りを、ロールタブに関わらずアプリで 1 本だけ動かす。
 *
 * 見張り = 着信購読 (useActiveRooms.start) と警告デバイスへの接続 (useAlarmDevice.connect)。
 * **この 2 つは必ず対で動かす** — 購読せずに接続すると heartbeat が `HB NG signaling` になり
 * デバイスが鳴る (useAlarmDevice 冒頭の規約)。止めるときも対で止める。
 *
 * 呼び口はトップ画面 (pages/index.vue) の 1 か所。運行管理者の PC は運行者などのタブを
 * ログイン無しで使うので、運行管理者タブ (ManagerAlarmBar) に入るまで繋がないと、
 * 警告デバイスが未接続のままになる (Refs #231)。ManagerAlarmBar は表示と「接続」ボタンだけ。
 *
 * 動かすのは「この端末で使う」(useAlarmDeviceSetting が true) かつ Web Serial が使えるときだけ。
 * 止めるのは設定を off にしたときだけ — ロールタブ切替やトップ画面の unmount では止めない (#205)。
 *
 * ## 運行管理者の鍵のトークンの先取り (Refs ippoan/alc-app#387)
 *
 * 警告デバイスが繋がるたびに、運行管理者の鍵のトークンを 1 回取りに行く。開発用の印
 * (`isDevDevice('manager-device')`) は鍵のトークンを 1 度取ったときに立つが、Google ログイン済みの
 * 席は管理者のトークンで足りてしまい、取りに行く引き金が他に無い (測定台とキオスクには
 * 同じ先取りが既にある — `useBpStationDeviceToken` / `useHubClaim`)。
 * トークンの cache が有効なあいだは通信しない。失敗しても何も起こさない。
 */

/**
 * 見張りを始めたか (アプリ全体で 1 つ)。トップ画面の再 mount で二重に始めないため
 * module スコープで持つ — start() は参照カウント (対になる stop が無いと下がらない)、
 * connect() も no-op ではない (installNgWatch / arbiter.register / 再接続の印の削除)
 */
let started = false
/** 先取りの見張りを止める関数。start() が入れ、stop() が呼ぶ (stop は始めた後にしか進まない) */
let stopPrefetchWatch!: () => void

/**
 * 運行管理者の鍵のトークンを先に取っておく。**例外は外へ出さない。**
 *
 * 繋がった直後は警告デバイスの準備が間に合わずに失敗することがある。失敗の抑止 (60 秒) を
 * 残すと後続の本物の要求まで null になるので、取れなかったときは抑止の期限を先取りの前の値へ戻す。
 */
async function prefetchManagerToken(): Promise<void> {
  try {
    const manager = useManagerDeviceToken()
    const before = manager.backoffUntil.value
    if (await manager.getManagerJwt() === null) {
      // 戻り値は readonly なので、包まれている元の ref に書く
      ;(toRaw(manager.backoffUntil) as Ref<number>).value = before
    }
  }
  catch { /* 先取りは best effort */ }
}

export function useAlarmWatch(): void {
  const alarm = useAlarmDevice()
  // Web Serial の無いブラウザでは購読も heartbeat も立てない
  if (!alarm.isSupported) return
  const rooms = useActiveRooms()
  const { enabled } = useAlarmDeviceSetting()

  function start(): void {
    if (started) return
    started = true
    rooms.start()
    // BLE ゲートウェイと同居しない PC なので、ポートの取り合いを待つ必要が無い
    alarm.connect(0)
    // トップ画面の unmount で止まらないよう、component から切り離した scope で見張る。
    // immediate: 始めた時点で既に繋がっていれば、そのとき 1 回
    const scope = effectScope(true)
    scope.run(() => watch(alarm.isConnected, (connected) => {
      if (connected) void prefetchManagerToken()
    }, { immediate: true }))
    stopPrefetchWatch = () => scope.stop()
  }

  function stop(): void {
    if (!started) return
    started = false
    stopPrefetchWatch()
    void alarm.disconnect()
    // 参照カウントなので、遠隔点呼タブの子が先に stop していても WebSocket は残る
    rooms.stop()
  }

  // 探索は「使う」と決まってから。未設定のあいだは ManagerAlarmBar の問いかけカードだけを出す
  onMounted(() => {
    if (enabled.value === true) start()
  })
  watch(enabled, (v) => {
    // 問いかけカードで [つなぐ] を選んだ瞬間に始める
    if (v === true) start()
    // 設定を off にしたときだけ止める (unmount では止めない = ロールタブ切替で鳴らさない)
    else if (v === false) stop()
  })
}
