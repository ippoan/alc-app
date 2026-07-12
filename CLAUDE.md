# alc-app - アルコールチェッカーシステム

業務用アルコール検知システム。タニタ FC-1200 + NFC + 顔認証による本人確認付きアルコール測定 + WebRTC 遠隔点呼。

**リポジトリ**: https://github.com/yhonda-ohishi-alc/alc-app (public)

## 構成・詳細

- `web/` (Nuxt 4 PWA, Cloudflare Workers) / `fc1200-wasm/` (WASM, ソース秘匿) / `cf-alc-signaling/` (WebRTC signaling, Durable Objects) / `cf-alc-recorder/` (CoreS3 測定データ WS 受口, Durable Objects) — このリポジトリ
- `~/rust/rust-nfc-bridge` / `~/rust/rust-alc-api` — 別リポジトリ (`alc-app` symlink あり)
- 技術スタック・デプロイ手順・遠隔点呼 WebRTC 実装・テスト全パターン (モック/live 両対応・型同期・CI 等) の詳細は
  `.claude/skills/alc-app-map/SKILL.md` の「CLAUDE.md から移設」節を参照。

## テスト (要点)

```bash
npm test                              # web/ 配下、vitest run
node scripts/check_coverage_100.mjs   # 100% リグレッション検出 (詳細は map 参照)
```

## バージョニング

- **semver patch のみ** — バージョンアップは常に patch (例: 0.2.1 → 0.2.2)。minor/major は上げない。

## 重要な注意事項 ★strict

- **リポジトリは public** — 機密情報のコミットに注意
- `docs/*.pdf` (FC-1200 通信仕様 = **Tanita Confidential**) は `.gitignore` 済み — **絶対にコミットしない**
- `fc1200-wasm/src/`, `Cargo.toml`, `Cargo.lock` は `.gitignore` 済み — WASM にコンパイルしてプロトコル実装を秘匿
- `rust-nfc-bridge/` と `rust-alc-api/` は `~/rust/` に移動済み（各プロジェクト内に `alc-app` symlink あり）
- Durable Objects の WebRTC 実装は **Hibernatable WebSockets API** が必須
- **main に直接 push 禁止**（ブランチ保護ルール設定済み、CI green で `gh pr merge --squash --auto`）
- **`v8 ignore` 禁止** — 未カバーコードはテスト追加/到達不能コード削除で対処
