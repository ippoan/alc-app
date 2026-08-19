---
name: alc-app-map
generated-from: alc-app:b4aacaa1cf9ef811f73759a90e3732c00093fc8c
paths: [web/, cf-alc-signaling/, cf-alc-recorder/]
description: yhonda-ohishi-alc/alc-app (業務用アルコールチェッカーシステム / 複合 repo) の構造ナビゲーション。タニタ FC-1200 + NFC + 顔認証による本人確認付きアルコール測定 + 遠隔点呼。web/ (Nuxt 4 PWA on Workers)・cf-alc-signaling/ (WebRTC signaling DO)・cf-alc-recorder/ (CoreS3 測定データ受口 DO)・fc1200-wasm (秘匿) の区画、WebSerial/WebRTC/顔認証の composable 配置、秘匿ファイル・テストの gotcha を 1 枚にまとめる。トリガー:「alc-app」「アルコールチェッカー」「FC-1200」「fc1200」「点呼」「遠隔点呼」「顔認証」「NFC bridge」「WebRTC signaling」「cf-alc-signaling」「cf-alc-recorder」「alc-recorder」「CoreS3 測定」「alc.ippoan.org」等。
---

# alc-app-map — yhonda-ohishi-alc/alc-app 構造ナビゲーション

業務用アルコール検知システム。タニタ FC-1200 (RS232C) + NFC + 顔認証 (@vladmandic/human)
による本人確認付き測定 + 運転者⇔運行管理者の遠隔点呼 (WebRTC)。**複合 repo**: フロント
(Nuxt 4 PWA) と signaling worker と WASM が 1 repo に同居 (public repo)。

> ここは索引。細部 (関数シグネチャ・行) は repo 側が正。
> frontmatter の `generated-from` が現在の tree-sha とズレたら
> session-start-skill-coverage hook が再生成を促す → tree-sha を更新する。

## トップレベル区画

| 区画 | 中身 | 役割 |
|---|---|---|
| **`web/`** | Nuxt 4 PWA (`app/` 構成) + `server/` + `wrangler.jsonc` | フロント本体 (Cloudflare Workers `cloudflare_module`)。下表参照 |
| **`cf-alc-signaling/`** | `src/{index,signaling-room,room-registry,camera-signaling-room}.ts` + `wrangler.toml` | WebRTC signaling worker。Durable Objects (Hibernatable WS) で SDP/ICE リレー。worker 名 `alc-signaling`。`CameraSignalingRoom` (`/cam-room/:siteId`) は拠点カメラ (C212) 中継用の別系統 DO — `SignalingRoom` と同じ device/admin 1:1 リレーだが `RoomRegistry` (着信通知) を呼ばない (ippoan/alc-app#129) |
| **`cf-alc-recorder/`** | `src/{index,recorder-hub,auth,measurements}.ts` + `wrangler.toml` + `test/` | CoreS3 (alc-app-s3) 測定データ受口 worker (#106/#108)。上りは WS (`/ws`、テナント単位 DO `RecorderHub`) と Wi-Fi 客向け `POST /measurements` バッチ (#109、ステートレス) の 2 経路 — どちらも device JWT introspect (role allowlist: `device-hub` = CoreS3 / `device-print` = AtomS3 印刷ブリッジ ippoan/alc-app-s3#38 / `device-gateway` = P4 GW ippoan/alc-gw-p4#15。他 role は 403) → auth-worker `/alc-internal-proxy` → rust-alc-api `POST /api/hub/measurements` に転送。例外: `kind=crash_log` (CoreS3 異常リセット復帰レポート、ippoan/alc-app-s3#43) は backend へ転送せず R2 `CRASH_LOGS` (bucket `alc-crash-logs`、key `{tenant}/{device}/{seq 12桁0詰}.json`、再送冪等) へ直接保存して ack + メール通知 (`CRASH_EMAIL` send_email binding、best-effort、security-notification-app と同方式)。下り command push は WS のみ。worker 名 `alc-recorder`。**session_id (Refs ippoan/alc-app-s3#112)**: 1 回の点呼を束ねる端末発番の識別子を上り frame / POST body から素通しする。`normalizeSessionId` が字種 (英数字 `-` `_`、64 文字) を検証するが、**外れても測定ごと弾かず null に落とす** — session_id は付加情報で、これを理由に測定を捨てると点呼の記録そのものを失うため (log 1 行を残す)。上流 rust-alc-api は同じ制約で 400 を返すが、あちらは本 worker 以外の経路に対する多層防御 |
| **`fc1200-wasm/`** | (git ignored) Rust → WASM | FC-1200 RS232C プロトコル実装を WASM に compile して**ソース秘匿**。`web` から `fc1200-wasm` import |
| **`docs/`** | mkdocs (`mkdocs.yml`, admin/ operator/) | 運用ドキュメント。`docs/*.pdf` = Tanita Confidential で **.gitignore** |
| **`plan/`** | `implementation-plan.md` `initialplan.md` | 実装計画 |
| **`scripts/`** | `sync-ts-bindings.sh` | rust-alc-api 型同期補助 |
| **`~/rust/rust-nfc-bridge`** `~/rust/rust-alc-api` | **別 repo** (symlink `alc-app` あり) | NFC リーダ→仮想シリアル (Windows) / バックエンド API (Axum + Cloud Run + PG RLS) |

## web/ の区画

| 区画 | 主要ファイル | 役割 |
|---|---|---|
| **pages** | `web/app/pages/{index,tenko,login,register,device-claim,device-approve,maintenance}.vue` + `pages/auth/` | 測定 / 点呼 / 認証 / デバイス登録承認 |
| **composables (デバイス I/O)** | `useFc1200Serial.ts` (WebSerial) `useNfcWebSocket.ts` `useBleGateway.ts` `useSerialDeviceManager.ts` `useCamera.ts` | FC-1200 シリアル / NFC WS / BLE / シリアル管理 / カメラ。`useFc1200Serial.autoConnect` / `useBleGateway.startAutoConnect` は serial ポート 0 件が続くと `ws://127.0.0.1:{9878,9877}` の WS ブリッジ (alc-gw / Android) へ自動フォールバック (#123) |
| **composables (顔認証)** | `useFaceAuth.ts` `useFaceDetection.ts` `useFaceSync.ts` `useFingerprint.ts` | 顔検出 (Web Worker) / 同期 / 指紋 |
| **composables (点呼/通話)** | `useWebRtc.ts` `useTenkoKiosk.ts` `useTenkoAdmin.ts` `useScreenShare.ts` `useVideoRecorder.ts` | WebRTC 通話 / 点呼キオスク / 管理者 / 画面共有 / 録画 |
| **composables (その他)** | `useAuth.ts` `useManagerAuth.ts` `useOfflineSync.ts` `useDemoMode.ts` `useAndroidLandscape.ts` `useNfcBridgeUpdate.ts` `useGwStatus.ts` | 認証 / オフライン同期 / デモ / Android / Windows GW (alc-gw) 疎通診断 (`127.0.0.1:11984` + WS 9876/9877/9878 を使い捨て接続で probe、#124) |
| **components** | `Tenko*.vue` (多数: Kiosk/VideoCall/RemoteAdminView/ScheduleManager 等) `*Dashboard.vue` `FaceAuth.vue` `AlcMeasurement.vue` `Device*.vue` `GwStatusCard.vue` `HubMeasurementsViewer.vue` | 点呼 UI / ダッシュボード / 測定 / デバイス管理 / GW 確認カード (DeviceSettings 内、GW 未検出時は折りたたみ) / ハブ測定値ビューア。**画面は独立ページではなく `AdminDashboard.vue` のタブ** (`hub_measurements` = 「ハブ測定値」、「デバイス管理」の隣) — 管理機能は index.vue のロールタブ → `*Dashboard.vue` 内タブという 2 段構成なので、`pages/` に足しても導線が無い。`HubMeasurementsViewer.vue` は CoreS3 統合ハブ (alc-app-s3) が cf-alc-recorder 経由で 溜めた測定を `GET /api/hub/measurements` (Refs ippoan/rust-alc-api#592) から読む閲覧専用。絞り込みは device_id / kind / 受信日時 (`created_at` の閉区間)、並びは backend 固定の `created_at DESC`。**総件数は API が返さない** (ingest テーブルが伸び続けるため) のでページャは `has_more` + offset だけ。`payload` は JSONB 素通しなので既定は畳む |
| **utils** | `web/app/utils/{api,env,face-approval,face-db,fc1200,human-config,license,offline-queue,video-store}.ts` | API client / 顔 DB (IndexedDB) / FC-1200 / human 設定 / オフラインキュー |
| **worker** | `web/app/workers/face-detect.worker.ts` | 顔検出 Web Worker (@vladmandic/human) |
| **server route** | `web/server/api/{proxy/[...path],tenko-call/{register,tenko},devices/*,github-checksum.get}.ts` | **proxy/** = auth-worker proxy (`createAuthWorkerProxyHandler`、#434 step 3 / 方式 B): cookie/Bearer JWT + X-Alc-Proxy-Secret (=INTERNAL_SHARED_SECRET) を AUTH_WORKER service binding 経由で auth-worker `/alc-proxy/*` に thin-forward。introspect / ACL / OIDC mint / X-Tenant-ID + X-User-* 注入は auth-worker 側に集約 (SA key 排除)。**admin / device JWT を伴う呼び出しは `app/utils/api.ts` の `request()` / `proxyRawFetch` が `/api/proxy` 経由に寄せる (#434 step 3d caller #3、admin 直叩き撤去)**。残る `tenko-call/{register,tenko}` (public) と `devices/*` (FCM token / version / watchdog / claim / **re-pair**、Android 直叩き) は browser JWT 無しのため lockdown 化は caller #5 (Android)。`devices/re-pair.post.ts` は kiosk 端末再認証 (rust-alc-api#495)。管理者側の window 発行 (`authorizeRepair`) はテナント認証付きなので `request()` → `/api/proxy` 経由。NFC bridge checksum |
| **型 (生成)** | `web/app/types/generated/*` (91 file) + `web/app/types/index.ts` | rust-alc-api models.rs から **ts-rs 自動生成** (`Backend` namespace)。手動編集禁止。フロント固有型は index.ts に手動定義 |
| **middleware** | `web/app/middleware/auth.global.ts` | 全ルート認証ガード |

## entrypoint

- **web nitro**: `web/nuxt.config.ts` → `nitro.preset = "cloudflare_module"`、`main = .output/server/index.mjs` (`web/wrangler.jsonc`)。`vite-plugin-wasm` + `optimizeDeps.exclude: ['fc1200-wasm']`。
- **web wrangler (jsonc)**: top-level = prod (`alc-app`, alc.ippoan.org)。`env.staging` = `alc-app-staging` (alc-staging.ippoan.org)。`NUXT_PUBLIC_{API_BASE,GOOGLE_CLIENT_ID,AUTH_WORKER_URL,STAGING_TENANT_ID,SIGNALING_URL}` を env で切替。
- **signaling**: `cf-alc-signaling/src/index.ts` (worker entry) → DO `SignalingRoom` (device/admin 2 ピア間リレー、`/room/:roomId`) + `RoomRegistry` (着信通知) + `CameraSignalingRoom` (拠点カメラ中継、`/cam-room/:siteId`、`RoomRegistry` 非連携、ippoan/alc-app#129)。`wrangler.toml` に migration v1/v2/v3、`BACKEND_API_URL` var。secret 不要 (STUN P2P のみ、TURN 後日)。
- **recorder**: `cf-alc-recorder/src/index.ts` (worker entry)。`/ws` → introspect 後にテナント単位 DO `RecorderHub` (Hibernatable WS、identity は WS attachment) へ routing。`POST /measurements` → DO を経由せず Worker 直で検証 + ingest 転送 (`src/measurements.ts` を WS 経路と共有)。下り `POST /tenants/:t/devices/:d/command` 等は `INTERNAL_SHARED_SECRET` の内部 API。binding: `AUTH_WORKER` (service) + `INTERNAL_SHARED_SECRET` (Secrets Store) + `CRASH_LOGS` (R2、crash_log 保存先) + `CRASH_EMAIL` (send_email、crash メール通知)。prod/staging 2 面 (`env.staging`)。
- **接続**: `NUXT_PUBLIC_SIGNALING_URL` に signaling worker URL。Room ID = `tenko_session_id`。

## gotcha

- **public repo + 秘匿ファイル**: repo は public。`docs/*.pdf` (FC-1200 通信仕様 = Tanita Confidential)・`fc1200-wasm/{src,Cargo.toml,Cargo.lock}` は **.gitignore 済み = 絶対コミットしない** (WASM に compile してプロトコル秘匿)。
- **semver patch のみ**: バージョンアップは常に patch (0.2.1→0.2.2)。minor/major は上げない。
- **WebRTC は Hibernatable WebSockets API 必須** (Durable Objects)。
- **テスト (CLAUDE.md に詳細)**: Vitest 4 + `@nuxt/test-utils` (happy-dom)。fc1200-wasm と `virtual:pwa-register/vue` は `tests/mocks/` でモック (CI に wasm-pack 不要 / Windows での virtual module 解決エラー回避)。ブラウザ API (WebSerial/BLE/NFC) は `Object.defineProperty(navigator, ...)` でモック。**`v8 ignore` 禁止** (`withSetup` / テスト追加 / 到達不能コード削除で対処)。モジュールスコープ状態を持つ composable (`useBleGateway` `useFaceDetection` `useFc1200Serial`) は `vi.resetModules()` + dynamic import で分離。
- **mock/live 統一テスト**: `web/tests/utils/api.test.ts` は 1 ファイルで mock と live (実 rust-alc-api コンテナ) 両対応。`API_BASE_URL` 環境変数の有無で切替。fake ID 禁止 (`api-test-data.ts` の実在 UUID を使う)。`docker-compose.test.yml` で GHCR `rust-alc-api:latest` + PG 起動。
- **型同期**: `cd ~/rust/rust-alc-api && bash scripts/sync-types.sh` → `web/app/types/generated/` に生成 (git 管理、CI で差分チェック)。

## CCoW/CI から見た立ち位置

- rust-alc-api を叩く consumer 群の親玉 (carins / nuxt-trouble / nuxt_dtako_logs の兄弟だが最も大きい)。認証は `@ippoan/auth-client` + auth-worker (auth.ippoan.org)。
- CI: `.github/workflows/{test,tag-release,docs,recorder-deploy,signaling-deploy,skills-check}.yml`。test = `web/**` パス変更時 `npm ci` → `vitest run --coverage` → `check_coverage_100.mjs` → Job Summary/artifact。`recorder-deploy.yml` = cf-alc-recorder の vitest + deploy。`docs.yml` = mkdocs。`coverage_100.toml` で 100% リグレッション検出。
- **main 直 push 禁止** (branch protection)。`gh pr merge --squash --auto` で CI 通過後 auto-merge (`enforce_admins: false`)。
- `.claude/skills/` に repo 固有 skill (`next-session` `resume-session`) あり。`.githooks/` も。

## 関連 skill

- `auth-worker-map` — `@ippoan/auth-client` の発行元
- `nuxt-pwa-carins-map` / `nuxt-trouble-map` / `nuxt_dtako_logs-map` — 同じ rust-alc-api consumer の兄弟
- `type-safe-pipeline` — ts-rs 型同期パイプライン (generated/ の生成元)
- `nuxt-vitest` / `worker-vitest` — Nuxt 4 / Workers 向け Vitest テスト
- `repo-map` / `cross-repo-symbol-index` — この map の運用方針 (generated-from 鮮度)

## CLAUDE.md から移設 (2026-07-06)

> 以下は CLAUDE.md ダイエット (Refs #87) で骨格化した際に元 CLAUDE.md から verbatim 移設した詳細。

### プロジェクト構成

| フォルダ | 説明 | リポジトリ |
|---------|------|----------|
| `web/` | Nuxt 4 PWA フロントエンド (Cloudflare Workers) | このリポジトリ |
| `fc1200-wasm/` | FC-1200 RS232C プロトコル WASM (ソース秘匿) | このリポジトリ |
| `cf-alc-signaling/` | WebRTC シグナリング (Cloudflare Durable Objects + Hibernatable WS) | このリポジトリ |
| `cf-alc-recorder/` | CoreS3 測定データ受口 (WS + POST バッチ → rust-alc-api 転送) | このリポジトリ |
| `~/rust/rust-nfc-bridge/` | NFC リーダー → 仮想シリアルポート (Windows) | 別リポジトリ (symlink: alc-app) |
| `~/rust/rust-alc-api/` | バックエンド API (GCP Cloud Run + PostgreSQL RLS) | 別リポジトリ (symlink: alc-app) |
| `plan/` | 実装計画ドキュメント | このリポジトリ |
| `docs/` | 仕様書 (FC-1200 RS232C 通信フロー等) | このリポジトリ |

### 技術スタック

- **フロントエンド**: Nuxt 4, Tailwind CSS, @vladmandic/human, WebSerial API, WebRTC
- **FC-1200 プロトコル**: Rust → WASM (wasm-pack, wasm-bindgen)
- **シグナリング**: Cloudflare Workers + Durable Objects (Hibernatable WebSockets)
- **NFC ブリッジ**: Rust (tokio, serialport)
- **バックエンド API**: Rust (Axum), GCP Cloud Run
- **データベース**: PostgreSQL + Row Level Security
- **ストレージ**: Cloudflare R2 (顔写真)

### デプロイ

- **web (Cloudflare Workers)**: 通常運用は **CI 経由** (auth-worker / ippoan 標準と統一、#33)。
  - PR → main: `test.yml` (frontend-ci.yml) の `deploy-staging` が staging に自動 deploy
    - URL: https://alc-staging.ippoan.org (custom domain) / alc-app-staging.m-tama-ramu.workers.dev
  - `v*` tag push: `deploy-release` が **no-traffic upload** (`wrangler versions upload`) → Release Wave / `wrangler versions deploy <id>@100%` で明示 flip
    - URL: https://alc.ippoan.org (custom domain) / alc-app.m-tama-ramu.workers.dev
  - 緊急時 fallback (手動): `cd web && npm run deploy` (= `nuxt build && wrangler deploy`)
- **cf-alc-signaling (Cloudflare Workers)**: `cd cf-alc-signaling && wrangler deploy`
  - URL: https://alc-signaling.ippoan.org (custom domain) / alc-signaling.m-tama-ramu.workers.dev
  - シークレット不要 (STUN P2P のみ。TURN は後日対応予定)。cam-room admin 接続の JWT 検証用に
    AUTH_WORKER service binding + INTERNAL_SHARED_SECRET (既存 Secrets Store 共有) を追加済み
- **cf-alc-recorder (Cloudflare Workers)**: CI 経由 (`recorder-deploy.yml`: `npx vitest run` → staging / release deploy)。手動 fallback: `cd cf-alc-recorder && wrangler deploy`
- **rust-alc-api (GCP Cloud Run)**: 別リポジトリで管理
- **rust-nfc-bridge**: `v*` タグ push で GitHub Actions が自動リリース (Windows ビルド + MSI 作成 + GitHub Release にアップロード)
  - 手順: `Cargo.toml` の version を上げる → commit & push → `gh release create v0.x.x` → Actions が MSI を追加

### 遠隔点呼 WebRTC (2026-03-04 実装)

運転者キオスク ↔ 運行管理者間の P2P ビデオ通話。STUN のみ (TURN は後日)。

| ファイル | 役割 |
|---------|------|
| `web/app/components/TenkoVideoCall.vue` | PiP ビデオ通話 UI (ミュート・カメラOFF ボタン、接続状態バッジ) |
| `web/app/components/TenkoKiosk.vue` | `remoteMode` prop → セッション開始後 WebRTC 接続 + ビデオオーバーレイ |
| `web/app/components/TenkoRemoteAdminView.vue` | 管理者側: アクティブセッション一覧 + クリックで通話開始 |
| `web/app/pages/index.vue` | 「遠隔点呼」タブ追加 (`?tab=remote`) |
| `web/app/pages/dashboard.vue` | 点呼管理グループに「遠隔点呼」タブ追加 |
| `web/app/composables/useWebRtc.ts` | `connect(signalingUrl, roomId)` — Room ID = tenko_session_id |
| `cf-alc-signaling/src/signaling-room.ts` | Durable Object: device/admin 2ピア間で SDP/ICE をリレー |

**接続フロー**: `nuxt.config.ts` の `NUXT_PUBLIC_SIGNALING_URL` に signaling Worker URL を設定。

### テスト

#### テスト実行

```bash
npm test                # 全テスト (vitest run)
npm run test:watch      # ウォッチモード
npm run test:coverage   # カバレッジ付き
node scripts/check_coverage_100.mjs  # 100% リグレッション検出
```

#### テスト環境

- **フレームワーク**: Vitest 4 + `@nuxt/test-utils` (Nuxt 環境)
- **DOM**: happy-dom (`@nuxt/test-utils` 経由)
- **IndexedDB**: `fake-indexeddb`
- **fc1200-wasm**: `tests/mocks/fc1200-wasm.ts` でモック (CI に wasm-pack 不要)
- `import.meta.client` は `@nuxt/test-utils` が自動で `true` に設定
- Nuxt auto-import (`useRoute`, `useState`, `ref` 等) も自動解決

#### カバレッジ

- **Provider**: `@vitest/coverage-v8`
- **100% 達成ファイル**: `coverage_100.toml` で管理、CI でリグレッション検出
- **レポート**: `web/coverage/` (`.gitignore` 済み)

#### テストパターン

- **pure utils**: モック不要、直接テスト (`license.ts`, `face-approval.ts`)
- **composables**: `vi.mock('~/utils/api')` で API モック
- **ブラウザ API** (WebSerial, BLE, NFC): `Object.defineProperty(navigator, 'serial', { value: {...}, configurable: true })` でモック。`delete (navigator as any).serial` で削除
- **Android bridge**: `(window as any).Android = { ... }` でモック
- **Nuxt auto-import のモック**: `mockNuxtImport('useRoute', () => mockFn)` (`@nuxt/test-utils/runtime`)
- **useState 共有ステート**: `beforeEach` でリセットすること (テスト間で値が共有される)
- **onMounted テスト**: `withSetup(() => useMyComposable())` ヘルパーで Vue コンポーネントコンテキストを作成 → `onMounted` / `onUnmounted` が発火する (`tests/helpers/with-setup.ts`)
- **`v8 ignore` 禁止** — 未カバーコードは `withSetup` / テスト追加 / 到達不能コード削除で対処。SSR ガード (`if (import.meta.client)`) は `onMounted` 内に移すか削除 (`onMounted` 自体が SSR で実行されない)
- **到達不能ブランチ**: `if (!db.objectStoreNames.contains(...))` のような初回のみ通るガードは、条件分岐を消して常に実行する形にリファクタ

#### モジュールスコープ状態のテスト分離

composable がモジュールスコープに `ref`, `let` 変数を持つ場合 (シングルトンパターン)、テスト間で状態がリークする。

**対策: `vi.resetModules()` + dynamic import**
```ts
let useBleGateway: typeof import('~/composables/useBleGateway').useBleGateway

beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules()
  const mod = await import('~/composables/useBleGateway')
  useBleGateway = mod.useBleGateway
})
```

**該当ファイル**: `useBleGateway`, `useFaceDetection`, `useFc1200Serial` (モジュールスコープに `ref`/`let` あり)

#### async composable テスト (Worker / WebSocket)

`detect()` 等の async 関数内で `await createImageBitmap()` 後に `worker.postMessage` が呼ばれる場合、テスト側で **await tick** を挟んでからアサートする:

```ts
const detectPromise = fd.detect(video)
await new Promise(r => setTimeout(r, 0))  // createImageBitmap の await を通す
expect(w.postMessage).toHaveBeenLastCalledWith(...)
w.simulateMessage({ type: 'result-lite', face: [], gesture: {} })
await detectPromise
```

#### vi.useFakeTimers の注意

- happy-dom 環境では `vi.useFakeTimers()` が `navigator` や `WebSocket` と干渉する場合がある
- **必ず `toFake` オプション**で必要なタイマーだけ指定: `vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })`
- `afterEach` で必ず `vi.useRealTimers()` を呼ぶ
- async 関数 + fake timers の組み合わせはタイムアウトしやすい (reconnect ループ等)

#### disconnectWebSocket バグパターン

`ws.close()` は MockWebSocket で同期的に `onclose` を呼ぶ。`onclose` 内で `transport.value = null` が設定されるため、`ws.close()` **後**に `if (transport.value === 'websocket')` をチェックすると false になる。**チェックを `ws.close()` 前に行う**こと。

#### 型同期 (ts-rs)

Rust バックエンドの models.rs → TypeScript 型を自動生成:
```bash
cd ~/rust/rust-alc-api
bash scripts/sync-types.sh
# → web/app/types/generated/ に 91 ファイル生成
```

- `types/generated/` は git 管理 (CI で差分チェック可能)
- `types/index.ts` から `Backend` namespace で参照: `import { Backend } from '~/types'`
- フロント固有型 (`FaceAuthResult`, `Fc1200State` 等) は `types/index.ts` に手動定義

#### API テスト共通化方針 (mock / live 両対応)

`tests/utils/api.test.ts` は **1つのテストコードで mock と live (実 API コンテナ) の両方で動く**設計。

**原則**:
- テストデータは `tests/helpers/api-test-data.ts` に一元管理。スキーマ変更時はここだけ修正
- `tests/helpers/api-test-env.ts` で mock/live 切り替え (`API_BASE_URL` 環境変数の有無で判定)
- `stubOk(data)` / `stub204()` / `stubResponse(res)`: mock 時は mockFetch にセット、live 時は no-op
- `assertMock(() => { ... })`: mock 専用アサーション (mockFetch.mock.calls 検証等)。live 時は skip
- テストに渡す ID は実在する UUID (`api-test-data.ts` の `TEST_EMPLOYEE_ID` 等)。`'s1'`, `'e1'` のような fake ID は禁止 (live で 400 になる)
- リクエストボディは実 API が受け付ける正しいフィールド名・値を使う (`api-test-data.ts` から import)
- テストファイルを mock 用 / live 用に分けない。1ファイルで完結させる
- `api-live.test.ts` のような別ファイルは作らない

**実行方法**:
```bash
npm test                                          # mock モード (DB 不要、高速)
docker compose -f docker-compose.test.yml up -d   # API + DB コンテナ起動
API_BASE_URL=http://localhost:18080 npm test       # live モード (実 API)
docker compose -f docker-compose.test.yml down -v  # コンテナ停止
```

**コンテナ**: `docker-compose.test.yml` で GHCR の `rust-alc-api:latest` + PostgreSQL を起動。seed データは `tests/fixtures/seed.sql`。

#### CI

- **GitHub Actions**: `.github/workflows/test.yml`
  - `npm ci` → `vitest run --coverage` → `check_coverage_100.mjs` → Job Summary → artifact
  - fc1200-wasm は CI でスタブ化 (ダミー package.json + index.js)
  - トリガー: push/PR to main (`web/**` パス変更時)
  - **Job Summary**: テスト結果 + カバレッジ表 + 100% 未達ファイル一覧 (折りたたみ)

#### ブランチワークフロー

**main に直接 push 禁止。** ブランチ保護ルール設定済み。

- **CI 必須**: `Vitest + Coverage` 通過しないと merge 不可
- **strict mode**: main 更新時はブランチの再テスト必要
- **auto-merge**: `gh pr merge --squash --auto` で CI 通過後に自動マージ
- **管理者バイパス**: `enforce_admins: false` (緊急時は可能)

```bash
# 基本フロー
git checkout -b feat/xxx
# ... 変更 ...
git push -u origin feat/xxx
gh pr create --title "タイトル" --body "説明"
gh pr merge --squash --auto
# CI 通過後に自動マージ
```
