import { parseTaskCategory } from "../shared/parsers";
import type { GitHubSettings, TaskCategory } from "../shared/types";

const defaultCodeIndicators = [
  "api",
  "backend",
  "bug",
  "build",
  "ci",
  "code",
  "coding",
  "database",
  "db",
  "deploy",
  "frontend",
  "github",
  "implement",
  "migration",
  "pr",
  "refactor",
  "repo",
  "repository",
  "test",
  "코드",
  "구현",
  "버그",
  "배포",
  "백엔드",
  "프론트",
  "리팩터",
  "리팩토링",
  "마이그레이션",
  "테스트"
];

export function inferTaskCategory(
  input: {
    category?: unknown;
    title?: string | null;
    description?: string | null;
    initiative?: string | null;
    githubRef?: string | null;
  },
  settings?: GitHubSettings
): TaskCategory {
  if (input.githubRef) return "coding";
  const explicit = parseTaskCategory(input.category);
  if (explicit) return explicit;

  const text = normalize(`${input.title ?? ""} ${input.description ?? ""} ${input.initiative ?? ""}`);
  if (!text) return "general";

  const ruleIndicators = settings?.rules.flatMap((rule) => rule.codeIndicators ?? []) ?? [];
  const indicators = [...defaultCodeIndicators, ...ruleIndicators].map(normalize).filter(Boolean);
  if (indicators.some((indicator) => text.includes(indicator))) return "coding";

  const initiative = normalize(input.initiative ?? "");
  const initiativeRules = settings?.rules.flatMap((rule) => rule.initiativeIncludes ?? []) ?? [];
  if (initiative && initiativeRules.map(normalize).filter(Boolean).some((needle) => initiative.includes(needle))) {
    return "coding";
  }

  return "general";
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
