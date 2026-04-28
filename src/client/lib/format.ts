export function display(value: unknown) {
  return value === null || value === undefined ? "" : String(value);
}

export function displayBoolean(value: boolean) {
  return value ? "yes" : "no";
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}

export function relativeTime(value: string) {
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff)) return "";
  const minutes = Math.max(0, Math.round(diff / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
