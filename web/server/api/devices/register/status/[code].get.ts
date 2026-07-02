// QR一時登録のステータス確認 (認証なし public 経路、ポーリング用)。lockdown 対応で
// auth-worker /alc-internal-proxy 経由に forward する (Refs ippoan/rust-alc-api#480)。
// approved かつ tenant_id が取れたら device credential も mint して merge する
// (QR永久登録のポーリング承認フローでも kiosk credential が保存されるようにする)。
export default createStatusWithPairingHandler()
