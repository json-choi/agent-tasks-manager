import { createRuntime } from "./app";
import { bootstrapFromEnv } from "./services/bootstrap.service";

const runtime = await createRuntime();

runtime.app.listen(runtime.config.port);

console.log(`task-manager-core listening on ${runtime.config.publicBaseUrl}`);
console.log(`data dir: ${runtime.config.dataDir}`);

const bootstrap = await bootstrapFromEnv(runtime);
if (bootstrap.enabled) {
  console.log(`bootstrap admin: ${bootstrap.admin.status} - ${bootstrap.admin.message}`);
  console.log(`bootstrap openclaw: ${bootstrap.openclaw.status} - ${bootstrap.openclaw.message}`);
  if (bootstrap.openclaw.envPath) console.log(`bootstrap openclaw env: ${bootstrap.openclaw.envPath}`);
  if (!bootstrap.ok) console.warn(`bootstrap completed with ${bootstrap.errors.length} error(s).`);
}

process.on("SIGINT", () => {
  runtime.store.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  runtime.store.close();
  process.exit(0);
});
