const fallbackMs = 61_000;
// One extra second, as in the Python scraper, so the retry lands after the limit resets.
const marginMs = 1_000;
const secondsPattern = /^-?\d+(\.\d+)?$/;

export const retryAfterMs = (header: string | null | undefined, now: number = Date.now()) => {
  const value = header?.trim();
  if (!value) return fallbackMs;
  if (secondsPattern.test(value)) return Math.max(0, Number(value) * 1000) + marginMs;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return fallbackMs;
  return Math.max(0, date - now) + marginMs;
};
