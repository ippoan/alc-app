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
 */

/** 生存確認。signaling 側のアイドルタイムアウトより短く */
const PING_INTERVAL = 30000
/** 切断されたら待ってから張り直す */
const RECONNECT_DELAY = 3000

/** 購読は 1 本なので module スコープで持つ (start/stop は client でしか呼ばれない) */
let ws: WebSocket | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let refCount = 0

export function useActiveRooms() {
  const config = useRuntimeConfig()

  const activeRooms = useState<string[]>('active-rooms', () => [])
  /** WebSocket が open かどうか */
  const isWatching = useState<boolean>('active-rooms-watching', () => false)
  /** 運行管理者が今どの room に入っているか (未参加は null) */
  const joinedRoomId = useState<string | null>('active-rooms-joined', () => null)

  const signalingHttpUrl = (config.public.signalingUrl as string).replace(/^wss/, 'https').replace(/^ws:/, 'http:')
  const signalingWsUrl = (config.public.signalingUrl as string).replace(/^https/, 'wss').replace(/^http:/, 'ws:')

  /** `GET /active-rooms` を 1 回。成功したら true (エラー文言は画面ごとに違うので投げない) */
  async function reload(): Promise<boolean> {
    try {
      const res = await fetch(`${signalingHttpUrl}/active-rooms`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { rooms: string[] }
      activeRooms.value = data.rooms
      return true
    }
    catch {
      return false
    }
  }

  function connect() {
    reconnectTimer = null
    const socket = new WebSocket(`${signalingWsUrl}/watch-rooms`)
    ws = socket

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'rooms_updated') {
          activeRooms.value = data.rooms
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
      // 使っている画面が残っているあいだだけ張り直す
      if (refCount > 0) reconnectTimer = setTimeout(connect, RECONNECT_DELAY)
    }

    socket.onerror = () => {
      socket.close()
    }
  }

  /** 購読を 1 つ増やす。最初の 1 つ目で WebSocket を張る */
  function start() {
    refCount += 1
    if (refCount === 1) connect()
  }

  /** 購読を 1 つ減らす。最後の 1 つが外れたら WebSocket を閉じる */
  function stop() {
    if (refCount === 0) return
    refCount -= 1
    if (refCount > 0) return

    if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    if (ws) { ws.close(); ws = null }
    isWatching.value = false
  }

  function setJoined(roomId: string | null) {
    joinedRoomId.value = roomId
  }

  return {
    activeRooms: readonly(activeRooms),
    isWatching: readonly(isWatching),
    joinedRoomId: readonly(joinedRoomId),
    start,
    stop,
    setJoined,
    reload,
  }
}
