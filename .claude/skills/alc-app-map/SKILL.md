---
name: alc-app-map
generated-from: alc-app:d94839217472347c3049ad2a7ece1b638615ee45
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
| **`cf-alc-signaling/`** | `src/{index,signaling-room,room-registry,camera-signaling-room}.ts` + `wrangler.toml` | WebRTC signaling worker。Durable Objects (Hibernatable WS) で SDP/ICE リレー。worker 名 `alc-signaling`。`CameraSignalingRoom` (`/cam-room/:siteId`) は拠点カメラ (C212) 中継用の別系統 DO — `SignalingRoom` と同じ device/admin 1:1 リレーだが `RoomRegistry` (着信通知) を呼ばない (ippoan/alc-app#129)。**dev端末の区別 (Refs ippoan/alc-app#387)**: `/room/:roomId` `/watch-rooms` `GET /active-rooms` は任意の query `token` を受ける。worker (`index.ts` の `resolveDev`) が auth-worker の introspect で「dev端末の鍵か」を決め、DO へは内部ヘッダーで渡す (端末の申告は見ない)。token が無い接続は dev でないものとして従来どおり動く。**`?token=` を空で付ける・検証に落ちる → 401** (dev でない側に倒さない)。部屋の一覧を外へ出す経路は `RoomRegistry.getActiveRooms(viewerDev)` を必ず通る (**絞り点はこの 1 か所** — dev の購読者には dev の部屋だけ、dev でない購読者には dev でない部屋だけ)。dev の device が居る部屋に dev でない admin が入ろうとすると 403、先に居た dev でない admin は close code 1008 (`dev room`) で切られる。テストは `cf-alc-signaling/test/dev-rooms.test.ts` |
| **`cf-alc-recorder/`** | `src/{index,recorder-hub,auth,measurements}.ts` + `wrangler.toml` + `test/` | CoreS3 (alc-app-s3) 測定データ受口 worker (#106/#108)。上りは WS (`/ws`、テナント単位 DO `RecorderHub`) と Wi-Fi 客向け `POST /measurements` バッチ (#109、ステートレス) の 2 経路 — どちらも device JWT introspect (role allowlist: `device-hub` = CoreS3 / `device-print` = AtomS3 印刷ブリッジ ippoan/alc-app-s3#38 / `device-gateway` = P4 GW ippoan/alc-gw-p4#15。他 role は 403) → auth-worker `/alc-internal-proxy` → rust-alc-api `POST /api/hub/measurements` に転送。例外: `kind=crash_log` (CoreS3 異常リセット復帰レポート、ippoan/alc-app-s3#43) は backend へ転送せず R2 `CRASH_LOGS` (bucket `alc-crash-logs`、key `{tenant}/{device}/{seq 12桁0詰}.json`、再送冪等) へ直接保存して ack + メール通知 (`CRASH_EMAIL` send_email binding、best-effort、security-notification-app と同方式)。下り command push は WS のみ。worker 名 `alc-recorder`。**session_id (Refs ippoan/alc-app-s3#112)**: 1 回の点呼を束ねる端末発番の識別子を上り frame / POST body から素通しする。`normalizeSessionId` が字種 (英数字 `-` `_`、64 文字) を検証するが、**外れても測定ごと弾かず null に落とす** — session_id は付加情報で、これを理由に測定を捨てると点呼の記録そのものを失うため (log 1 行を残す)。上流 rust-alc-api は同じ制約で 400 を返すが、あちらは本 worker 以外の経路に対する多層防御。**dev端末の区別 (Refs ippoan/alc-app#387)**: introspect の `dev_device === true` (読むのは `auth.ts` の `isDevIntrospect` だけ) の端末が送った測定・打刻は、backend へ `X-Device-Dev: 1` を付けて転送する (`measurements.ts`)。**端末の申告 (frame / body / ヘッダー) では決めない** — WS は attachment (introspect 済みの claims) から、ブラウザ打刻の内部 API は caller (web の server route) が立てた `X-Device-Dev: 1` から決める。打刻の合図は購読者の tag で分ける (`recorder-hub.ts`): dev でない購読者は `watch:timecard`、dev の購読者は `watch:timecard:dev`。**購読者はどちらか片方の tag しか持たない**ので、dev の打刻は dev の購読者にだけ、本番の打刻は本番の購読者にだけ届く |
| **`fc1200-wasm/`** | (git ignored) Rust → WASM | FC-1200 RS232C プロトコル実装を WASM に compile して**ソース秘匿**。`web` から `fc1200-wasm` import |
| **`docs/`** | mkdocs (`mkdocs.yml`, admin/ operator/) | 運用ドキュメント。`docs/*.pdf` = Tanita Confidential で **.gitignore** |
| **`plan/`** | `implementation-plan.md` `initialplan.md` | 実装計画 |
| **`scripts/`** | `sync-ts-bindings.sh` | rust-alc-api 型同期補助 |
| **`~/rust/rust-nfc-bridge`** `~/rust/rust-alc-api` | **別 repo** (symlink `alc-app` あり) | NFC リーダ→仮想シリアル (Windows) / バックエンド API (Axum + Cloud Run + PG RLS) |

## web/ の区画

| 区画 | 主要ファイル | 役割 |
|---|---|---|
| **pages** | `web/app/pages/{index,tenko,login,register,device-claim,device-approve,maintenance}.vue` + `pages/auth/` | 測定 / 点呼 / 認証 / デバイス登録承認 |
| **composables (デバイス I/O)** | `useFc1200Serial.ts` (WebSerial) `useNfcWebSocket.ts` `useNfcReader.ts` `useBleGateway.ts` `useSerialDeviceManager.ts` `useCamera.ts` | FC-1200 シリアル / NFC WS / NFC の読み取り口 (USB 直結 + ブリッジを束ねる) / BLE / シリアル管理 / カメラ。**NFC の read に載る `card_type`** (Refs ippoan/alc-app#387): `NfcReadEvent.card_type` は**免許証イベント (`nfc_license_read` / `EVT NFC_LICENSE`) から作られた read にだけ載る** (素の `nfc_read` には載らない。ブリッジの JSON が名乗ってきても落とす)。`NfcStatus.vue` はそれを `read` の emit の**第 4 引数**でそのまま渡す — **ref に置かない** (期限 = 第 2 引数は前の免許証のものが残る作りなので、同じ形にすると免許証でないカードが前の人の `'driver_license'` で通る)。見ているのは `NormalMeasurement` の `itMode` だけで、ほかの受け手は第 4 引数を受けない。`useFc1200Serial.autoConnect` / `useBleGateway.startAutoConnect` は serial ポート 0 件が続くと `ws://127.0.0.1:{9878,9877}` の WS ブリッジ (alc-gw / Android) へ自動フォールバック (#123) |
| **composables (顔認証)** | `useFaceAuth.ts` `useFaceDetection.ts` `useFaceSync.ts` `useFingerprint.ts` | 顔検出 (Web Worker) / 同期 / 指紋 |
| **composables (点呼/通話)** | `useWebRtc.ts` `useItTenkoCall.ts` `useTenkoKiosk.ts` `useTenkoAdmin.ts` `useScreenShare.ts` `useVideoRecorder.ts` | WebRTC 通話 / IT点呼 の通話と判定待ち / 点呼キオスク / 管理者 / 画面共有 / 録画。**`useItTenkoCall.ts`** (Refs ippoan/alc-app#387) = `start(点呼の記録の id)` がカメラ・マイクを取り、`useWebRtc('device').connect(signalingUrl, itTenkoRoomId(id))` → `startStreaming`、3 秒ごとに `getTenkoSession(id)` (こちらは接頭辞なし) を引いて `manager_judgment` (`'ok'` / `'ng'`) が付いたら通話を切って判定を出す。状態は `idle / connecting / calling / judged / unavailable`。`connect` が throw したら (開発用の印があるのにトークンが取れない場合を含む) `unavailable` にするだけで、token なしでは繋ぎ直さない。**生成するのは `NormalMeasurement` の `itMode` のときだけ**。カメラ・マイクの取り方は `TenkoKiosk.vue` の遠隔点呼と同じ手順の複製 (あちらは本番の経路なので触っていない。共通化は IT点呼 を通常点呼へ統合するとき)。**`useAlarmWatch.ts`** (Refs ippoan/alc-app#387) = 運行管理者席は警告デバイス (VoiceS3R) が繋がるたびに運行管理者の鍵のトークンを 1 回先取りする (`useManagerDeviceToken().prefetchManagerJwt`) — Google ログイン済みの席でも開発用の印が立つようにするため |
| **composables (その他)** | `useAuth.ts` `useManagerAuth.ts` `useOfflineSync.ts` `useDemoMode.ts` `useAndroidLandscape.ts` `useNfcBridgeUpdate.ts` `useGwStatus.ts` `useTimecardWatch.ts` | 認証 / オフライン同期 / デモ / Android / Windows GW (alc-gw) 疎通診断 (`127.0.0.1:11984` + WS 9876/9877/9878 を使い捨て接続で probe、#124) / **打刻更新の購読** (`useTimecardWatch.ts`: cf-alc-recorder `wss://…/watch-timecard` に `Sec-WebSocket-Protocol: ["alc.timecard.v1", <jwt>]` で繋ぎ、`{type:"timecard_punch"}` の**合図だけ**を受けて一覧を引き直す。**管理画面 `TimecardManager.vue` とキオスク `TimePunchKiosk.vue` で共有** — `onopen` で無条件に 1 回引き直し、**未接続の間だけ 30 秒ポーリング**、トークンが取れなければ WS を張らずポーリングのみ、Refs ippoan/alc-app-s3#134) |
| **components** | `Tenko*.vue` (多数: Kiosk/VideoCall/RemoteAdminView/ScheduleManager 等) `*Dashboard.vue` `FaceAuth.vue` `AlcMeasurement.vue` `Device*.vue` `GwStatusCard.vue` `HubMeasurementsViewer.vue` | 点呼 UI / ダッシュボード / 測定 / デバイス管理 / GW 確認カード (DeviceSettings 内、GW 未検出時は折りたたみ) / ハブ測定値ビューア。**画面は独立ページではなく `AdminDashboard.vue` のタブ** (`hub_measurements` = 「ハブ測定値」、「デバイス管理」の隣) — 管理機能は index.vue のロールタブ → `*Dashboard.vue` 内タブという 2 段構成なので、`pages/` に足しても導線が無い。`HubMeasurementsViewer.vue` は CoreS3 統合ハブ (alc-app-s3) が cf-alc-recorder 経由で 溜めた測定を `GET /api/hub/measurements` (Refs ippoan/rust-alc-api#592) から読む閲覧専用。絞り込みは device_id / kind / 受信日時 (`created_at` の閉区間)、並びは backend 固定の `created_at DESC`。**総件数は API が返さない** (ingest テーブルが伸び続けるため) のでページャは `has_more` + offset だけ。`payload` は JSONB 素通しなので既定は畳む。**`DevDeviceRecords.vue`** (Refs ippoan/alc-app#387) = dev端末 (開発用の鍵) の記録を見る画面。`index.vue` のハンバーガーに、**キオスクの鍵に dev の印がある端末だけ**出る。一覧は管理画面と同じ `TenkoSessionMonitor` をそのまま置き、取得は端末の鍵のトークンに乗るので返るのは dev の記録だけ。印を外すボタン (`clearDevDeviceMark('kiosk')`) を持つ。**IT点呼** (Refs ippoan/alc-app#387) = 遠隔点呼とは別物で、**通常点呼の流れ (本人確認 → 測定 → 保存) の最後に運行管理者と通話し、運行管理者の判定が付いたら完了**。画面は複製せず `NormalMeasurement.vue` の prop **`itMode`** (既定は off = 今までの通常点呼と同一)。`itMode` のときだけ: ① 本人確認は免許証だけ (`read` の第 4 引数が `'driver_license'` でないタップ・手入力・IC カードからの開始 `startForEmployee`・URL のデモモードを受けない)、② 完了の PUT に `tenko_method: 'IT点呼'` を足す (通常点呼では key ごと足さない)、③ 応答の `tenko_session_id` で `useItTenkoCall` を始め、判定が付くまで `ResultCard` (「次の測定へ」を持つ) を出さない。判定待ちの画面には常に「未完了のまま終了」があり、乗務員は自分で出られる (判定が付くまで点呼は未完了のまま残る)。`tenko_session_id` が無い・オフライン・保存失敗のときは通話に進まず案内を出す — **オフラインの再送 (`offline-queue.ts`) には IT点呼 を運ばない**ので、その測定は通常点呼として記録される (既知の制限)。段の型 `NormalMeasurementStep` は増やしていない (`step='result'` のまま別の ref で持つ)。**IT点呼タブ** (`index.vue` の `?tab=it`) は「開発用の記録」と同じ出し方で、**キオスクの鍵に dev の印がある端末のハンバーガーにだけ**出る (印が無い端末が `?tab=it` で開いても通常点呼。印が消えたら通常点呼へ戻す)。IT点呼 の側の `NormalMeasurement` には `ref` (IC カードからの開始) も slot (打刻履歴) も付けない。**運行管理者側の IT点呼** (Refs ippoan/alc-app#387) = **`TenkoItAdminView.vue`**。`ManagerDashboard.vue` のタブ **`it_tenko`** (「遠隔点呼」の直後) で、**運行管理者席の鍵に dev の印 (`isDevDevice('manager-device')`) がある席にだけ**出る (印の写し `devManagerMark` を mount 時とタブを押すたびに読み直し、消えていたら `tenko` へ戻す。`?tab=` も `initialTab` の経路も無い)。流れは「社員番号で運行管理者を特定 (**顔認証なし**) → 通話 → 判定」。着信 = 部屋の一覧のうち `it-` の部屋だけ (`splitRooms(...).it`)、「未完了の IT点呼」= `listTenkoSessions({ tenko_method, judgment_pending: true }, 'tenko-monitor')` (取り直しは mount・部屋の増減・判定の後・「更新」だけ。周期の取得はしない)。未完了の行は、その記録の部屋が在れば「通話中」+「通話する」、無ければ「通話なしで確定する」。通信は全部 `'tenko-monitor'` の口で、測定の詳細 (`getMeasurement`) と顔認証は使わない。**測定時の顔写真は出さない** — IT点呼 の本人確認は免許証で、運行管理者は通話の映像で本人を見る (出る顔写真は、再利用している `TenkoDriverInfoPanel` の乗務員の登録写真だけ。`fetchFacePhoto` に口を足さない)。通話の手順と社員番号の段は `TenkoRemoteAdminView.vue` からの複製 (共通化は通常の点呼へ統合するとき)。`useActiveRooms` の `start` / `stop` は**参照カウントで、警告デバイスの見張りが別に 1 つ持っている**ので mount / unmount の 1 対 1 だけ。**`TenkoManagerJudgmentPanel.vue` の `defaultMethod`** (任意の prop) = 渡したときだけ「確認の方法」(IT点呼 (通話で確認) / 対面で確認) の 2 択を出し、送信 body に `method` を足す (初期値は記録の `manager_judgment_method`、無ければ prop)。**渡さない遠隔点呼モニターは画面も body も今までと同一** (IT点呼 でない記録に `method` を送ると backend が 400)。**遠隔点呼モニター (`TenkoRemoteAdminView.vue`) は `it-` の部屋を一覧から除く** (`splitRooms(...).remote`。IT点呼 の処理は持たない)。既知の制限: dev の席で `it-` の部屋の着信通知から開くと遠隔点呼タブに着き、一覧にも自動接続にも現れない (FCM は dev の部屋を通知しないので実際には起きない) |
| **utils** | `web/app/utils/{api,env,face-approval,face-db,fc1200,human-config,it-tenko,license,offline-queue,token-selection,video-store}.ts` | API client / 顔 DB (IndexedDB) / FC-1200 / human 設定 / オフラインキュー。**`it-tenko.ts`** (Refs ippoan/alc-app#387) = IT点呼 の通話の部屋の id は **`it-<点呼の記録の id>`** (遠隔点呼は記録の id そのまま、画面共有は `screen-<id>`)。接頭辞の定数と `itTenkoRoomId` / `isItTenkoRoom` / `itTenkoSessionId` をここ 1 か所に置き、端末側と運行管理者側が同じ関数を使う (運行管理者側は部屋の一覧を接頭辞で振り分ける)。運行管理者側の定数と純関数もここ: `MANAGER_JUDGMENT_METHOD` / 型 `ManagerJudgmentMethod` (判定の確認の方法 — 通話か対面か。**値の文字列を書くのはここ 1 か所**)、`IT_TENKO_METHOD` (記録の `tenko_method` の値。端末が保存時に送り、運行管理者側が一覧を絞る)、`defaultJudgmentMethod(viaCall)` (通話して開いたら IT、通話なしなら対面)、`splitRooms(rooms)` (`{ it, remote }` に分ける。順序は保つ)、`itTenkoRoomOf(sessionId, rooms)` (その記録の部屋が一覧に在ればその id)。**`api.ts` の `listTenkoSessions(filter, scope = 'default')`** は第 2 引数で口を選べる (IT点呼 の受け画面だけが `'tenko-monitor'` を渡す)。filter の `tenko_method` はそのまま query に出て、`judgment_pending` は **true のときだけ** `judgment_pending=true` を出す (false は落とす)。**`token-selection.ts`** (Refs ippoan/alc-app#387) = 送るトークンの選び方の規則 1 つ: **端末の鍵のトークンに claim `dev_device` があれば、管理者のトークンより先にそれを使う** (管理者のトークンで送ると本番の行になるため)。「dev の印」は端末のトークンが取れたとき `noteDeviceToken` が記録し (memory + localStorage `alc_dev_device_<kind>`、起動時に同期で読む)、決定点は `isDevDevice(kind)` (同期) / `usesAdminToken` / `selectSendToken` を通す。`kind` は `'kiosk' \| 'manager-device' \| 'bp-station'`。signaling 用は `devSignalingToken(getter)` — **印がある端末だけが呼び、取れなければ throw** (token なしの接続へ落とさない)。`api.ts` の `RequestTokenScope` の `'tenko-monitor'` (遠隔点呼モニターの口) は `request()` の冒頭で解決される: 運行管理者席の鍵が dev でなければ `'default'`、dev なら `'manager-device'` |
| **worker** | `web/app/workers/face-detect.worker.ts` | 顔検出 Web Worker (@vladmandic/human) |
| **server route** | `web/server/api/{proxy/[...path],tenko-call/{register,tenko},devices/*,print/*,driver-master/run,timecard/punch,github-checksum.get}.ts` | **proxy/** = auth-worker proxy (`createAuthWorkerProxyHandler`、#434 step 3 / 方式 B): cookie/Bearer JWT + X-Alc-Proxy-Secret (=INTERNAL_SHARED_SECRET) を AUTH_WORKER service binding 経由で auth-worker `/alc-proxy/*` に thin-forward。introspect / ACL / OIDC mint / X-Tenant-ID + X-User-* 注入は auth-worker 側に集約 (SA key 排除)。**admin / device JWT を伴う呼び出しは `app/utils/api.ts` の `request()` / `proxyRawFetch` が `/api/proxy` 経由に寄せる (#434 step 3d caller #3、admin 直叩き撤去)**。残る `tenko-call/{register,tenko}` (public) と `devices/*` (FCM token / version / watchdog / claim / **re-pair**、Android 直叩き) は browser JWT 無しのため lockdown 化は caller #5 (Android)。`devices/re-pair.post.ts` は kiosk 端末再認証 (rust-alc-api#495)。管理者側の window 発行 (`authorizeRepair`) はテナント認証付きなので `request()` → `/api/proxy` 経由。NFC bridge checksum。**`timecard/punch.post.ts`** = ブラウザ打刻 (Refs ippoan/alc-app-s3#134): browser/kiosk JWT を introspect → `tenant_id` / `device_id` (キオスクは `sub`、利用者は `browser`) → RECORDER binding で cf-alc-recorder `POST /tenants/:t/devices/:d/timecard-punch`。**rust-alc-api へ直行させない** — recorder の DO を通さないと `/watch-timecard` の合図が鳴らず、「端末で打つと更新されるがブラウザで打つと更新されない」になる。`kind` (`timecard`) と `seq` は recorder が立てる |
| **型 (生成)** | `web/app/types/generated/*` (91 file) + `web/app/types/index.ts` | rust-alc-api models.rs から **ts-rs 自動生成** (`Backend` namespace)。手動編集禁止。フロント固有型は index.ts に手動定義 |
| **middleware** | `web/app/middleware/auth.global.ts` | 全ルート認証ガード |

## entrypoint

- **web nitro**: `web/nuxt.config.ts` → `nitro.preset = "cloudflare_module"`、`main = .output/server/index.mjs` (`web/wrangler.jsonc`)。`vite-plugin-wasm` + `optimizeDeps.exclude: ['fc1200-wasm']`。
- **web wrangler (jsonc)**: top-level = prod (`alc-app`, alc.ippoan.org)。`env.staging` = `alc-app-staging` (alc-staging.ippoan.org)。`NUXT_PUBLIC_{API_BASE,GOOGLE_CLIENT_ID,AUTH_WORKER_URL,STAGING_TENANT_ID,SIGNALING_URL}` を env で切替。
- **signaling**: `cf-alc-signaling/src/index.ts` (worker entry) → DO `SignalingRoom` (device/admin 2 ピア間リレー、`/room/:roomId`) + `RoomRegistry` (着信通知) + `CameraSignalingRoom` (拠点カメラ中継、`/cam-room/:siteId`、`RoomRegistry` 非連携、ippoan/alc-app#129)。`wrangler.toml` に migration v1/v2/v3、`BACKEND_API_URL` var。secret 不要 (STUN P2P のみ、TURN 後日)。
- **recorder**: `cf-alc-recorder/src/index.ts` (worker entry)。`/ws` → introspect 後にテナント単位 DO `RecorderHub` (Hibernatable WS、identity は WS attachment) へ routing。`POST /measurements` → DO を経由せず Worker 直で検証 + ingest 転送 (`src/measurements.ts` を WS 経路と共有)。下り `POST /tenants/:t/devices/:d/command` 等は `INTERNAL_SHARED_SECRET` の内部 API。`POST /tenants/:t/devices/:d/timecard-punch` (ブラウザ打刻、#134) と `GET /watch-timecard` (打刻更新の購読 WS) も DO 経由 — **打刻の合図 (`notifyTimecardPunch`) を出す場所を 1 か所に保つため**、ブラウザの打刻もここを通す。binding: `AUTH_WORKER` (service) + `INTERNAL_SHARED_SECRET` (Secrets Store) + `CRASH_LOGS` (R2、crash_log 保存先) + `CRASH_EMAIL` (send_email、crash メール通知)。prod/staging 2 面 (`env.staging`)。
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

- **★ main へのマージは数分で本番に出る** (web / signaling / recorder のどれも)。「マージしても staging まで」ではない。
- **web (Cloudflare Workers)**: **CI 経由** (auth-worker / ippoan 標準と統一、#33)。
  - PR → main: `test.yml` (frontend-ci.yml) の `deploy-staging` が staging に自動 deploy
    - URL: https://alc-staging.ippoan.org (custom domain) / alc-app-staging.m-tama-ramu.workers.dev
  - **本番**: main へマージ → Tag Release (`tag-release.yml`。`workflow_dispatch` で repo の外から起動される) が
    `v*` を付ける → `deploy-release` が **no-traffic upload** (`wrangler versions upload`) →
    Release Wave (`release-wave.yml`。ci-dashboard からの `repository_dispatch`) が
    `wrangler versions deploy <新しい版>@100%` で本番の 100% に切り替える。**人の操作は挟まらない**
    (実測 2026-10-01: マージから約 3 分)。Release Wave の run 名は dispatch の event 名がそのまま出るので
    `…-rollback` と表示されるが、やっているのは新しい版への切り替え
    - URL: https://alc.ippoan.org (custom domain) / alc-app.m-tama-ramu.workers.dev
  - 緊急時 fallback (手動): `cd web && npm run deploy` (= `nuxt build && wrangler deploy`)
- **cf-alc-signaling (Cloudflare Workers)**: CI 経由 (`signaling-deploy.yml`: `tsc --noEmit` → `npx vitest run` →
  `wrangler deploy`)。**単一環境** (staging / 本番の分割なし) — `cf-alc-signaling/**` を変える PR が
  main に入った時点 (push) で本番に deploy される。PR では typecheck と test だけ。
  手動 fallback: `cd cf-alc-signaling && wrangler deploy`
  - URL: https://alc-signaling.ippoan.org (custom domain) / alc-signaling.m-tama-ramu.workers.dev
  - シークレット不要 (STUN P2P のみ。TURN は後日対応予定)。JWT 検証用 (cam-room の admin 接続 /
    dev端末の区別の `?token=`) に AUTH_WORKER service binding + INTERNAL_SHARED_SECRET
    (既存 Secrets Store 共有) を持つ
- **cf-alc-recorder (Cloudflare Workers)**: CI 経由 (`recorder-deploy.yml`: `npx vitest run` → deploy)。
  main への push で **staging**、`v*` tag の push で**本番** (前のタグから `cf-alc-recorder/` が変わっていなければ
  本番 deploy は skip)。タグは上の Tag Release が付けるので、**マージから数分で本番に出る**。
  手動 fallback: **タグを checkout してから** `cd cf-alc-recorder && wrangler deploy` (本番 tree がタグとずれると、次のタグが前タグとの tree 比較で skip され本番に載らない)
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
| `web/app/composables/useWebRtc.ts` | `connect(signalingUrl, roomId, path = 'room', token?)` — Room ID = tenko_session_id。`path = 'cam-room'` は拠点カメラ中継、`token` はサーバ側で認証を要求する path 向け。**dev端末 (Refs ippoan/alc-app#387)**: `path === 'room'` で `token` を渡さない呼び出しは、端末の鍵に dev の印があるときだけ、その鍵のトークンを取って `&token=` で付ける (見る鍵は role で決まる — `admin` は運行管理者席、`device` はキオスク → 測定台 → 運行管理者席の順で最初に印があるもの)。**取れなければ接続しない** (fail-closed — WebSocket も peer connection も作らず `error` を立てて reject)。印が無い端末は今までどおり token なしで、同期の流れの中で繋ぐ。close code 1008 (dev の部屋から切られた) は `error` に出すだけで、自動では繋ぎ直さない |
| `web/app/composables/useActiveRooms.ts` | signaling の部屋一覧の購読 (`GET /active-rooms` + `/watch-rooms` の WebSocket、アプリ全体で 1 本)。運行管理者席の鍵に dev の印があるときだけ `?token=` を付け、取れなければ繋がず 3 秒ごとに試し直す |
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
