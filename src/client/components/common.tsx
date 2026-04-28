import { CheckCircle2, Copy, type LucideIcon } from "lucide-react";
import { parseUiLanguage, uiLanguageLabels, uiLanguages, type UiLanguage } from "../../shared/i18n";
import { slackPeople } from "../lib/tasks";
import type { OwnerMapping, ResultMessage, Translator } from "../types";

export function LanguageSelect({
  id,
  language,
  t,
  onChange
}: {
  id: string;
  language: UiLanguage;
  t: Translator;
  onChange: (language: UiLanguage) => void;
}) {
  return (
    <label className="language-control" htmlFor={id} aria-label={t("Language")}>
      <span className="sr-only">{t("Language")}</span>
      <select id={id} value={language} onChange={(event) => onChange(parseUiLanguage(event.currentTarget.value))} aria-label={t("Language")}>
        {uiLanguages.map((item) => <option key={item} value={item}>{uiLanguageLabels[item]}</option>)}
      </select>
    </label>
  );
}

export function ResultLine({ result, t }: { result: ResultMessage | null | undefined; t: Translator }) {
  if (!result) return <p className="result" aria-live="polite" />;
  return (
    <p className={`result ${result.ok ? "ok" : "error"}`} aria-live="polite" role="status">
      {t(result.text)}
    </p>
  );
}

export function OwnerOptions({ emptyLabel, people, t }: { emptyLabel: string; people: OwnerMapping[]; t: Translator }) {
  const owners = slackPeople(people);
  return (
    <>
      <option value="">{t(emptyLabel)}</option>
      {owners.map((owner) => (
        <option key={owner.id} value={owner.ownerName}>{owner.ownerName} ({owner.slackUserId})</option>
      ))}
      {!owners.length ? <option value="" disabled>{t("Add Slack users in Settings first")}</option> : null}
    </>
  );
}

export function MetricCard({
  Icon,
  label,
  tone = "",
  value
}: {
  Icon: LucideIcon;
  label: string;
  tone?: string;
  value: number;
}) {
  return (
    <article className={`focus-card ${tone}`}>
      <Icon className="icon" aria-hidden="true" />
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

export function PriorityLine({ color, count, label }: { color: string; count: number; label: string }) {
  return (
    <div>
      <i className={color} />
      <span>{label}</span>
      <strong>{count}</strong>
    </div>
  );
}

export function SettingTile({ label, value, tone, t }: { label: string; value: string; tone: string; t: Translator }) {
  return (
    <div className={`setting-tile ${tone}`}>
      <span>{t(label)}</span>
      <strong>{t(value)}</strong>
    </div>
  );
}

export function CommandBlock({
  command,
  copied,
  id,
  title,
  t,
  onCopy
}: {
  command: string;
  copied: boolean;
  id: string;
  title: string;
  t: Translator;
  onCopy: (id: string, command: string) => void;
}) {
  return (
    <div className="command-card">
      <div className="command-head">
        <h3>{t(title)}</h3>
        <button className="icon-button" type="button" aria-label={t("Copy")} title={t("Copy")} onClick={() => onCopy(id, command)}>
          {copied ? <CheckCircle2 className="icon" aria-hidden="true" /> : <Copy className="icon" aria-hidden="true" />}
          <span className="sr-only">{t(copied ? "Copied" : "Copy")}</span>
        </button>
      </div>
      <pre id={id} className="commands">{command}</pre>
    </div>
  );
}
