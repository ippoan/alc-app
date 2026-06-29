// AlcoholChecker の watchdog heartbeat (device 経路)。device JWT Bearer があれば
// auth-worker /alc-proxy 経由、無ければ直叩き fallback (Refs ippoan/rust-alc-api#434 caller #5)。
export default createDeviceProxyHandler('/api/devices/report-watchdog')
