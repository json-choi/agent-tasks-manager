import type { GitHubRule } from "../types";

export function formPayload(form: HTMLFormElement) {
  return Object.fromEntries(new FormData(form).entries()) as Record<string, unknown>;
}

export function checked(form: HTMLFormElement, name: string) {
  return Boolean((form.elements.namedItem(name) as HTMLInputElement | null)?.checked);
}

export function formField(form: HTMLFormElement, name: string) {
  const item = form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  return item?.value ?? "";
}

export function splitList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function parseGitHubRules(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [repo = "", projectLabel = "", initiativeIncludes = "", codeIndicators = ""] = line.split("|").map((part) => part.trim());
    return {
      repo,
      ...(projectLabel ? { projectLabel } : {}),
      ...(initiativeIncludes ? { initiativeIncludes: splitList(initiativeIncludes) } : {}),
      ...(codeIndicators ? { codeIndicators: splitList(codeIndicators) } : {})
    };
  }).filter((rule) => rule.repo);
}

export function parseKeyValueLines(value: string) {
  return Object.fromEntries(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [key = "", ...rest] = line.split("=");
    return [key.trim(), rest.join("=").trim()];
  }).filter(([key, val]) => Boolean(key && val)));
}

export function ruleToLine(rule: GitHubRule) {
  return [rule.repo, rule.projectLabel || "", (rule.initiativeIncludes || []).join(","), (rule.codeIndicators || []).join(",")]
    .join(" | ")
    .replace(/\s+\|\s+\|\s+\|$/, "");
}
