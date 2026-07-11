# CoreS3統合ハブ化 検討メモ

Refs #90 (close済み、旧3台構成の設計メモ), #91 (close済み、本ドキュメントに集約)

## 背景

点呼キオスク構成は現状、Windows PCに3本のUSBデバイス(FC-1200 RS232C、NFCリーダー、
ble-medical-gateway/ATOM Lite)がぶら下がる構成になっている。M5Stack CoreS3
(ESP32-S3) + M5Stack Module群で、この構成をどこまで簡略化できるか検討した。

## 近い将来の実装計画 (低リスク・着手可能)

既存の動いているもの(Windows PC・NFC・rust-nfc-bridge)には一切手を入れず、
FC-1200周りの脆いUSB-RS232変換アダプタ構成だけを置き換える。

```
Windows PC (既存キオスク、変更なし)
  ├─ USB① : CoreS3 (native USB-C, Device mode)
  │           ├─ BLE内蔵: NT-100B / NBP-1BLE (ble-medical-gatewayの代替)
  │           └─ M-Bus: RS232M Module → DB9 → FC-1200
  └─ USB② : NFCリーダー → rust-nfc-bridge (変更なし)
```

- USB③本(FC-1200/RS232C変換アダプタ + ATOM Lite)が **CoreS3 1台(USB1本)に集約**される
- NFC・Windows PC・rust-nfc-bridgeは変更しないため、既存動作を壊すリスクがゼロ
- BLE central接続コードは `ippoan/ble-medical-gateway` PR #2-#5 で実装した
  esp32-nimble ベースの実装がほぼそのまま流用できる (target を
  `xtensa-esp32-espidf` → `xtensa-esp32s3-espidf` に変更するだけ)
- RS232M ModuleはUSB Module(MAX3421E) + 別途USB-RS232変換アダプタより安価・シンプル
  (USB Hostドライバ実装が不要、CoreS3のUARTピンに直結)

### 完了条件 (Acceptance Criteria)

- [ ] RS232M ModuleでFC-1200からRS232Cデータを読み取れることを実機確認する
- [ ] CoreS3内蔵BLEでNT-100B/NBP-1BLEに接続しデータ取得できることを実機確認する
      (`ble-medical-gateway`のPoCコードをCoreS3向けに移植)
- [ ] CoreS3ネイティブUSB-C経由でWindows PC (alc-appキオスク) にデータを渡す方式を
      実装する (現行の`useFc1200Serial`/`useBleGateway`相当の置き換え)
- [ ] 実機でRS232M ModuleとCoreS3内蔵BLEが同時使用時にGPIO競合しないことを確認する
- [ ] 現行の3台構成からCoreS3統合構成への移行可否を最終判断する

## 将来検討: Windows PC排除案 (未着手、リスク高)

より踏み込んだ設計として、Windows PC自体を排除し、CoreS3 + 固定Androidタブレット
だけで運用する案も検討した。実装優先度は低いが、調査内容を残しておく。

```
CoreS3
  ├─ LAN Module 13.2 (Ethernet + PoE) → クラウド接続(alc-app backend) **兼 CoreS3自身の電源**
  ├─ ネイティブUSB-C (Device mode, 自己給電・データ線のみ) → 固定Androidタブレット (Host/OTGモード)
  ├─ BLE内蔵 → NT-100B / NBP-1BLE 読み取り専用
  └─ M-Bus: RS232M Module → DB9 → FC-1200
```

固定Androidタブレットは`AlcoholChecker`と同じDevice Owner Kioskモードの端末を想定。
NFCは廃止し、顔認証(タブレットのカメラ)→QRコード(CoreS3の画面に表示)→アルコール測定、
という即時結合フローで従業員識別を行う想定。

### 検討して却下した案

- **Wi-Fi SoftAP でタブレットとローカル接続**: ESP32のWiFiは長時間連続稼働で
  不安定になることがコミュニティで報告されており(watchdogでの自動再起動が
  事実上必須)、2.4GHz帯の混信リスクもある。固定関係ならそもそも無線を使う
  理由が無いため、有線USB-OTGに変更
- **QRによるスマホ⇔CoreS3のBLE/Wi-Fiペアリング**: タブレットを個人スマホ(BYOD)
  ではなく固定端末にする方針にしたため、都度ペアリングのロジック自体が不要になった
- **Unit NFC (Grove I2C) + rust-nfc-bridge移植**: 顔認証→QR即時結合フローで代替可能、
  ハードウェア・ソフトウェア両方を削減できるため不採用

### 電源設計

- CoreS3自体は **LAN Module 13.2 のPoE (IEEE802.3at, 最大6W)** から給電する
  (USBバスパワーに依存しない、自己給電デバイスとしてタブレットとUSB接続する)
- タブレット側は通常の充電器/ドックで別途給電する(常時稼働キオスク端末として
  常時給電が前提、AlcoholCheckerの既存運用と同様)

### 規制面の検討

- 遠隔点呼(点呼告示第5条)の「生体認証符号等により確実に識別する機能」要件は
  顔認証で満たす
- 「全身+検知器使用状況の随時確認カメラ」要件は既存の監視カメラ運用
  (Tapo等、ippoan/alc-app#27のONVIF死活監視アイデアを転用)で満たせる見込み
- 識別(顔認証)と測定(アルコールチェッカー)の時間結合について、法的な必須要件は
  無いことを確認済みだが、「顔認証→即QR発行→即測定」のフローにすることで
  なりすまし混入の余地を実質無くし、要件を上回る形で満たす設計とする

## ハードウェア調査メモ: モジュールのCoreS3対応・ピン競合

### 対応確認 (COMPATIBLE & EXCLUDE バッジ、商品ページより)

- **USB Module (MAX3421E)**: CoreS3 対応 (最終的に不採用、RS232M Moduleの方が
  安価・シンプルなため)
- **LAN Module 13.2 (W5500)**: CoreS3 対応
- **RS232M Module 13.2**: 「Module13.2 RS232M & CoreS3 Bus Connection」専用の
  接続ノートが公式docsに存在し、対応確認済み

### LAN Module 13.2 の CoreS3 ピン

公式Arduinoライブラリ (`M5Module-LAN-13.2/examples/LinkStatus/LinkStatus.ino`) より:

```
M5StackCoreS3: CS=GPIO1, RST=GPIO0, INT=GPIO10
```

基板シルク印刷には3組のジャンパ (INT/RST/CS) があり、各2択:

| 信号 | 選択肢A | 選択肢B |
|---|---|---|
| INT | G35 | G34 |
| RST | G0 | G13 |
| CS | G5 | G15 |

(シルクの番号は恐らく初代Core基準表記。RST=G0がLinkStatus.inoのCoreS3デフォルトと
一致することから、ジャンパでCoreS3上の別GPIOに切り替わる仕組み自体は実証されている)

### RS232M Module の CoreS3 バス接続表 (Fixed/Switch/NG)

M5Stack公式の「Module13.2 RS232M & CoreS3 Bus Connection」ツールより:

- **NG/Used (使用不可)**: `G13/I2S_DOUT`, `G0/I2S_LRCK`, `G14/I2S_DIN`, `5V`, `BAT`
  — **CoreS3内蔵I2S(スピーカー/マイク)が既にこれらのピンを使用している**ため使えない
- **Switch Connect (DIPスイッチで選択可)**: `G10`/`G8`/`G5`/`G9`/`G44・RXD0`/
  `G43・TXD0`/`G18・PC_RX`/`G17・PC_TX`/`G6`/`G7` 等、複数の有効な候補あり

### LAN Module と RS232M Module のピン競合可能性

LAN ModuleのデフォルトINT(GPIO10)が、RS232MのSwitch Connect候補にも`G10`として
出現するため、両方をスタックする場合は要調整。ただし両モジュールとも該当ピンを
別の選択肢に逃がすジャンパ/DIPスイッチを持っているため、原理的には両立可能と判断。

### 既知の実例 (M5Stack Community #5581)

Core2 + RS232F Module 13.2 で同種の問題が実際に報告・解決済み:
- 原因: Core2は内蔵PSRAMのためGPIO16/17を使う都合上、内部的にGPIO13/14へ配線を
  置き換えている
- 解決: **DIPスイッチはシルク印刷の「16/17」位置に設定しつつ、コード上では
  GPIO13/14を指定する**という「翻訳」が必要だった
- 回答者コメント: 同じ原理はCoreS3にも適用される、各デバイスのGPIO変換表を
  参照すべき

### ハードウェア調査の結論

「Windows排除案」のCoreS3 + RS232M Module + LAN Module 13.2 の組み合わせは、
衝突しそうなピン(GPIO10等)にもジャンパ/DIPスイッチの代替選択肢が存在するため、
原理的に成立する見込み。ただし具体的にどのジャンパ/DIPスイッチの組み合わせが
正解かは、実機で候補を確認しながら決定する必要がある(Core2の実例のように
「シルクの番号 ≠ コード上のGPIO番号」という翻訳が必要になる可能性が高い)。
机上調査であり実機未検証。

## 関連

- `ippoan/ble-medical-gateway` — BLE central接続 (esp32-nimble) のRust PoC実装元
- `rust-nfc-bridge` — 現行NFCブリッジ(近い将来計画では維持、将来検討案では廃止候補)
- ippoan/alc-app#27 — Tapo監視カメラのヘルスチェック(将来検討案の監視カメラ運用と関連)
- ippoan/rust-alc-api#480, ippoan/alc-app#72 — device credential / auth-worker
  device pairing (RFC 8628スタイル) の既存実装パターン
