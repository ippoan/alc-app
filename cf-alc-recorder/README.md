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
| `POST /tenants/:tenantId/devices/:deviceId/command` | 接続中デバイスへの下り push (`{ id?, payload }` → 202 `{ id, delivered }` / 未接続 404) |
| `GET /tenants/:tenantId/devices` | 接続中デバイス一覧 (debug) |
| `GET /tenants/:tenantId/commands/:id/result` | `command_result` の取得 (未着 404、保持 10 分) |

下り 3 endpoint は `Authorization: <INTERNAL_SHARED_SECRET>` (生の値、Bearer prefix
なし) の server-to-server 認証 (auth-worker `/auth/introspect` と同方式・定数時間比較)。

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

## 開発

```sh
npm install
npm run typecheck
npm test          # @cloudflare/vitest-pool-workers (introspect モックは test/mocks/auth-worker.mjs)
```

## デプロイ

CI (`.github/workflows/recorder-deploy.yml`) 経由:
main push → staging (`alc-recorder-staging`、auth-worker-staging に binding)、
`v*` tag push → production (`alc-recorder`)。

依存: rust-alc-api の受け口 (ippoan/rust-alc-api#564)、auth-worker の `device-hub`
role + `/alc-internal-proxy` allowlist (ippoan/auth-worker#363)。
