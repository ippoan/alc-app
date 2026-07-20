import { DurableObject } from 'cloudflare:workers';

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

export class SignalingRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get('role') as ClientRole;

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    // Check if this role is already connected
    const existing = this.ctx.getWebSockets(role);
    if (existing.length > 0) {
      return new Response(`Role "${role}" is already connected to this room`, { status: 409 });
    }

    const pair = new WebSocketPair();
    // Accept with role tag for Hibernatable WebSockets
    this.ctx.acceptWebSocket(pair[1], [role]);

    // device が接続したら RoomRegistry に登録 + 応答通知
    if (role === 'device') {
      const roomId = this.getRoomId(request.url);
      await this.registryRequest('PUT', roomId);
      await this.registryAnswered(roomId);
    }

    // Notify the other peer that a new participant joined
    this.notifyPeer(role, { type: 'peer_joined', role });

    // If the other peer is already connected, notify the newly joined client too
    const peerRole: ClientRole = role === 'device' ? 'admin' : 'device';
    const existingPeers = this.ctx.getWebSockets(peerRole);
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
    if (role) {
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
    if (role) {
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

  /** Send a message to the peer (the other role) */
  private notifyPeer(senderRole: ClientRole, message: ServerMessage): void {
    const peerRole: ClientRole = senderRole === 'device' ? 'admin' : 'device';
    const peers = this.ctx.getWebSockets(peerRole);
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
  private async registryAnswered(roomId: string): Promise<void> {
    if (!roomId) return;
    try {
      const id = this.env.ROOM_REGISTRY.idFromName('registry');
      const stub = this.env.ROOM_REGISTRY.get(id);
      await stub.fetch(`https://registry/rooms/${roomId}/answered`, { method: 'POST' });
    } catch {
      // Registry への通知失敗は無視
    }
  }

  /** Call the RoomRegistry HTTP API */
  private async registryRequest(method: 'PUT' | 'DELETE', roomId: string): Promise<void> {
    if (!roomId) return;
    // インスタンス変数キャッシュ + DO永続ストレージの両方に保存
    (this as unknown as { _roomId?: string })._roomId = roomId;
    if (method === 'PUT') {
      await this.ctx.storage.put('roomId', roomId);
    }
    try {
      const id = this.env.ROOM_REGISTRY.idFromName('registry');
      const stub = this.env.ROOM_REGISTRY.get(id);
      await stub.fetch(`https://registry/rooms/${roomId}`, { method });
    } catch {
      // Registry への通知失敗は無視 (RTC 接続には影響しない)
    }
  }
}
