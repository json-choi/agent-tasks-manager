import { staticPlugin } from "@elysiajs/static";

export async function fullstackStaticPlugin() {
  return staticPlugin({
    assets: "public",
    prefix: "/dashboard",
    bunFullstack: false,
    indexHTML: false,
    maxAge: process.env.NODE_ENV === "production" ? 86400 : 0,
    directive: process.env.NODE_ENV === "production" ? "public" : "no-cache",
    headers: {
      "x-content-type-options": "nosniff"
    }
  });
}
