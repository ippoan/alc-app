# cf-alc-recorder

alc-app-s3 (M5Stack CoreS3 ハブ) の測定データを WebSocket で受けて rust-alc-api に
記録する Cloudflare Worker (Durable Objects + Hibernatable WebSockets)。
cf-alc-signaling の兄弟 Worker (Refs ippoan/alc-app#106)。

```
CoreS3 →(WSS + device JWT)→ cf-alc-recorder →(AUTH_WORKER service binding)→
  auth-worker /alc-internal-proxy →(OIDC + X-Internal-Shared-Secret + X-Tenant-ID)→
    rust-alc-api POST /api/hub/measurements
```

- 接続認証: WSS ハンドシェイクの `Authorization: Bearer <device JWT>` を auth-worker
  `POST /auth/introspect` で検証する。`device-hub` role のみ accept
  (kiosk / uploader 等の他 role は 403、期限切れ・署名不正・ACL 不許可テナントは 401)。
- tenant_id / device_id は introspect 済み JWT claims (tenant_id / sub) から注入する。
  **ペイロード内の値は信用しない**。
- Durable Object (`RecorderHub`) はテナント単位 (`idFromName(tenant_id)`)。identity は
  WS attachment に永続化し、hibernation 復帰後も `deserializeAttachment()` から読む。

## エンドポイント

| method/path | 用途 |
|---|---|
| `GET /health` | 死活確認 |
| `GET /ws` | WS 受口 (`Upgrade: websocket` + `Authorization: Bearer <device JWT>`) |
| `GET /watch-timecard` | 打刻更新の購読 WS (読み取り専用)。トークンは `Sec-WebSocket-Protocol: alc.timecard.v1, <jwt>`。受信は `{"type":"timecard_punch"}` の**合図だけ** — 行の中身は送らないので、ブラウザは `GET /api/timecard/punches` を引き直す |
| `POST /tenants/:tenantId/devices/:deviceId/timecard-punch` | ブラウザ (キオスク / 管理画面) の打刻 (`{ card_id }` → 202 `{ seq }`)。**`kind` と `seq` はサーバが立てる** — クライアントには指定させない |
| `POST /tenants/:tenantId/devices/:deviceId/command` | 接続中デバイスへの下り push (`{ id?, payload }` → 202 `{ id, delivered }` / 未接続 404) |
| `GET /tenants/:tenantId/devices` | 接続中デバイス一覧 (debug) |
| `GET /tenants/:tenantId/commands/:id/result` | `command_result` の取得 (未着 404、保持 10 分) |

`/tenants/...` の endpoint は `Authorization: <INTERNAL_SHARED_SECRET>` (生の値、
Bearer prefix なし) の server-to-server 認証 (auth-worker `/auth/introspect` と
同方式・定数時間比較)。呼び手は alc-app の server route など Worker 側に限られる。

**ブラウザ打刻をこの Worker に通すのは、購読者への合図を 1 か所に保つため**
(Refs ippoan/alc-app-s3#134)。rust-alc-api に直行させると、端末で打った時だけ
`/watch-timecard` が鳴り、ブラウザで打った時は鳴らない、という経路依存の挙動になる。
alc-app 側の入口は同一オリジンの server route (`POST /api/timecard/punch`) で、
そこが browser/kiosk JWT を introspect して `tenant_id` / `device_id` を決める。

## WS プロトコル

上り (CoreS3 → server):

```jsonc
{ "type": "measurement", "seq": 1, "recorded_at_ms": 1752300000000,
  "kind": "alcohol", "payload": { /* ble-medical-gateway 互換 JSON */ } }
// → { "type": "ack", "seq": 1 }  (失敗時 { "type": "error", "seq": 1, "message": "upstream_502" })
//   kind 省略時は payload.type に fallback (temperature / blood_pressure)。
//   再送は同じ seq のまま行う (rust 側 UNIQUE (tenant_id, device_id, seq) で冪等)。

{ "type": "command_result", "id": "<command id>", "payload": { } }
{ "type": "ping" }   // → { "type": "pong" } (`{"type":"ping"}` 完全一致なら hibernation を起こさず auto-response)
```

下り (server → CoreS3):

```jsonc
{ "type": "connected" }                                  // accept 直後
{ "type": "command", "id": "<uuid>", "payload": { } }    // MEASURE 指示 / timecard イベント / 設定変更
```

## バッテリー snapshot cron (Refs #121)

CoreS3 の電源/バッテリー状態 (`/device/setup` の手動照会と同じ WS command
`{action:"battery"}` → `command_result`) を 30 分おきに自動取得し R2
(`BATTERY_HISTORY`) へ保存する。対象 device (tenant_id/device_id) は
auth-worker `GET /internal/hub-devices` から取得する — 本 worker は tenant/device
の registry を持たない。未接続デバイス・応答 timeout は silent skip (best-effort、
次周期に譲る)。rust-alc-api hub_measurements は使わない (診断値であって測定データ
ではないため、crash_log と同じ R2 直接保存)。

保存先の key は `{tenant_id}/{device_id}/{取得時刻ms}.json`。**7日で自動削除**する
Object Lifecycle Rule はコードでは制御できないバケット側の運用設定 — 初回 deploy
前に手動で以下を実行すること:

```sh
npx wrangler r2 bucket create alc-battery-history
npx wrangler r2 bucket lifecycle add alc-battery-history --expire-days 7
```

## 開発

```sh
npm install
npm run typecheck
npm test          # @cloudflare/vitest-pool-workers (introspect モックは test/mocks/auth-worker.mjs)
```

## デプロイ

CI (`.github/workflows/recorder-deploy.yml`) 経由:
main push → staging (`alc-recorder-staging`、auth-worker-staging に binding)、
`v*` tag push → production (`alc-recorder`)。cron ([triggers]) は prod のみ
(staging に実機フリートは無い)。

依存: rust-alc-api の受け口 (ippoan/rust-alc-api#564)、auth-worker の `device-hub`
role + `/alc-internal-proxy` allowlist (ippoan/auth-worker#363)、
`GET /internal/hub-devices` (ippoan/auth-worker#401)。
