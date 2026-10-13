const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

// "3 hours ago", "in 20 minutes", "yesterday".
export function formatRelative(date: string | Date, now = Date.now()) {
  const diff = new Date(date).getTime() - now;
  for (const [unit, ms] of units) {
    if (Math.abs(diff) >= ms) return format.format(Math.round(diff / ms), unit);
  }
  return diff > 0 ? "in less than a minute" : "just now";
}
