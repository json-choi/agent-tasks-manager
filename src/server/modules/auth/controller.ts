import { Elysia } from "elysia";
import type { ServerContext } from "../../context";
import type { AuthUserSession } from "../../services/auth.service";
import { authCookieHeaders } from "../../services/auth.service";
import { asRecord, jsonResponse, stringValue } from "../../shared/utils";

export function authController({ auth, store, requireUser }: ServerContext) {
  return new Elysia({ name: "auth.controller" })
    .all("/api/better-auth/*", ({ request }) => auth.auth.handler(request))
    .get("/api/auth/session", async ({ request }) => {
      const auth = await requireUser(request);
      if ("response" in auth) return auth.response;
      return { user: serializeUser(auth.user), role: auth.user.role, owner: auth.user.owner };
    })
    .post("/api/auth/login", async ({ body }) => {
      const input = asRecord(body);
      const email = stringValue(input.email);
      const password = stringValue(input.password);

      if (!email || !password) {
        return jsonResponse({ error: "Email and password are required" }, 400);
      }

      const response = await auth.auth.api.signInEmail({
        body: { email, password },
        asResponse: true
      });
      if (!response.ok) return jsonResponse({ error: "Invalid credentials" }, 401);

      const payload = await response.json() as {
        user?: { id: string; email: string; name: string; createdAt: string | Date };
      };
      const profile = payload.user ? store.getUserProfile(payload.user.id) : null;
      if (!payload.user || !profile) return jsonResponse({ error: "User profile is not configured" }, 403);
      const owner = profile.ownerId ? store.getOwner(profile.ownerId) : null;
      return jsonResponse({
        admin: profile.role === "owner"
          ? { id: payload.user.id, email: payload.user.email, name: payload.user.name, createdAt: payload.user.createdAt }
          : null,
        user: {
          id: payload.user.id,
          email: payload.user.email,
          name: payload.user.name,
          createdAt: payload.user.createdAt
        },
        role: profile.role,
        owner,
        expiresAt: null
      }, 200, authCookieHeaders(response));
    })
    .post("/api/auth/logout", async ({ request }) => {
      const response = await auth.auth.api.signOut({
        headers: request.headers,
        asResponse: true
      });
      return jsonResponse({ ok: true }, 200, authCookieHeaders(response));
    });
}

function serializeUser(user: AuthUserSession) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt
  };
}
