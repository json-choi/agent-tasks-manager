export function assetContentType(assetPath: string): string {
  if (assetPath.endsWith(".png")) return "image/png";
  if (assetPath.endsWith(".svg")) return "image/svg+xml";
  if (assetPath.endsWith(".jpg") || assetPath.endsWith(".jpeg")) return "image/jpeg";
  if (assetPath.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}
