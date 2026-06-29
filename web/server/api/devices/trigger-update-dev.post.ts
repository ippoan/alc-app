// dev OTA push (CI/dev、rust は X-Internal-Secret = FCM_INTERNAL_SECRET で自前認証)。
// lockdown 対応で auth-worker /alc-internal-proxy 経由に forward し、incoming X-Internal-Secret を
// pass-through する (Refs ippoan/rust-alc-api#434 caller #5)。
export default createInternalIngestHandler('/api/devices/trigger-update-dev', {
  forwardInternalSecret: true,
})
