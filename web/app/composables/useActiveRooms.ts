/**
 * signaling の room 一覧 (= 端末が繋いでいる部屋) を、アプリ全体で 1 本だけ購読する singleton。
 *
 * 初期取得は `GET /active-rooms`、以後の更新は `/watch-rooms` の WebSocket で受ける。
 * 遠隔点呼モニターと画面共有モニターが同じ一覧を見るため、画面ごとに WebSocket を
 * 張ると signaling 側の接続が画面数だけ増える。ここに畳んで 1 本にする。
 *
 * start/stop は参照カウント: 運行管理者ダッシュボード (親) と子画面が同時に持つので、
 * 子が unmount しても親が持っているあいだは WebSocket を落とさない。落とすと
 * 「signaling 切断」を見張っている側が誤検知する。
 *
 * **dev端末 (運行管理者席の鍵に dev の印がある) だけ**、運行管理者席の鍵のトークンを
 * `?token=` で付ける (Refs ippoan/alc-app#387)。signaling はそれを見て dev の部屋だけを返す。
 * 取れなければ**繋がない** (token なしで繋ぐと本番の部屋の一覧を受けてしまう)。
 * 印が無い席は今までどおり token を付けず、`start()` の同期の流れの中で WebSocket を作る。
 *
 * **印は購読を張った後に変わることがある** (鍵のトークンを 1 度取ったときに立つ)。張った時の軸
 * (token 付き / なし) と今の印が食い違ったら、一覧を空にして張り直す — 古い軸の部屋を
 * 着信として数えないため。印が無い端末ではイベントが出ないので、張り直しは 1 度も走らない。
 *
 * ## 着信として数える部屋 (`callingRooms`)
 *
 * 「着信中か」の判定はここ 1 か所 (警告デバイスの `call=1` と `ManagerAlarmBar` の表示が読む)。
 * 管理者がどの部屋にも入っておらず、**対応を終えてもいない**部屋だけを数える。
 * 対応を終えた部屋 = 通話に入ってから抜けた部屋 (`setJoined(null)`)。相手が画面を閉じて部屋が
 * 消えるまで一覧に残るが、もう着信ではない。一覧から消えたら印も消えるので、同じ id の部屋が
 * 後で再び現れたら新しい着信として数える。通話に入らずに画面を離れただけの部屋は数え続ける。
 */
import { DEV_DEVICE_MARK_EVENT, devSignalingToken, isDevDevice } from '~/utils/token-selection'

/** 生存確認。signaling 側のアイドルタイムアウトより短く */
const PING_INTERVAL = 30000
/** 切断されたら待ってから張り直す */
const RECONNECT_DELAY = 3000

/** 購読は 1 本なので module スコープで持つ (start/stop は client でしか呼ばれない) */
let ws: WebSocket | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let refCount = 0
// dev端末がトークンを待つあいだに stop() や次の connect() が来たら、待っていた古い方は
// WebSocket を作らない (二重に張らない)
let connectGeneration = 0
/** いまの購読を張った時の軸 (運行管理者席の鍵に dev の印が在ったか) */
let subscribedAsDev = false
/** 印の変化を聞く関数。最初の start() が入れ、最後の stop() が外す */
let markListener!: () => void

export function useActiveRooms() {
  const config = useRuntimeConfig()

  const activeRooms = useState<string[]>('active-rooms', () => [])
  /** WebSocket が open かどうか */
  const isWatching = useState<boolean>('active-rooms-watching', () => false)
  /** 運行管理者が今どの room に入っているか (未参加は null) */
  const joinedRoomId = useState<string | null>('active-rooms-joined', () => null)
  /** 対応を終えた部屋 (通話に入ってから抜けた)。常に一覧に在る id だけを持つ */
  const handledRooms = useState<string[]>('active-rooms-handled', () => [])
  const callingRooms = computed(() => joinedRoomId.value !== null
    ? []
    : activeRooms.value.filter(id => !handledRooms.value.includes(id)))

  const signalingHttpUrl = (config.public.signalingUrl as string).replace(/^wss/, 'https').replace(/^ws:/, 'http:')
  const signalingWsUrl = (config.public.signalingUrl as string).replace(/^https/, 'wss').replace(/^http:/, 'ws:')

  /** dev端末だけが呼ぶ。運行管理者席の鍵のトークンを query にする (取れなければ throw) */
  async function devTokenQuery(): Promise<string> {
    return `?token=${encodeURIComponent(await devSignalingToken(useManagerDeviceToken().getManagerJwt))}`
  }

  /** 一覧を差し替える (ここ 1 か所)。一覧から消えた部屋は「対応を終えた」の印も消す */
  function setRooms(rooms: string[]) {
    activeRooms.value = rooms
    handledRooms.value = handledRooms.value.filter(id => rooms.includes(id))
  }

  /** `GET /active-rooms` を 1 回。成功したら true (エラー文言は画面ごとに違うので投げない) */
  async function reload(): Promise<boolean> {
    const asDev = isDevDevice('manager-device')
    try {
      let url = `${signalingHttpUrl}/active-rooms`
      // dev端末: トークンが取れなければ throw → 下の catch で false (fetch を出さない)
      if (asDev) url += await devTokenQuery()
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { rooms: string[] }
      // 待つあいだに印が変わった = 古い軸の一覧。捨てる (張り直しの側が取り直す)
      if (asDev !== isDevDevice('manager-device')) return false
      setRooms(data.rooms)
      return true
    }
    catch {
      return false
    }
  }

  function connect() {
    reconnectTimer = null
    subscribedAsDev = isDevDevice('manager-device')
    if (subscribedAsDev) {
      void connectAsDev()
      return
    }
    openSocket(`${signalingWsUrl}/watch-rooms`)
  }

  /** dev端末の接続。トークンが取れなければ WebSocket を作らず、いつもの間隔で試し直す */
  async function connectAsDev() {
    const generation = ++connectGeneration
    let query: string | null = null
    try {
      query = await devTokenQuery()
    }
    catch { /* 下で試し直しに回す */ }
    // 待つあいだに stop() された / 次の connect() が始まった
    if (generation !== connectGeneration) return
    if (query === null) {
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY)
      return
    }
    openSocket(`${signalingWsUrl}/watch-rooms${query}`)
  }

  function openSocket(url: string) {
    const socket = new WebSocket(url)
    ws = socket

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'rooms_updated') {
          setRooms(data.rooms)
        }
      }
      catch { /* 壊れた frame は捨てる */ }
    }

    socket.onopen = () => {
      isWatching.value = true
      pingTimer = setInterval(() => socket.send('ping'), PING_INTERVAL)
    }

    socket.onclose = () => {
      isWatching.value = false
      ws = null
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
      // ここへ来るのは相手や回線が切ったときだけ (自分で手放すときは dropSocket が先に
      // handler を外す) = 使っている画面が残っているので張り直す
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY)
    }

    socket.onerror = () => {
      socket.close()
    }
  }

  /** 張ってある (または張ろうとしている) 購読を手放す。参照カウントは触らない */
  function dropSocket() {
    connectGeneration += 1
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    if (ws) {
      // 閉じた後に遅れて届く close や frame で、次に張った側の状態を壊さない
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      ws.close()
      ws = null
    }
    isWatching.value = false
  }

  /**
   * 印が変わった (`DEV_DEVICE_MARK_EVENT`)。張った時の軸と食い違っていれば張り直す。
   * イベントは他の種類の鍵 (キオスク・測定台) の印でも出るので、軸が同じなら何もしない
   */
  function onDevMarkChanged() {
    if (isDevDevice('manager-device') === subscribedAsDev) return
    dropSocket()
    // 張り直すまでの間、古い軸の部屋を着信として数えない
    setRooms([])
    connect()
    void reload()
  }

  /** 購読を 1 つ増やす。最初の 1 つ目で WebSocket を張る */
  function start() {
    refCount += 1
    if (refCount > 1) return
    markListener = onDevMarkChanged
    window.addEventListener(DEV_DEVICE_MARK_EVENT, markListener)
    connect()
  }

  /** 購読を 1 つ減らす。最後の 1 つが外れたら WebSocket を閉じる */
  function stop() {
    if (refCount === 0) return
    refCount -= 1
    if (refCount > 0) return

    window.removeEventListener(DEV_DEVICE_MARK_EVENT, markListener)
    dropSocket()
  }

  /**
   * 管理者が入っている部屋を出し入れする。**通話を抜けた (`null` に戻した) とき、入っていた部屋は
   * 「対応を終えた」として着信から外す** — 相手が画面を閉じて部屋が消えるまで鳴り続けないため。
   * 入っていなかったときの `null` は何も外さない (通話に入らずに離れた部屋は着信のまま)。
   */
  function setJoined(roomId: string | null) {
    const left = joinedRoomId.value
    joinedRoomId.value = roomId
    if (left === null || roomId !== null) return
    if (activeRooms.value.includes(left) && !handledRooms.value.includes(left)) {
      handledRooms.value = [...handledRooms.value, left]
    }
  }

  return {
    activeRooms: readonly(activeRooms),
    isWatching: readonly(isWatching),
    joinedRoomId: readonly(joinedRoomId),
    callingRooms,
    start,
    stop,
    setJoined,
    reload,
  }
}
