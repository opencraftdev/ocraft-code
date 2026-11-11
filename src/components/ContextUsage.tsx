import type { ConversationContext } from "../lib/conversationContext.ts";
import { useT } from "../lib/i18n.ts";

const formatContextTokens = (value: number): string => value >= 1e6 ? `${(value / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })}M` : value >= 1e3 ? `${(value / 1e3).toLocaleString(undefined, { maximumFractionDigits: 1 })}k` : value.toLocaleString();

/** Reported categories, or an accurate aggregate when this agent reports only a total. */
export function ContextUsage({ context }: { context: ConversationContext | null }) {
  const t = useT();
  if (!context) return <p>{t("Context usage has not been reported for this session.")}</p>;
  const { used, window, breakdown } = context;
  const percent = window === null ? null : Math.min(100, used / window * 100);
  const labels = { messages: t("Messages"), tools: t("System tools"), skills: t("Skills"), system: t("System prompt"), memory: t("Memory files"), update: t("Since last update"), buffer: t("Autocompact buffer"), free: t("Free space"), used: t("Context used"), remaining: t("Remaining capacity") };
  const rows = breakdown ?? [{ category: "used" as const, tokens: used }, ...(window === null ? [] : [{ category: "remaining" as const, tokens: Math.max(0, window - used) }])];
  return <>
    <div className="context-usage-total"><span>{percent === null ? t("Context used") : t("{percent}% used", { percent: Math.round(percent) })}</span><span title={`${used.toLocaleString()} / ${window?.toLocaleString() ?? t("Not reported")}`}>{formatContextTokens(used)}{window !== null && ` / ${formatContextTokens(window)}`}</span></div>
    {percent !== null && <div className="context-usage-bar" role="meter" aria-label={t("Context used")} aria-valuemin={0} aria-valuemax={window!} aria-valuenow={Math.min(used, window!)}>{rows.map(row => <span key={row.category} className={`context-category-${row.category}`} style={{ width: `${Math.min(100, row.tokens / window! * 100)}%` }} />)}</div>}
    <table className="context-usage-table"><caption className="visually-hidden">{t("Context used")}</caption><thead className="visually-hidden"><tr><th>{t("Category")}</th><th>{t("Tokens")}</th><th>{t("Percentage")}</th></tr></thead><tbody>{rows.map(row => <tr key={row.category}><th scope="row"><span className={`context-usage-swatch context-category-${row.category}`} aria-hidden="true" />{labels[row.category]}</th><td title={row.tokens.toLocaleString()}>{formatContextTokens(row.tokens)}</td><td>{window === null ? t("Not reported") : `${(row.tokens / window * 100).toFixed(1)}%`}</td></tr>)}</tbody></table>
    <p>{t(breakdown ? "Last reported by the agent." : "This agent has not reported a category breakdown.")}</p>
  </>;
}
