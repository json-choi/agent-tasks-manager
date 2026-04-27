import { createRuntime } from "./app";

const runtime = await createRuntime();

runtime.app.listen(runtime.config.port);

console.log(`task-manager-core listening on ${runtime.config.publicBaseUrl}`);
console.log(`data dir: ${runtime.config.dataDir}`);

process.on("SIGINT", () => {
  runtime.store.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  runtime.store.close();
  process.exit(0);
});
