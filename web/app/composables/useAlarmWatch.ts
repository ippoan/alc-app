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
 */

/**
 * 見張りを始めたか (アプリ全体で 1 つ)。トップ画面の再 mount で二重に始めないため
 * module スコープで持つ — start() は参照カウント (対になる stop が無いと下がらない)、
 * connect() も no-op ではない (installNgWatch / arbiter.register / 再接続の印の削除)
 */
let started = false

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
  }

  function stop(): void {
    if (!started) return
    started = false
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
