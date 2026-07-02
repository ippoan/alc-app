// QR一時 / URL 端末登録の起点 (認証なし public 経路)。lockdown 対応で auth-worker
// /alc-internal-proxy 経由に forward する (Refs ippoan/rust-alc-api#480)。
export default createInternalIngestHandler('/api/devices/register/request')
