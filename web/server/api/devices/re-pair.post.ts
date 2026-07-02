// kiosk 端末 re-pair (再認証、認証なし public 経路)。管理者が時限 window を開けた
// (POST /api/devices/{id}/authorize-repair) 後、端末がこの endpoint で device
// credential (auth_device_id/device_secret) を再取得する。rust 側が auth-worker
// /device/pair-internal 呼び出しまで完結させるので、alc-app 側での mint 処理は不要
// (Refs ippoan/rust-alc-api#495)。
export default createInternalIngestHandler('/api/devices/re-pair')
