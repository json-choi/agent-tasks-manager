import { Elysia } from "elysia";
import type { ServerContext } from "../../context";
import { assetContentType } from "../../shared/asset";
import { jsonResponse } from "../../shared/utils";

export function systemController({ store }: ServerContext) {
  return new Elysia({ name: "system.controller" })
    .get("/", ({ request }) => {
      const target = store.isSetupLocked() ? "/dashboard" : "/setup";
      return Response.redirect(new URL(target, request.url).toString(), 302);
    })
    .get("/health", () => ({
      ok: true,
      service: "task-manager-core",
      time: new Date().toISOString()
    }))
    .get("/ready", () => {
      const storage = store.storageHealth();
      return jsonResponse({
        ok: storage.ok,
        setupLocked: store.isSetupLocked(),
        storage
      }, storage.ok ? 200 : 503);
    })
    .get("/assets/*", async ({ params }) => {
      const assetPath = String(params["*"] ?? "");
      if (!assetPath || assetPath.includes("..") || assetPath.startsWith("/")) {
        return new Response("Not found", { status: 404 });
      }
      const file = Bun.file(new URL(`../../../../assets/${assetPath}`, import.meta.url));
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      return new Response(file, {
        headers: {
          "content-type": assetContentType(assetPath),
          "cache-control": "public, max-age=86400"
        }
      });
    });
}
