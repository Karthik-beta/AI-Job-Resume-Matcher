const namedEntities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  bull: "•",
};

const codePoint = (value: number) =>
  Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : null;

export const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      return codePoint(Number.parseInt(name.slice(2), 16)) ?? entity;
    }
    if (name.startsWith("#")) return codePoint(Number(name.slice(1))) ?? entity;
    return namedEntities[name.toLowerCase()] ?? entity;
  });

// Enough for job ads from ATS APIs: block elements become line breaks, list items get a dash.
export const htmlToText = (html: string) =>
  decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/?(p|div|ul|ol|h[1-6]|tr|table|section|blockquote)\b[^>]*>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/[ \t\xa0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n+- /g, "\n- ")
    .trim();

const years = "(?:years?|yrs?)";
const rangePattern = new RegExp(
  String.raw`(\d{1,2})\+?\s*(?:-|–|—|to)\s*(\d{1,2})\+?\s*${years}`,
  "i",
);
const atLeastPattern = new RegExp(
  String.raw`(?:at least|minimum(?: of)?|min\.?)\s*(\d{1,2})\+?\s*${years}`,
  "i",
);
const plusPattern = new RegExp(String.raw`(\d{1,2})\s*\+\s*${years}`, "i");

export interface ExperienceBounds {
  readonly experienceMinYears: number | null;
  readonly experienceMaxYears: number | null;
}

const unknownExperience: ExperienceBounds = { experienceMinYears: null, experienceMaxYears: null };

// The first stated requirement wins; a range takes precedence over an open-ended bound.
export const experienceFromText = (text: string): ExperienceBounds => {
  const range = rangePattern.exec(text);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    if (min <= max) return { experienceMinYears: min, experienceMaxYears: max };
  }
  const atLeast = atLeastPattern.exec(text) ?? plusPattern.exec(text);
  if (atLeast) return { experienceMinYears: Number(atLeast[1]), experienceMaxYears: null };
  return unknownExperience;
};

// An ISO timestamp, or null when the value is missing or not a date.
export const isoDate = (value: string | number | null | undefined) => {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
