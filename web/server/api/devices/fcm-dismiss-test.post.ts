// FCM dismiss test (public、rust は device_id lookup で tenant 解決)。lockdown 対応で
// auth-worker /alc-internal-proxy 経由に forward (Refs ippoan/rust-alc-api#434 caller #5)。
export default createInternalIngestHandler('/api/devices/fcm-dismiss-test')
