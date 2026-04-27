import { Elysia } from "elysia";
import { loadConfig, type AppConfig } from "./config/app-config";
import { TaskStore } from "./repositories/task-store.repository";
import type { Runtime } from "./context";
import { createServerContext } from "./context";
import { agentApiController } from "./modules/agent-api/controller";
import { authController } from "./modules/auth/controller";
import { integrationsController } from "./modules/integrations/controller";
import { pagesController } from "./modules/pages/controller";
import { settingsController } from "./modules/settings/controller";
import { setupController } from "./modules/setup/controller";
import { systemController } from "./modules/system/controller";
import { tasksController } from "./modules/tasks/controller";
import { fullstackStaticPlugin } from "./plugins/fullstack-static.plugin";
import { createAuthService } from "./services/auth.service";

export async function createRuntime(overrides: Partial<AppConfig> = {}): Promise<Runtime> {
  const config = loadConfig(overrides);
  const store = new TaskStore(config.dataDir);
  const auth = createAuthService(config, store);
  const context = createServerContext(config, store, auth);
  const app = new Elysia()
    .use(await fullstackStaticPlugin())
    .use(systemController(context))
    .use(pagesController())
    .use(setupController(context))
    .use(authController(context))
    .use(tasksController(context))
    .use(settingsController(context))
    .use(integrationsController(context))
    .use(agentApiController(context));

  return { app, config, store };
}
