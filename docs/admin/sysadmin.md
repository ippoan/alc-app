# システム管理者ガイド

システム管理者向けの操作マニュアルです。運行管理者のタブに加えて、システム設定用のタブが利用できます。

---

## ダッシュボード

画面上部のロール切替で「システム管理者」を選択してください。

### 乗務員

![乗務員タブ](../images/admin-dashboard-employees.png)

### 免許証

![免許証タブ](../images/admin-dashboard-license.png)

### 送信キュー

オフライン時に蓄積された測定データの送信キューを管理します。

![送信キュータブ](../images/admin-dashboard-queue.png)

### Webhook

点呼の異常を事業者のシステムへ自動で知らせるための設定です。「+ 新規作成」から、イベント種別（アルコール検出・点呼遅延・点呼中断・日常点検NG）と送り先の URL を設定します。

アルコールが検知されると、その場で点呼が「アルコール検知」として中止されて記録が残り、運行管理者へ顔写真付きのメール（通知の管理画面のグループ「アルコール検知」のメンバー）と、ここで設定した送り先への通知が送られます。設定のしかたとイベントの一覧は [通知（メール・Webhook）](webhook.md) を参照してください。

![Webhookタブ](../images/admin-dashboard-webhook.png)

### 中間点呼

中間点呼用の電話番号マスタと登録運転者を管理します。

![中間点呼タブ](../images/admin-dashboard-tenko-call.png)

### リモートカメラ

遠隔点呼のビデオ通話を管理します。

![リモートカメラタブ](../images/admin-dashboard-remote-camera.png)

### タイムカード

![タイムカードタブ](../images/admin-dashboard-timecard.png)

### デバイス管理

![デバイス管理タブ](../images/admin-dashboard-devices.png)
