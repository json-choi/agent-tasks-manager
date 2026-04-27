import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import type { AppConfig } from "../config/app-config";
import type { TaskStore } from "../repositories/task-store.repository";

export interface AdminSession {
  id: string;
  email: string;
  name: string;
  createdAt: Date | string;
}

export interface AuthService {
  auth: {
    handler(request: Request): Response | Promise<Response>;
    api: {
      getSession(input: { headers: Headers }): Promise<{ user?: { id: string; email: string; name: string; createdAt: Date | string } } | null>;
      signInEmail(input: { body: { email: string; password: string }; asResponse: true }): Promise<Response>;
      signUpEmail(input: { body: { email: string; password: string; name: string }; asResponse: true }): Promise<Response>;
      signOut(input: { headers: Headers; asResponse: true }): Promise<Response>;
    };
  };
  getAdmin(request: Request): Promise<AdminSession | null>;
}

export function createAuthService(config: AppConfig, store: TaskStore): AuthService {
  const auth = betterAuth({
    baseURL: config.publicBaseUrl,
    basePath: "/api/better-auth",
    database: store.db,
    secret: config.authSecret,
    emailAndPassword: {
      enabled: true
    },
    session: {
      expiresIn: config.sessionTtlDays * 24 * 60 * 60
    },
    disabledPaths: ["/sign-up/email"],
    plugins: [bearer()]
  });

  return {
    auth,
    async getAdmin(request: Request) {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session?.user) return null;
      return {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        createdAt: session.user.createdAt
      };
    }
  };
}

export function authCookieHeaders(response: Response): HeadersInit {
  const setCookie = response.headers.get("set-cookie");
  return setCookie ? { "set-cookie": setCookie } : {};
}
