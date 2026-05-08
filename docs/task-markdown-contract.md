# ATM Task Markdown Contract

ATM task Markdown files are generated projections of task rows stored in SQLite. The database is the source of truth; task files are rewritten after task creation and every task update. Current code does not parse these Markdown files back into SQLite.

## Location and File Name

Task files are written below the configured tasks directory:

```text
data/tasks/YYYY/MM/task_<id>.md
```

The year and month are taken from the task creation timestamp. The file name is `task_` followed by the generated task id and `.md`.

## Document Shape

Every task document has YAML frontmatter, a blank line, an H1 matching the task title, another blank line, and the task description.

```md
---
id: "task_example"
title: "Write launch checklist"
status: "confirmed"
priority: "P2"
category: "general"
assignee: null
reporter: null
notify: true
initiative: null
next_action: null
result: null
github_ref: null
channel_id: null
thread_ts: null
source_agent_id: null
source_agent_name: null
source_author: null
source_url: null
due_at: null
created_at: "2026-05-08T00:00:00.000+09:00"
updated_at: "2026-05-08T00:00:00.000+09:00"
confirmed_at: "2026-05-08T00:00:00.000+09:00"
dedupe_key: null
---

# Write launch checklist

Prepare the initial rollout checklist.
```

If the description is empty, the body is `_No description provided._`.

## YAML Formatting Rules

- Strings are serialized with `JSON.stringify`, so they are double-quoted and escaped as JSON string literals.
- `null` values are rendered as the plain scalar `null`.
- Booleans are rendered as the plain scalars `true` or `false`.
- Field order is fixed and follows the table below.
- Frontmatter keys use snake case even when the API and TypeScript task object use camel case.
- The Markdown H1 uses the raw task title, not YAML escaping.
- The Markdown body uses the raw task description, or `_No description provided._` when the description is empty.

## Frontmatter Fields

| Field | Required in file | Allowed values / format | Create default | Notes |
| --- | --- | --- | --- | --- |
| `id` | Yes | Generated task id string | Generated with `task` prefix | Primary task identifier. |
| `title` | Yes | Non-empty string | Required by task creation API and store callers | Also rendered as the H1. |
| `status` | Yes | `proposed`, `confirmed`, `assigning`, `in_progress`, `blocked`, `review_needed`, `done`, `cancelled` | Store default is `proposed`; dashboard create default is `confirmed` | `confirmed_at` is set when a task is created as `confirmed`, or first updated to `confirmed` or `in_progress`. |
| `priority` | Yes | `P0`, `P1`, `P2` | `P2` | Invalid API values are rejected or ignored by parser callers before store writes. |
| `category` | Yes | `general`, `coding` | `general` | API creation may infer `coding` from GitHub settings or a GitHub ref. |
| `assignee` | Yes | Owner name string or `null` | `null` | ATM supports one assignee per task. Dashboard APIs require selected active Slack owners for non-null values. |
| `reporter` | Yes | Owner name/source string or `null` | `null` | Dashboard APIs validate non-null reporter values against active Slack owners; agent proposals may use Slack author id/name. |
| `notify` | Yes | Boolean | `true` | Stored as integer in SQLite and rendered as boolean. |
| `initiative` | Yes | String or `null` | `null` | Optional grouping/context. |
| `next_action` | Yes | String or `null` | `null` | API field is `nextAction`. Members may update this field. |
| `result` | Yes | String or `null` | `null` | Members may update this field. |
| `github_ref` | Yes | String or `null` | `null` | API field is `githubRef`; setting a GitHub ref can imply `coding` category. |
| `channel_id` | Yes | Slack channel id string or `null` | `null` | Set for agent-created Slack tasks. |
| `thread_ts` | Yes | Slack thread timestamp string or `null` | `null` | Set for agent-created Slack tasks when available. |
| `source_agent_id` | Yes | Agent id string or `null` | `null` | Set for agent-created tasks. |
| `source_agent_name` | Yes | Agent name string or `null` | `null` | Set for agent-created tasks. |
| `source_author` | Yes | Slack/source author string or `null` | `null` | Usually Slack author id or name for agent proposals. |
| `source_url` | Yes | URL string or `null` | `null` | Original source permalink when available. |
| `due_at` | Yes | String or `null` | `null` | API field is `dueAt`; stored as provided by callers. |
| `created_at` | Yes | ISO timestamp string | Current time at create | Immutable after create. |
| `updated_at` | Yes | ISO timestamp string | Current time at create | Rewritten on every update. |
| `confirmed_at` | Yes | ISO timestamp string or `null` | Current time only when created with `confirmed`; otherwise `null` | First set on transition to `confirmed` or `in_progress`; approving an unassigned candidate to `review_needed` keeps it `null`. |
| `dedupe_key` | Yes | String or `null` | `null` | Unique in SQLite when present. Slack taskification uses this to prevent duplicate candidate tasks. |

## Compatibility Rules for New Integrations

- Preserve all existing frontmatter keys, order, scalar formatting, H1 placement, and body fallback.
- Persist candidate tasks through the existing task store so Markdown is generated by the same renderer.
- Use `proposed` or `assigning` for pre-approval Slack candidates; activate by updating existing tasks instead of rewriting files directly.
- Keep `dedupe_key` stable for Slack candidates so repeated collection or manual retries reuse the existing task.
- Do not add multi-assignee data to the task frontmatter; split multi-mention work into separate single-assignee task candidates before persistence.
