import { Elysia } from "elysia";
import { htmlResponse } from "../../shared/utils";
import { setupPage } from "./setup.view";

export function pagesController() {
  return new Elysia({ name: "pages.controller" })
    .get("/setup", () => htmlResponse(setupPage()))
    .get("/dashboard", () => {
      const file = Bun.file(new URL("../../../../public/index.html", import.meta.url));
      return new Response(file, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache"
        }
      });
    });
}
