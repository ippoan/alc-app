# vein-match (指静脈照合の wasm)

キオスクがオフラインのときに、ブラウザの中で指静脈を 1:N 照合するための wasm
(Refs ippoan/vein-match#20)。オンラインの照合はサーバー (rust-alc-api `POST /api/vein/identify`)
が行い、ここはオフラインのときだけ使う。**オフラインでは学習しない** (登録データの正本はサーバー)。

**照合ロジックの公開用ビルド。解析資料は含まない。** 手で編集しないこと (下の sha256 が変わる)。

## 出どころ

- ippoan/vein-match の branch `25-feat-chara-verify` の commit `5d8da3c` (private repo、tag 未発行。`chara_verify_shot` を足した 0.1.3)
- `bash scripts/build-web.sh <出力ディレクトリ>` で作った 4 ファイルのうち 3 つを置いている
  (`vein_match_wasm_bg.wasm.d.ts` は使わないので入れていない)

| ファイル | 置き場所 | sha256 |
|---|---|---|
| `vein_match_wasm.js` | `web/app/vendor/vein-match/` (Vite が bundle する) | `327740286c0ff88f7561769871be391fae7a94b574f6a0ad0e0cfd6f876d2cab` |
| `vein_match_wasm.d.ts` | `web/app/vendor/vein-match/` | `e93b2488d77bc19df9fe6320a8d2a56978b848b96cf2e78081db71190a1aee72` |
| `vein_match_wasm_bg.wasm` | `web/public/vein/` (static asset。`/vein/vein_match_wasm_bg.wasm` で配る) | `49d15716416c29f0650aa57405e1dfca323ca5445eb41df55c662c32e38f5fbf` |

`logic_version()` は `0.1.3`。サーバーの `GET /api/vein/templates` が返す `logic_version` と
食い違うと、キオスクはオフラインの照合を止める (`app/utils/vein-match.ts`)。

## 影の照合 (`chara_verify_shot`)

認証のたびに、モジュールが照合した撮影を、サーバーの記録（本人と他の乗務員）にブラウザでも 1:1 で
かけて点数と合否だけを診断ログに残す（`app/utils/vein-module.ts` の `PC VEIN SHADOW …`）。
本番の判定には使わない。学習後の記録は使わない。

## 使い方

`app/utils/vein-match.ts` が初回だけ `init({ module_or_path: '/vein/vein_match_wasm_bg.wasm' })`
で読み込み、以後は使い回す。オフラインでも読めるよう、Service Worker が `/vein/` を
NetworkFirst でキャッシュする (`web/nuxt.config.ts` の workbox)。

## 更新の手順

1. ippoan/vein-match で新しい tag を切る (照合ロジックの版 = `logic_version()` が上がる)
2. その tag を別の worktree に出し、`bash scripts/build-web.sh <出力ディレクトリ>` を実行する
   (自己検査つき。解析資料が残っていれば exit 1 で止まる)
3. できた `vein_match_wasm.js`・`vein_match_wasm.d.ts` をこのディレクトリへ、
   `vein_match_wasm_bg.wasm` を `web/public/vein/` へ上書きする
4. この README の tag・sha256 表・`logic_version()` の値を書き換える
5. `web/tests/utils/vein-match.wasm.test.ts` の `logic_version()` の期待値を書き換える
6. サーバー (rust-alc-api) の照合ロジックも同じ版に上げる。版が揃うまで、キオスクの
   オフライン照合は「照合データが古い」で止まる (オンラインの照合は止まらない)
