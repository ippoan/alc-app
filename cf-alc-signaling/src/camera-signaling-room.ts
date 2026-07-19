import { DurableObject } from 'cloudflare:workers';

// 拠点カメラ (C212) の全景映像を管理者へ中継するための signaling room。
// SignalingRoom (遠隔点呼用) と同じ device/admin 1:1 リレーだが、こちらは
// RoomRegistry (着信通知・スケジュールフィルタ・FCM連携) を一切呼ばない —
// device が接続するたびに全監視端末へ着信を誤発火させないため、意図的に
// 別クラスとして分離している (ippoan/alc-app#129)。
//
// device (P4 / alc-gw) は起動時に一度だけ接続し、以後は 1s→60s backoff で
// 繋ぎっぱなしにする想定 (「常時接続」)。admin が接続してきた時点で SDP
// offer/answer/ICE candidate をこのチャネル越しに中継し、確立後は DO を
// 経由しない直接 P2P (STUN のみ) に移行する。

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

export class CameraSignalingRoom extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get('role') as ClientRole;

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    if (role !== 'device' && role !== 'admin') {
      return new Response('Missing or invalid role query param. Use ?role=device or ?role=admin', {
        status: 400,
      });
    }

    // 同じ role が既に接続中なら拒否 (1ルーム = device 1本 + admin 1本)
    const existing = this.ctx.getWebSockets(role);
    if (existing.length > 0) {
      return new Response(`Role "${role}" is already connected to this room`, { status: 409 });
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [role]);

    // 新規参加を相手役に通知
    this.notifyPeer(role, { type: 'peer_joined', role });

    // 相手役が既に接続済みなら、今接続した側にもそれを伝える
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
        if (senderRole !== 'device') {
          this.send(ws, { type: 'error', message: 'Only device can send sdp_offer' });
          return;
        }
        this.notifyPeer(senderRole, { type: 'sdp_offer', sdp: data.sdp });
        break;

      case 'sdp_answer':
        if (senderRole !== 'admin') {
          this.send(ws, { type: 'error', message: 'Only admin can send sdp_answer' });
          return;
        }
        this.notifyPeer(senderRole, { type: 'sdp_answer', sdp: data.sdp });
        break;

      case 'ice_candidate':
        // trickle ICE を使うクライアント向け (任意)。alc-gw-p4 は non-trickle
        // 運用の想定でこのメッセージ種別を送らない (Refs #129 の設計判断)
        this.notifyPeer(senderRole, { type: 'ice_candidate', candidate: data.candidate });
        break;

      case 'ping':
        this.send(ws, { type: 'pong' });
        break;

      default:
        this.send(ws, { type: 'error', message: `Unknown message type: ${(data as { type: string }).type}` });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const role = this.getRole(ws);
    if (role) {
      this.notifyPeer(role, { type: 'peer_left', role });
    }
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const role = this.getRole(ws);
    if (role) {
      this.notifyPeer(role, { type: 'peer_left', role });
    }
    ws.close(1011, 'WebSocket error');
  }

  private getRole(ws: WebSocket): ClientRole | null {
    const tags = this.ctx.getTags(ws);
    if (tags.includes('device')) return 'device';
    if (tags.includes('admin')) return 'admin';
    return null;
  }

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
}
