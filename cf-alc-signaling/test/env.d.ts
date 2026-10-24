// cloudflare:test の env (pool 0.13〜 は Cloudflare.Env) を worker の Env にする (テストの全ファイル共通)
import type { Env as WorkerEnv } from "../src/index";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

export {};
