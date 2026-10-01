import { DurableObject } from 'cloudflare:workers';
import { DEV_HEADER, isDevRequest } from './auth';

type ClientRole = 'device' | 'admin';

interface IceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

interface SignalingMessage {
  type: 'sdp_offer' | 'sdp_answer' | 'ice_candidate' | 'ping';
  sdp?: string;
  candidate?: IceCandidate;
}

interface ServerMessage {
  type: 'sdp_offer' | 'sdp_answer' | 'ice_candidate' | 'peer_joined' | 'peer_left' | 'error' | 'pong';
  sdp?: string;
  candidate?: IceCandidate;
  role?: ClientRole;
  message?: string;
}

interface Env {
  ROOM_REGISTRY: DurableObjectNamespace;
}

/** 各接続の属性。WS の attachment に持つ (hibernation から復帰しても残る)。 */
interface PeerAttachment {
  /** dev端末の鍵で入った接続か (worker が introspect の結果から決めた値)。 */
  dev: boolean;
  /** dev の device が入ってきて切られた admin。close の完了までの間、居ないものとして扱う。 */
  kicked?: true;
}

/** dev の部屋から dev でない admin を切るときの close code (1008 = Policy Violation)。 */
const CLOSE_DEV_ROOM = 1008;

export class SignalingRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get('role') as ClientRole;

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const dev = isDevRequest(request);

    // Check if this role is already connected
    const existing = this.liveSockets(role);
    if (existing.length > 0) {
      return new Response(`Role "${role}" is already connected to this room`, { status: 409 });
    }

    // dev端末が入っている部屋には、dev の鍵の admin しか入れない (Refs ippoan/alc-app#387)。
    // dev でない部屋の参加条件は変えない。
    if (role === 'admin' && !dev && this.liveSockets('device').some(ws => this.getAttachment(ws).dev)) {
      return new Response('Forbidden', { status: 403 });
    }

    const pair = new WebSocketPair();
    // Accept with role tag for Hibernatable WebSockets
    this.ctx.acceptWebSocket(pair[1], [role]);
    pair[1].serializeAttachment({ dev } satisfies PeerAttachment);

    // admin が先に入っている部屋に dev の device が入ってきたら、dev でない admin を切る。
    if (role === 'device' && dev) {
      for (const admin of this.liveSockets('admin')) {
        if (this.getAttachment(admin).dev) continue;
        admin.serializeAttachment({ dev: false, kicked: true } satisfies PeerAttachment);
        try {
          admin.close(CLOSE_DEV_ROOM, 'dev room');
        } catch {
          // WebSocket already closed
        }
      }
    }

    // device が接続したら RoomRegistry に登録 + 応答通知
    if (role === 'device') {
      const roomId = this.getRoomId(request.url);
      await this.registryRequest('PUT', roomId, dev);
      await this.registryAnswered(roomId, dev);
    }

    // Notify the other peer that a new participant joined
    this.notifyPeer(role, { type: 'peer_joined', role });

    // If the other peer is already connected, notify the newly joined client too
    const peerRole: ClientRole = role === 'device' ? 'admin' : 'device';
    const existingPeers = this.liveSockets(peerRole);
    if (existingPeers.length > 0) {
      this.send(pair[1], { type: 'peer_joined', role: peerRole });
    }

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    let data: SignalingMessage;
    try {
      data = JSON.parse(message);
    } catch {
      this.send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    // 切られた admin からの SDP / ICE は中継しない (close の完了を待たない)
    if (this.getAttachment(ws).kicked) return;

    const senderRole = this.getRole(ws);
    if (!senderRole) {
      this.send(ws, { type: 'error', message: 'Unknown sender' });
      return;
    }

    switch (data.type) {
      case 'sdp_offer':
        // Device sends offer → relay to admin
        if (senderRole !== 'device') {
          this.send(ws, { type: 'error', message: 'Only device can send sdp_offer' });
          return;
        }
        this.notifyPeer(senderRole, { type: 'sdp_offer', sdp: data.sdp });
        break;

      case 'sdp_answer':
        // Admin sends answer → relay to device
        if (senderRole !== 'admin') {
          this.send(ws, { type: 'error', message: 'Only admin can send sdp_answer' });
          return;
        }
        this.notifyPeer(senderRole, { type: 'sdp_answer', sdp: data.sdp });
        break;

      case 'ice_candidate':
        // Either side can send ICE candidates → relay to peer
        this.notifyPeer(senderRole, { type: 'ice_candidate', candidate: data.candidate });
        break;

      case 'ping':
        this.send(ws, { type: 'pong' });
        break;

      default:
        this.send(ws, { type: 'error', message: `Unknown message type: ${(data as { type: string }).type}` });
    }
  }

  // ws は runtime 側で既に close 済み (このハンドラが呼ばれる契機そのもの)。
  // 再度 ws.close() を呼ぶと、abrupt disconnect (ページリロード等) で client
  // 側が返す予約コード (1005 "No Status Received" 等) をそのまま渡すことに
  // なり InvalidAccessError で例外になる。例外になると DO 側のタグ解除が
  // 完了せず、再接続が「role already connected」(409) で弾かれ続ける
  // ゾンビ状態になっていた (ippoan/alc-app cam-room で実機検証中に発覚)。
  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const role = this.getRole(ws);
    // 切られた admin は device に peer_joined を出していないので、peer_left も出さない。
    if (role && !this.getAttachment(ws).kicked) {
      this.notifyPeer(role, { type: 'peer_left', role });
      // device が切断したら RoomRegistry から削除
      if (role === 'device') {
        const roomId = await this.getRoomIdFromStorage();
        if (roomId) await this.registryRequest('DELETE', roomId);
      }
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const role = this.getRole(ws);
    if (role && !this.getAttachment(ws).kicked) {
      this.notifyPeer(role, { type: 'peer_left', role });
      if (role === 'device') {
        const roomId = await this.getRoomIdFromStorage();
        if (roomId) await this.registryRequest('DELETE', roomId);
      }
    }
  }

  /** Get the role tag attached to a WebSocket */
  private getRole(ws: WebSocket): ClientRole | null {
    const tags = this.ctx.getTags(ws);
    if (tags.includes('device')) return 'device';
    if (tags.includes('admin')) return 'admin';
    return null;
  }

  /** attachment を読む。attachment の無い接続 (この変更より前に張られたもの) は dev でない。 */
  private getAttachment(ws: WebSocket): PeerAttachment {
    const att = ws.deserializeAttachment() as Partial<PeerAttachment> | null;
    return { dev: att?.dev === true, ...(att?.kicked ? { kicked: true } : {}) };
  }

  /** その role の接続のうち、切られていないもの。 */
  private liveSockets(role: ClientRole): WebSocket[] {
    return this.ctx.getWebSockets(role).filter(ws => !this.getAttachment(ws).kicked);
  }

  /** Send a message to the peer (the other role) */
  private notifyPeer(senderRole: ClientRole, message: ServerMessage): void {
    const peerRole: ClientRole = senderRole === 'device' ? 'admin' : 'device';
    const peers = this.liveSockets(peerRole);
    for (const peer of peers) {
      this.send(peer, message);
    }
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // WebSocket already closed
    }
  }

  /** Extract roomId from request URL path (/room/:roomId) */
  private getRoomId(urlStr: string): string {
    const url = new URL(urlStr);
    const match = url.pathname.match(/^\/room\/([^/?]+)/);
    return match ? match[1] : '';
  }

  /** Get stored roomId — ハイバネーション後もDOストレージから復元 */
  private async getRoomIdFromStorage(): Promise<string | null> {
    const cached = (this as unknown as { _roomId?: string })._roomId;
    if (cached) return cached;
    const stored = await this.ctx.storage.get<string>('roomId');
    return stored ?? null;
  }

  /** Notify RoomRegistry that a room has been answered (device connected) */
  private async registryAnswered(roomId: string, dev: boolean): Promise<void> {
    if (!roomId) return;
    try {
      const id = this.env.ROOM_REGISTRY.idFromName('registry');
      const stub = this.env.ROOM_REGISTRY.get(id);
      await stub.fetch(`https://registry/rooms/${roomId}/answered`, {
        method: 'POST',
        headers: { [DEV_HEADER]: dev ? '1' : '0' },
      });
    } catch {
      // Registry への通知失敗は無視
    }
  }

  /** Call the RoomRegistry HTTP API */
  private async registryRequest(method: 'PUT' | 'DELETE', roomId: string, dev = false): Promise<void> {
    if (!roomId) return;
    // インスタンス変数キャッシュ + DO永続ストレージの両方に保存
    (this as unknown as { _roomId?: string })._roomId = roomId;
    if (method === 'PUT') {
      await this.ctx.storage.put('roomId', roomId);
    }
    try {
      const id = this.env.ROOM_REGISTRY.idFromName('registry');
      const stub = this.env.ROOM_REGISTRY.get(id);
      await stub.fetch(`https://registry/rooms/${roomId}`, {
        method,
        headers: { [DEV_HEADER]: dev ? '1' : '0' },
      });
    } catch {
      // Registry への通知失敗は無視 (RTC 接続には影響しない)
    }
  }
}
