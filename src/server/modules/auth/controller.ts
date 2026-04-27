import { Elysia } from "elysia";
import type { ServerContext } from "../../context";
import { authCookieHeaders } from "../../services/auth.service";
import { asRecord, jsonResponse, stringValue } from "../../shared/utils";

export function authController({ auth }: ServerContext) {
  return new Elysia({ name: "auth.controller" })
    .all("/api/better-auth/*", ({ request }) => auth.auth.handler(request))
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
        token?: string;
        user?: { id: string; email: string; name: string; createdAt: string | Date };
      };
      return jsonResponse({
        admin: payload.user
          ? { id: payload.user.id, email: payload.user.email, name: payload.user.name, createdAt: payload.user.createdAt }
          : null,
        token: payload.token,
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
