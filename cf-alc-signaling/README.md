# cf-alc-signaling

Cloudflare Durable Objects による WebRTC シグナリングサーバー。
測定端末と管理者ダッシュボード間のリアルタイム映像中継を行う。

## 技術スタック

- Cloudflare Workers + Durable Objects
- Hibernatable WebSockets API (必須)
- TypeScript

## 仕組み

1. 測定端末が DO ルームに WebSocket 接続 → SDP Offer 送信
2. 管理者ダッシュボードが同じルームに接続 → SDP Answer 返信
3. ICE Candidate を相互交換 → P2P 映像ストリーム確立
4. シグナリング完了後、DO は自動的に hibernate → コスト発生なし

## API

### `GET /health`
ヘルスチェック。`ok` を返す。

### `GET /room/:roomId?role=device|admin` (WebSocket)
シグナリングルームに WebSocket 接続。

- `role=device` — 測定端末 (SDP Offer 送信側)
- `role=admin` — 管理者ダッシュボード (SDP Answer 送信側)

### dev端末の区別 (任意の `token`)

`/room/:roomId`・`/watch-rooms`・`GET /active-rooms` は任意の query `token` を受ける
(Refs ippoan/alc-app#387)。

- `token` が無い — dev でない接続として従来どおりに動く。
- `token` がある — auth-worker `/auth/introspect` で検証し、応答の `dev_device === true`
  のときだけ dev端末として扱う。**検証に落ちたら `401 Unauthorized` で拒否する**
  (dev でない側に倒さない)。
- dev の device が入った部屋は、dev の購読者 (`/watch-rooms`・`/active-rooms`) にだけ見え、
  着信通知 (FCM) にも載らない。dev でない購読者には dev でない部屋だけが見える。
- dev の device が入った部屋に dev でない admin が入ろうとすると `403`。admin が先に居る
  部屋に dev の device が入ると、dev でない admin は close code `1008` で切られる。

### メッセージプロトコル

```jsonc
// Device → Server → Admin
{ "type": "sdp_offer", "sdp": "v=0..." }

// Admin → Server → Device
{ "type": "sdp_answer", "sdp": "v=0..." }

// 双方向
{ "type": "ice_candidate", "candidate": { "candidate": "...", "sdpMid": "0", "sdpMLineIndex": 0 } }

// Keep-alive
{ "type": "ping" }  →  { "type": "pong" }

// サーバー通知
{ "type": "peer_joined", "role": "device|admin" }
{ "type": "peer_left", "role": "device|admin" }
{ "type": "error", "message": "..." }
```

## 開発

```bash
npm install
npm run dev     # localhost:8787
```

## デプロイ

```bash
npm run deploy
```
