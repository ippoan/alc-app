# M5Stack NFCユニバーサルユニット (ST25R3916) 調査メモ

Refs #90 (close済み、点呼キオスク構成の全体図・NFC調査), #91 (close済み、CoreS3統合ハブ化検討)

## 背景

CoreS3統合ハブ化検討 (#91) の中で、Unit NFC (ST25R3916) を rust-nfc-bridge の代替候補として
検討した経緯がある。#90 の結論では「rust-nfc-bridge + 既存NFCリーダーで充足しているため不要」
として不採用となっている。本メモはその判断を覆すものではなく、ST25R3916チップ自体の技術的な
動作モードを後から参照できるよう整理した一般調査メモ。

## ST25R3916 の動作モード

STMicroelectronics製NFCリーダー/ライターICで、以下3モードを持つ。

| モード | 方向 | 概要 |
|---|---|---|
| **Reader/Writer** | ユニット→スマホ/タグ | ユニット側がスマホのカードエミュレーション（おサイフケータイ等）やNFCタグを読む |
| **Card Emulation (CE)** | ユニット→スマホ | ユニット側が仮想NFCタグ/カードとして振る舞い、スマホが「タグを読む」動作（標準NDEF読み取り）で受動的に受信する |
| **Custom Protocol** | 双方向 | 独自APDU/生コマンドでのやり取り。スマホ標準のNFC読み取り（NDEF自動認識）では受け取れず、**スマホ側にも専用アプリ（IsoDep等の生APDU API経由）が必要** |

参考: M5Stack公式のNFCユニバーサルユニット製品デモ動画で上記3モードが実演されている
（Card Emulation / Reader/Writer / Custom Protocol の3構成で紹介）。

## 「ユニット→スマホへ情報を渡す」場合の結論

- **Card Emulation モードが本命**。OS・アプリを問わず、スマホをかざすだけでNDEFメッセージ
  （URL/テキスト等）を読み取れる。
- **P2P（NFC-DEP、旧Android Beam方式）は現行のAndroid/iOSでほぼサポート廃止**のため非推奨。
- Custom Protocolは柔軟だが、受信側スマホに専用アプリが必要になる分、要件が上がる。

## alc-appとの関連・注意点

- 点呼キオスク構成のNFCは #90 の結論通り rust-nfc-bridge + 既存NFCリーダーで確定運用中。
  本メモの内容でこの判断を覆す想定はない。
- 将来、CoreS3統合ハブ化 (#91) 相当の構成を再検討する場合、あるいは全く別用途
  （例: 何らかのデバイス⇔スマホ間の簡易データ受け渡し）でST25R3916系ユニットを使う機会が
  あれば、モード選定の一次参照としてこのメモを使う。

## 関連

- Refs #90 — 点呼キオスク構成の全体図・NFC調査（NanoC6 + Unit NFC案を不採用と判断）
- Refs #91 — CoreS3統合ハブ化検討（Unit NFCをCoreS3のGrove I2Cに接続する案を検討）
- `plan/cores3-hub-consolidation.md` — 上記の統合ハブ化検討の詳細メモ
