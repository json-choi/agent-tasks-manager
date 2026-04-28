import { Elysia } from "elysia";
import { existsSync } from "node:fs";
import { htmlResponse } from "../../shared/utils";
import { setupPage } from "./setup.view";

const publicRoot = new URL("../../../../public/", import.meta.url);
const dashboardHtmlUrl = new URL("index.html", publicRoot);
const dashboardBundleUrl = new URL("src/main.js", publicRoot);

export function pagesController() {
  return new Elysia({ name: "pages.controller" })
    .get("/setup", () => htmlResponse(setupPage()))
    .get("/dashboard", () => {
      if (!existsSync(dashboardBundleUrl)) {
        return htmlResponse(missingDashboardBundlePage(), 503);
      }

      const file = Bun.file(dashboardHtmlUrl);
      return new Response(file, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache"
        }
      });
    });
}

function missingDashboardBundlePage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dashboard bundle missing</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7fb; color: #172033; font-family: "Plus Jakarta Sans", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
    main { width: min(560px, calc(100% - 32px)); background: #fff; border: 1px solid #e5eaf1; border-radius: 8px; padding: 24px; box-shadow: 0 20px 48px rgba(16, 24, 40, 0.08); }
    h1 { margin: 0; font-size: 23px; line-height: 1.18; }
    p { color: #667085; line-height: 1.55; }
    code { background: #eef2ff; border-radius: 6px; padding: 2px 6px; }
  </style>
</head>
<body>
  <main>
    <h1>Dashboard bundle is missing.</h1>
    <p>The dashboard client has not been built yet. Run <code>bun run build:client</code>, then restart ATM.</p>
  </main>
</body>
</html>`;
}
