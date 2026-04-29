import type { AnyElysia } from "elysia";
import type { AppConfig } from "./config/app-config";
import type { TaskStore } from "./repositories/task-store.repository";
import type { AdminSession, AuthService, AuthUserSession } from "./services/auth.service";
import type { AgentSettings } from "./shared/types";
import { jsonResponse, parseBearer } from "./shared/utils";

export interface Runtime {
  app: AnyElysia;
  auth: AuthService;
  config: AppConfig;
  store: TaskStore;
}

export type AdminAuthResult = { admin: AdminSession } | { response: Response };

export type UserAuthResult = { user: AuthUserSession } | { response: Response };

export type AgentAuthResult = { agent: AgentSettings } | { response: Response };

export interface ServerContext {
  config: AppConfig;
  store: TaskStore;
  auth: AuthService;
  getUser(request: Request): Promise<AuthUserSession | null>;
  requireUser(request: Request): Promise<UserAuthResult>;
  requireAdmin(request: Request): Promise<AdminAuthResult>;
  requireAgent(request: Request): AgentAuthResult;
}

export function createServerContext(config: AppConfig, store: TaskStore, auth: AuthService): ServerContext {
  const getUser = (request: Request) => auth.getUser(request);

  const requireUser = async (request: Request): Promise<UserAuthResult> => {
    const user = await getUser(request);
    if (!user) return { response: jsonResponse({ error: "Authentication required" }, 401) };
    return { user };
  };

  const requireAdmin = async (request: Request): Promise<AdminAuthResult> => {
    const user = await getUser(request);
    if (!user) return { response: jsonResponse({ error: "Admin authentication required" }, 401) };
    if (user.role !== "owner") return { response: jsonResponse({ error: "Owner access required" }, 403) };
    return { admin: { ...user, role: "owner" } };
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
    getUser,
    requireUser,
    requireAdmin,
    requireAgent
  };
}
