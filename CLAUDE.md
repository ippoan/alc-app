# alc-app - アルコールチェッカーシステム

業務用アルコール検知システム。タニタ FC-1200 + NFC + 顔認証による本人確認付きアルコール測定。

**リポジトリ**: https://github.com/yhonda-ohishi-alc/alc-app (public)

## プロジェクト構成

| フォルダ | 説明 | リポジトリ |
|---------|------|----------|
| `web/` | Nuxt 4 PWA フロントエンド (Cloudflare Workers) | このリポジトリ |
| `fc1200-wasm/` | FC-1200 RS232C プロトコル WASM (ソース秘匿) | このリポジトリ |
| `cf-alc-signaling/` | WebRTC シグナリング (Cloudflare Durable Objects + Hibernatable WS) | このリポジトリ |
| `~/rust/rust-nfc-bridge/` | NFC リーダー → 仮想シリアルポート (Windows) | 別リポジトリ (symlink: alc-app) |
| `~/rust/rust-alc-api/` | バックエンド API (GCP Cloud Run + PostgreSQL RLS) | 別リポジトリ (symlink: alc-app) |
| `plan/` | 実装計画ドキュメント | このリポジトリ |
| `docs/` | 仕様書 (FC-1200 RS232C 通信フロー等) | このリポジトリ |

## 技術スタック

- **フロントエンド**: Nuxt 4, Tailwind CSS, @vladmandic/human, WebSerial API, WebRTC
- **FC-1200 プロトコル**: Rust → WASM (wasm-pack, wasm-bindgen)
- **シグナリング**: Cloudflare Workers + Durable Objects (Hibernatable WebSockets)
- **NFC ブリッジ**: Rust (tokio, serialport)
- **バックエンド API**: Rust (Axum), GCP Cloud Run
- **データベース**: PostgreSQL + Row Level Security
- **ストレージ**: Cloudflare R2 (顔写真)

## デプロイ

- **web (Cloudflare Workers)**: 通常運用は **CI 経由** (auth-worker / ippoan 標準と統一、#33)。
  - PR → main: `test.yml` (frontend-ci.yml) の `deploy-staging` が staging に自動 deploy
    - URL: https://alc-staging.ippoan.org (custom domain) / alc-app-staging.m-tama-ramu.workers.dev
  - `v*` tag push: `deploy-release` が **no-traffic upload** (`wrangler versions upload`) → Release Wave / `wrangler versions deploy <id>@100%` で明示 flip
    - URL: https://alc.ippoan.org (custom domain) / alc-app.m-tama-ramu.workers.dev
  - 緊急時 fallback (手動): `cd web && npm run deploy` (= `nuxt build && wrangler deploy`)
- **cf-alc-signaling (Cloudflare Workers)**: `cd cf-alc-signaling && wrangler deploy`
  - URL: https://alc-signaling.m-tama-ramu.workers.dev
  - シークレット不要 (現在 STUN P2P のみ。TURN は後日対応予定)
- **rust-alc-api (GCP Cloud Run)**: 別リポジトリで管理
- **rust-nfc-bridge**: `v*` タグ push で GitHub Actions が自動リリース (Windows ビルド + MSI 作成 + GitHub Release にアップロード)
  - 手順: `Cargo.toml` の version を上げる → commit & push → `gh release create v0.x.x` → Actions が MSI を追加

## 遠隔点呼 WebRTC (2026-03-04 実装)

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

## バージョニング

- **semver patch のみ** — バージョンアップは常に patch (例: 0.2.1 → 0.2.2)。minor/major は上げない。

## テスト

### テスト実行

```bash
npm test                # 全テスト (vitest run)
npm run test:watch      # ウォッチモード
npm run test:coverage   # カバレッジ付き
node scripts/check_coverage_100.mjs  # 100% リグレッション検出
```

### テスト環境

- **フレームワーク**: Vitest 4 + `@nuxt/test-utils` (Nuxt 環境)
- **DOM**: happy-dom (`@nuxt/test-utils` 経由)
- **IndexedDB**: `fake-indexeddb`
- **fc1200-wasm**: `tests/mocks/fc1200-wasm.ts` でモック (CI に wasm-pack 不要)
- `import.meta.client` は `@nuxt/test-utils` が自動で `true` に設定
- Nuxt auto-import (`useRoute`, `useState`, `ref` 等) も自動解決

### カバレッジ

- **Provider**: `@vitest/coverage-v8`
- **100% 達成ファイル**: `coverage_100.toml` で管理、CI でリグレッション検出
- **レポート**: `web/coverage/` (`.gitignore` 済み)

### テストパターン

- **pure utils**: モック不要、直接テスト (`license.ts`, `face-approval.ts`)
- **composables**: `vi.mock('~/utils/api')` で API モック
- **ブラウザ API** (WebSerial, BLE, NFC): `Object.defineProperty(navigator, 'serial', { value: {...}, configurable: true })` でモック。`delete (navigator as any).serial` で削除
- **Android bridge**: `(window as any).Android = { ... }` でモック
- **Nuxt auto-import のモック**: `mockNuxtImport('useRoute', () => mockFn)` (`@nuxt/test-utils/runtime`)
- **useState 共有ステート**: `beforeEach` でリセットすること (テスト間で値が共有される)
- **onMounted テスト**: `withSetup(() => useMyComposable())` ヘルパーで Vue コンポーネントコンテキストを作成 → `onMounted` / `onUnmounted` が発火する (`tests/helpers/with-setup.ts`)
- **`v8 ignore` 禁止** — 未カバーコードは `withSetup` / テスト追加 / 到達不能コード削除で対処。SSR ガード (`if (import.meta.client)`) は `onMounted` 内に移すか削除 (`onMounted` 自体が SSR で実行されない)
- **到達不能ブランチ**: `if (!db.objectStoreNames.contains(...))` のような初回のみ通るガードは、条件分岐を消して常に実行する形にリファクタ

### モジュールスコープ状態のテスト分離

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

### async composable テスト (Worker / WebSocket)

`detect()` 等の async 関数内で `await createImageBitmap()` 後に `worker.postMessage` が呼ばれる場合、テスト側で **await tick** を挟んでからアサートする:

```ts
const detectPromise = fd.detect(video)
await new Promise(r => setTimeout(r, 0))  // createImageBitmap の await を通す
expect(w.postMessage).toHaveBeenLastCalledWith(...)
w.simulateMessage({ type: 'result-lite', face: [], gesture: {} })
await detectPromise
```

### vi.useFakeTimers の注意

- happy-dom 環境では `vi.useFakeTimers()` が `navigator` や `WebSocket` と干渉する場合がある
- **必ず `toFake` オプション**で必要なタイマーだけ指定: `vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })`
- `afterEach` で必ず `vi.useRealTimers()` を呼ぶ
- async 関数 + fake timers の組み合わせはタイムアウトしやすい (reconnect ループ等)

### disconnectWebSocket バグパターン

`ws.close()` は MockWebSocket で同期的に `onclose` を呼ぶ。`onclose` 内で `transport.value = null` が設定されるため、`ws.close()` **後**に `if (transport.value === 'websocket')` をチェックすると false になる。**チェックを `ws.close()` 前に行う**こと。

### 型同期 (ts-rs)

Rust バックエンドの models.rs → TypeScript 型を自動生成:
```bash
cd ~/rust/rust-alc-api
bash scripts/sync-types.sh
# → web/app/types/generated/ に 91 ファイル生成
```

- `types/generated/` は git 管理 (CI で差分チェック可能)
- `types/index.ts` から `Backend` namespace で参照: `import { Backend } from '~/types'`
- フロント固有型 (`FaceAuthResult`, `Fc1200State` 等) は `types/index.ts` に手動定義

### API テスト共通化方針 (mock / live 両対応)

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

### CI

- **GitHub Actions**: `.github/workflows/test.yml`
  - `npm ci` → `vitest run --coverage` → `check_coverage_100.mjs` → Job Summary → artifact
  - fc1200-wasm は CI でスタブ化 (ダミー package.json + index.js)
  - トリガー: push/PR to main (`web/**` パス変更時)
  - **Job Summary**: テスト結果 + カバレッジ表 + 100% 未達ファイル一覧 (折りたたみ)

### ブランチワークフロー

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

## 重要な注意事項

- **リポジトリは public** — 機密情報のコミットに注意
- `docs/*.pdf` (FC-1200 通信仕様 = **Tanita Confidential**) は `.gitignore` 済み — **絶対にコミットしない**
- `fc1200-wasm/src/`, `Cargo.toml`, `Cargo.lock` は `.gitignore` 済み — WASM にコンパイルしてプロトコル実装を秘匿
- `rust-nfc-bridge/` と `rust-alc-api/` は `~/rust/` に移動済み（各プロジェクト内に `alc-app` symlink あり）
- Durable Objects の WebRTC 実装は **Hibernatable WebSockets API** が必須
