// AlcoholChecker 端末登録。rust に claim を forward (/alc-internal-proxy) し、即承認 flow
// なら auth-worker /device/pair-internal で device credential を mint して claim レスポンスに
// device_secret を merge する (Refs ippoan/rust-alc-api#434 caller #5 案B)。
export default createClaimWithPairingHandler()
