// TenkoCall 端末登録 (認証なし public 経路)。lockdown 対応で auth-worker
// /alc-internal-proxy 経由に forward する (Refs ippoan/rust-alc-api#434 caller #5)。
export default createInternalIngestHandler('/api/tenko-call/register')
