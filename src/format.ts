export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function visibleWidth(value: string): number {
  return stripAnsi(value).length;
}

function leadingAnsi(value: string): string {
  return value.match(/^(?:\u001b\[[0-?]*[ -/]*[@-~])+/)?.[0] ?? "";
}

function trailingAnsi(value: string): string {
  return value.match(/(?:\u001b\[[0-?]*[ -/]*[@-~])+$/)?.[0] ?? "";
}

export function truncateToWidth(value: string, width: number, ellipsis = "..."): string {
  if (visibleWidth(value) <= width) return value;
  if (width <= 0) return "";
  const plain = stripAnsi(value);
  if (width <= ellipsis.length) return ellipsis.slice(0, width);
  return `${leadingAnsi(value)}${plain.slice(0, Math.max(0, width - ellipsis.length))}${ellipsis}${trailingAnsi(value)}`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}
