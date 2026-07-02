// QR一時登録のステータス確認 (認証なし public 経路、ポーリング用)。lockdown 対応で
// auth-worker /alc-internal-proxy 経由に forward する (Refs ippoan/rust-alc-api#480)。
export default createInternalIngestHandler(
  (event) => `/api/devices/register/status/${getRouterParam(event, 'code')}`,
)
