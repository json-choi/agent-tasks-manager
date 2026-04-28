import type { AnyElysia } from "elysia";
import type { AppConfig } from "./config/app-config";
import type { TaskStore } from "./repositories/task-store.repository";
import type { AdminSession, AuthService } from "./services/auth.service";
import type { AgentSettings } from "./shared/types";
import { jsonResponse, parseBearer } from "./shared/utils";

export interface Runtime {
  app: AnyElysia;
  auth: AuthService;
  config: AppConfig;
  store: TaskStore;
}

export type AdminAuthResult = { admin: AdminSession } | { response: Response };

export type AgentAuthResult = { agent: AgentSettings } | { response: Response };

export interface ServerContext {
  config: AppConfig;
  store: TaskStore;
  auth: AuthService;
  getAdmin(request: Request): Promise<AdminSession | null>;
  requireAdmin(request: Request): Promise<AdminAuthResult>;
  requireAgent(request: Request): AgentAuthResult;
}

export function createServerContext(config: AppConfig, store: TaskStore, auth: AuthService): ServerContext {
  const getAdmin = (request: Request) => auth.getAdmin(request);

  const requireAdmin = async (request: Request): Promise<AdminAuthResult> => {
    const admin = await getAdmin(request);
    if (!admin) return { response: jsonResponse({ error: "Admin authentication required" }, 401) };
    return { admin };
  };

  const requireAgent = (request: Request): AgentAuthResult => {
    const agentId = request.headers.get("x-agent-id")?.trim();
    const token = parseBearer(request) ?? request.headers.get("x-agent-token")?.trim() ?? null;
    if (!agentId || !token) {
      return { response: jsonResponse({ error: "Agent id and token are required" }, 401) };
    }

    const agent = store.getAgentForAuth(agentId, token);
    if (!agent) return { response: jsonResponse({ error: "Invalid agent credentials" }, 401) };
    return { agent };
  };

  return {
    config,
    store,
    auth,
    getAdmin,
    requireAdmin,
    requireAgent
  };
}
