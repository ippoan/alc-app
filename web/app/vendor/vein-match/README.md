# vein-match (指静脈照合の wasm)

キオスクがオフラインのときに、ブラウザの中で指静脈を 1:N 照合するための wasm
(Refs ippoan/vein-match#20)。オンラインの照合はサーバー (rust-alc-api `POST /api/vein/identify`)
が行い、ここはオフラインのときだけ使う。**オフラインでは学習しない** (登録データの正本はサーバー)。

**照合ロジックの公開用ビルド。解析資料は含まない。** 手で編集しないこと (下の sha256 が変わる)。

## 出どころ

- ippoan/vein-match の tag `v0.1.6` (private repo。撮影と登録の位置のずれ `shot_shifts` と平面 `shot_plane` / `enroll_planes` を足した版、ippoan/vein-match#30)
- `bash scripts/build-web.sh <出力ディレクトリ>` で作った 4 ファイルのうち 3 つを置いている
  (`vein_match_wasm_bg.wasm.d.ts` は使わないので入れていない)

| ファイル | 置き場所 | sha256 |
|---|---|---|
| `vein_match_wasm.js` | `web/app/vendor/vein-match/` (Vite が bundle する) | `3a0076b10f87c4421380a9eb6f1331bd1f44ee382a2c27a4bc656f25bb74cd24` |
| `vein_match_wasm.d.ts` | `web/app/vendor/vein-match/` | `7b451936fff3549370bd08269994ad234e40edc4040ce5f492329aead2bd560a` |
| `vein_match_wasm_bg.wasm` | `web/public/vein/` (static asset。`/vein/vein_match_wasm_bg.wasm` で配る) | `a6157eb62e2093936d05a23d844b27a6ce5a8b54fe5bb6ad209ae29d62ada3c8` |

`logic_version()` は `0.1.6`。サーバーの `GET /api/vein/templates` が返す `logic_version` と
食い違うと、キオスクはオフラインの照合を止める (`app/utils/vein-match.ts`)。

## 影の照合 (`chara_verify_shot`)

認証のたびに、モジュールが照合した撮影を、サーバーの記録（本人と他の乗務員）にブラウザでも 1:1 で
かけて点数と合否だけを診断ログに残す（`app/utils/vein-module.ts` の `PC VEIN SHADOW …`）。
本番の判定には使わない。学習後の記録は使わない。

## 位置のずれ (`shot_shifts`・`shot_plane`・`enroll_planes`)

開発用の端末だけ、認証のたびに、置いた指 (撮影) と登録の件の平面 (120×72、0/1) を画面の隅に描く
(`components/VeinShiftView.vue`)。ずれの数字はサーバーの判定が返したもの (`postVeinAuthShot`)。
平面は端末の中だけで描き、どこにも送らない。

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
