# Android HCE 読取検証メモ (WS1850S調査 → 既存PCSCリーダーでの実機検証計画)

Refs #90 (close済み、点呼キオスク構成の全体図・NFC調査), #91 (close済み、CoreS3統合ハブ化検討)

関連: `plan/nfc-universal-unit-st25r3916-note.md` (ST25R3916/M5 NFCユニバーサルユニットの調査、
TenkoCallアプリでの双方向NFC情報受け渡し計画)

## 背景

TenkoCallアプリを使った双方向NFC情報受け渡し計画 (`plan/nfc-universal-unit-st25r3916-note.md`)
の中で、「スマホ(Android HCE)→キオスク読取」方向の検証に、既存のST25R3916ユニット以外の
安価なM5Stack用RFIDモジュール (WS1850S搭載 RFID 2ユニット) が使えないか調査した。

## WS1850S RFID 2ユニットの調査結果

### チップの実態

- **PN532系ではなくMFRC522系互換チップ**。旧世代の「Unit RFID」(RC522版)のArduinoライブラリは
  `MFRC522_I2C.h`をそのまま使用しており、WS1850Sも同系統として扱われている
- MFRC522系はそもそも**リーダー/ライター専用IC**で、Card Emulation/NFCターゲットモード/P2Pの
  ハードウェア機能を持たない (PN532のような3モード構成ではない)
- M5Stack公式ドキュメント (`docs.m5stack.com/en/unit/rfid2`、日本語版も同様) には
  Card Emulation・NFCターゲットモード・P2Pへの言及が一切ない。対応規格は
  ISO/IEC 14443 Type A/B (MIFARE・NTAG)、通信距離20mm以内の「read/write unit」とのみ記載
- 公式の`M5Unit-NFC`統合ライブラリでは、Card Emulationは「Unit NFC」(ST25R3916系、本命の
  ユニット)向けの機能として提供されており、WS1850S搭載の別製品(M5Dial内蔵)については
  明示的に **"NFC-A/B Detect only"** (検出専用、機能縮小) と書かれている

### 「非接触での双方向データ通信」という商品説明について

switch-scienceの商品ページ (https://www.switch-science.com/products/8301) に
「非接触での双方向データ通信やカードの読み込み/認識が可能」という記載があるが、これは
**「リーダー⇔カード間のコマンド/レスポンス往復」**（読み取りコマンドを送りカードからデータが
返ってくる = 双方向）を指しており、**「モジュール自体がカードになりすます(Card Emulation)」
という意味ではない**。対応プロトコルがISO14443A/MIFARE/NTAGに限定されている(全てパッシブ
カード側の規格)ことと整合する。誤解しやすい表現なので注意。

### Android HCE (ISO14443-4) 読取自体も未確認

Card Emulation非対応とは別に、「読む側」(WS1850Sリーダーがスマホ側のHCEを読む)も
現状のライブラリでは確認できていない:

- WS1850S用コミュニティライブラリ (`mhaberler/M5StackRFID2-Reader`) のREADMEには
  **「ISO/IEC 14443-4カードにはまだ対応していない、タグの存在検出はできる」**と明記。
  Android HCEはISO14443-4層(RATS/APDU交換)が必須のため、このライブラリでは検出はできても
  HCEとの通信はできない
- より成熟した汎用MFRC522ライブラリ(`miguelbalboa/rfid`)でも、Android HCEとの通信は
  既知の課題(Issue #220「RC522とAndroid HCE間のデータ交換」、Issue #458「ISO/IEC 14443-4
  カードが正しく動作しない」)として複数報告されており、プロトコルスタックを自前実装しても
  タイムアウト等の相性問題が残る

### 結論

WS1850S RFID 2ユニットは、

1. **Card Emulation方向 (キオスク→スマホ) の検証には使えない** (ハードウェア非対応)
2. **HCE読取方向 (スマホ→キオスク) の検証も現状のライブラリでは確認できない** (ISO14443-4未対応)

いずれの方向についても、既存の本番PCSCリーダー(`rust-nfc-bridge`)側で直接検証する方が
確実性が高い。WS1850Sユニットを別途購入する優先度は低い。

## 既存PCSCリーダーでのHCE読取検証計画

「スマホ(Android HCE)→キオスク読取」方向は、新規ハードウェア不要で既存の本番環境の
延長で検証できる。

### 検証環境

- **既存の`rust-nfc-bridge`(Rust、Windowsで稼働中)をそのまま使う**。新しい言語・スタックは
  不要、既存のPCSCリーダー・既存のWindows PC・既存のRustプロジェクトの延長
- `src/nfc/reader.rs`に既にある`Context::establish` → `card.transmit()`の仕組みを流用

### 検証手順

1. `src/nfc/reader.rs`の`GET_UID_APDU` (`0xFF,0xCA,0x00,0x00,0x00`) を送っている箇所を、
   **SELECT AID APDU** (例: `00 A4 04 00 <AIDの長さ> <AIDバイト列> 00`) に差し替えた
   検証用ブランチ or 別バイナリを用意する
2. Android側に最小限のHCEテストアプリを用意する:
   - `HostApduService`を実装し、上記SELECT AIDに対して固定レスポンス
     (例: `"OK"` + ステータスワード `90 00`) を返すだけの数十行のアプリ
   - マニフェストに対象AIDを`aid-group`として登録
3. 既存リーダーにスマホをタップし、`transmit()`が成功してレスポンスが返るか確認

### 判定

- 成功すれば、「既存PCSCリーダーでAndroidのHCEを読める」ことが実機で確定し、
  TenkoCallアプリでの双方向NFC情報受け渡し計画の「スマホ発信フロー」読取側が
  そのまま成立する
- 失敗する場合、この方向自体の見直し(リーダー交換等)が必要になる

## 未検証・要検討事項

- [ ] 上記検証手順を実機で実施し、既存PCSCリーダーでのSELECT AID→レスポンス1往復の
      疎通を確認する
- [ ] 失敗した場合の代替リーダー候補の選定 (ACR122U系以外でISO14443-4完全対応を
      謳う製品の調査)

## 関連

- Refs #90 — 点呼キオスク構成の全体図・NFC調査
- Refs #91 — CoreS3統合ハブ化検討
- `plan/nfc-universal-unit-st25r3916-note.md` — ST25R3916/M5 NFCユニバーサルユニットの調査、
  TenkoCallアプリでの双方向NFC情報受け渡し計画
- `ippoan/rust-nfc-bridge` — 既存キオスクNFCリーダー実装 (`pcsc` crate、`src/nfc/reader.rs`)
- [mhaberler/M5StackRFID2-Reader](https://github.com/mhaberler/M5StackRFID2-Reader)
- [miguelbalboa/rfid Issue #220](https://github.com/miguelbalboa/rfid/issues/220)
- [miguelbalboa/rfid Issue #458](https://github.com/miguelbalboa/rfid/issues/458)
- [Unit RFID2 - m5-docs](https://docs.m5stack.com/en/unit/rfid2)
- [RFID 2 Unit (WS1850S) — スイッチサイエンス](https://www.switch-science.com/products/8301)
