import { betterAuth } from "better-auth";
import type { AppConfig } from "../config/app-config";
import type { TaskStore } from "../repositories/task-store.repository";
import type { OwnerMapping, UserProfile } from "../shared/types";

export interface AuthUserSession {
  id: string;
  email: string;
  name: string;
  createdAt: Date | string;
  role: UserProfile["role"];
  profile: UserProfile;
  owner: OwnerMapping | null;
}

export type AdminSession = AuthUserSession & { role: "owner" };

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
  getUser(request: Request): Promise<AuthUserSession | null>;
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
    disabledPaths: ["/sign-up/email"]
  });

  const getUser = async (request: Request): Promise<AuthUserSession | null> => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return null;
    const profile = store.getUserProfile(session.user.id);
    if (!profile) return null;
    const owner = profile.ownerId ? store.getOwner(profile.ownerId) : null;
    return {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      createdAt: session.user.createdAt,
      role: profile.role,
      profile,
      owner
    };
  };

  return {
    auth,
    getUser
  };
}

export function authCookieHeaders(response: Response): HeadersInit {
  const setCookie = response.headers.get("set-cookie");
  return setCookie ? { "set-cookie": setCookie } : {};
}
