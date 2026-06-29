// OTA トリガー (admin 経路、require_tenant_header)。管理画面の browser JWT Bearer を
// auth-worker /alc-proxy 経由で forward (introspect → X-Tenant-ID/X-User-* 注入)。
// Bearer 無し時は直叩き fallback (Refs ippoan/rust-alc-api#434 caller #5)。
export default createDeviceProxyHandler('/api/devices/trigger-update')
