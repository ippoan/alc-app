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
  /** proto=2 の device → DO で宛先の viewer を指す */
  viewer_id?: string;
}

/** 接続の属性。WS の attachment に持つ (hibernation から復帰しても残る)。 */
interface PeerAttachment {
  /** device: 宣言した proto (2 = 複数 viewer)。無ければ v1 */
  proto?: number;
  /** admin: DO が発行した viewer_id (proto=2 の部屋でだけ使う) */
  viewerId?: string;
  /** admin: v1 の device が入って切られた。close の完了までの間、居ないものとして扱う。 */
  kicked?: true;
}

/** proto=2 の部屋で同時に受け入れる admin (viewer) の上限。上り帯域 = 人数 × stream2 のため。 */
export const MAX_VIEWERS = 4;

/** v1 の device が入って、2 本目以降の admin を切るときの close code。 */
const CLOSE_V1_SINGLE_VIEWER = 4009;

interface ServerMessage {
  type: 'sdp_offer' | 'sdp_answer' | 'ice_candidate' | 'peer_joined' | 'peer_left' | 'error' | 'pong';
  sdp?: string;
  candidate?: IceCandidate;
  role?: ClientRole;
  message?: string;
  viewer_id?: string;
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

    // device が居ない部屋と proto=2 の device の部屋は admin 複数 (上限 MAX_VIEWERS)。
    // proto 無し (v1) の device が居る部屋だけ 1ルーム = device 1本 + admin 1本
    const v1Device = this.liveSockets('device').some(d => this.getAttachment(d).proto !== 2);
    const existing = this.liveSockets(role);
    if (role === 'admin' && !v1Device) {
      if (existing.length >= MAX_VIEWERS) {
        return new Response('viewer limit', { status: 409 });
      }
    } else if (existing.length > 0) {
      return new Response(`Role "${role}" is already connected to this room`, { status: 409 });
    }

    const attachment: PeerAttachment = {};
    if (role === 'device' && url.searchParams.get('proto') === '2') attachment.proto = 2;
    if (role === 'admin') attachment.viewerId = crypto.randomUUID();

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [role]);
    pair[1].serializeAttachment(attachment);

    if (role === 'device') {
      let admins = this.liveSockets('admin');
      if (attachment.proto !== 2 && admins.length > 1) {
        // v1 の device は viewer を 1 人しか扱えない。最初に入った 1 本だけ残して他は切る
        for (const extra of admins.slice(1)) {
          extra.serializeAttachment({ ...this.getAttachment(extra), kicked: true } satisfies PeerAttachment);
          try {
            extra.close(CLOSE_V1_SINGLE_VIEWER, 'v1 device: single viewer');
          } catch {
            // WebSocket already closed
          }
        }
        admins = admins.slice(0, 1);
      }
      for (const admin of admins) {
        // device より前の接続は viewer_id を持たないことがあるので、ここで発行する
        const att = this.getAttachment(admin);
        const viewerId = att.viewerId ?? crypto.randomUUID();
        if (!att.viewerId) admin.serializeAttachment({ ...att, viewerId } satisfies PeerAttachment);
        this.send(admin, { type: 'peer_joined', role: 'device' });
        this.send(pair[1], {
          type: 'peer_joined',
          role: 'admin',
          ...(attachment.proto === 2 ? { viewer_id: viewerId } : {}),
        });
      }
    } else {
      // 新しい viewer を device に知らせ、device が居れば admin 側にも伝える
      this.toDevices({ type: 'peer_joined', role }, attachment.viewerId);
      if (this.liveSockets('device').length > 0) {
        this.send(pair[1], { type: 'peer_joined', role: 'device' });
      }
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

    if (this.getAttachment(ws).kicked) return;

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
        if (this.isMultiViewerRoom()) {
          this.relayToViewer(data.viewer_id, { type: 'sdp_offer', sdp: data.sdp });
        } else {
          this.notifyPeer(senderRole, { type: 'sdp_offer', sdp: data.sdp });
        }
        break;

      case 'sdp_answer':
        if (senderRole !== 'admin') {
          this.send(ws, { type: 'error', message: 'Only admin can send sdp_answer' });
          return;
        }
        this.notifyPeer(senderRole, { type: 'sdp_answer', sdp: data.sdp }, ws);
        break;

      case 'ice_candidate':
        // trickle ICE を使うクライアント向け (任意)。alc-gw-p4 は non-trickle
        // 運用の想定でこのメッセージ種別を送らない (Refs #129 の設計判断)
        if (senderRole === 'device' && this.isMultiViewerRoom()) {
          this.relayToViewer(data.viewer_id, { type: 'ice_candidate', candidate: data.candidate });
        } else {
          this.notifyPeer(senderRole, { type: 'ice_candidate', candidate: data.candidate }, ws);
        }
        break;

      case 'ping':
        this.send(ws, { type: 'pong' });
        break;

      default:
        this.send(ws, { type: 'error', message: `Unknown message type: ${(data as { type: string }).type}` });
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string): Promise<void> {
    // ws は runtime 側で既に close 済み (このハンドラが呼ばれる契機そのもの)。
    // 再度 ws.close() を呼ぶと、abrupt disconnect (ページリロード等) で
    // client 側が返す予約コード (1005 "No Status Received" 等) をそのまま
    // 渡すことになり InvalidAccessError で例外になる。例外になると DO 側の
    // タグ解除が完了せず、再接続が「role already connected」(409) で
    // 弾かれ続けるゾンビ状態になっていた。
    this.notifyLeft(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.notifyLeft(ws);
  }

  private notifyLeft(ws: WebSocket): void {
    const role = this.getRole(ws);
    // 切られた admin は device に peer_joined を出していないので、peer_left も出さない
    if (!role || this.getAttachment(ws).kicked) return;
    if (role === 'admin') {
      this.toDevices({ type: 'peer_left', role }, this.getAttachment(ws).viewerId);
    } else {
      this.notifyPeer(role, { type: 'peer_left', role });
    }
  }

  /** その role の接続のうち、切られていないもの。 */
  private liveSockets(role: ClientRole): WebSocket[] {
    return this.ctx.getWebSockets(role).filter(ws => !this.getAttachment(ws).kicked);
  }

  /** admin 発の通知を device へ送る。proto=2 の device にだけ viewer_id を付ける。 */
  private toDevices(message: ServerMessage, viewerId: string | undefined): void {
    for (const device of this.liveSockets('device')) {
      const v2 = this.getAttachment(device).proto === 2 && viewerId;
      this.send(device, v2 ? { ...message, viewer_id: viewerId } : message);
    }
  }

  private getAttachment(ws: WebSocket): PeerAttachment {
    return (ws.deserializeAttachment() as PeerAttachment | null) ?? {};
  }

  /** proto=2 を宣言した device が居る部屋か (admin 複数を受け入れる部屋)。 */
  private isMultiViewerRoom(): boolean {
    return this.liveSockets('device').some(d => this.getAttachment(d).proto === 2);
  }

  /** device → 指定 viewer の admin だけへ中継する。未知の viewer_id は捨てる。 */
  private relayToViewer(viewerId: string | undefined, message: ServerMessage): void {
    if (!viewerId) return;
    for (const admin of this.liveSockets('admin')) {
      if (this.getAttachment(admin).viewerId === viewerId) this.send(admin, message);
    }
  }

  private getRole(ws: WebSocket): ClientRole | null {
    const tags = this.ctx.getTags(ws);
    if (tags.includes('device')) return 'device';
    if (tags.includes('admin')) return 'admin';
    return null;
  }

  /** 相手役の全員へ送る。sender (admin) を渡すと、proto=2 の device には送り主の viewer_id を付ける。 */
  private notifyPeer(senderRole: ClientRole, message: ServerMessage, sender?: WebSocket): void {
    if (senderRole === 'admin') {
      this.toDevices(message, sender ? this.getAttachment(sender).viewerId : undefined);
      return;
    }
    for (const peer of this.liveSockets('admin')) {
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
