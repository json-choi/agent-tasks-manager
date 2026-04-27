import { resolve } from "node:path";

export interface AppConfig {
  dataDir: string;
  port: number;
  publicBaseUrl: string;
  sessionTtlDays: number;
  authSecret: string;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const port = Number(process.env.PORT ?? "3011");
  const dataDir = resolve(overrides.dataDir ?? process.env.DATA_DIR ?? "data");
  const publicBaseUrl =
    overrides.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
  const authSecret =
    overrides.authSecret ??
    process.env.BETTER_AUTH_SECRET ??
    process.env.TASK_MANAGER_AUTH_SECRET ??
    "atm_dev_auth_secret_change_before_production_42";

  return {
    dataDir,
    port: overrides.port ?? port,
    publicBaseUrl,
    sessionTtlDays: overrides.sessionTtlDays ?? 14,
    authSecret
  };
}
