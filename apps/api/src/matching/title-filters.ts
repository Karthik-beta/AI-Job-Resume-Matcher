export interface TitleFilters {
  // A title must contain one of these, when there are any.
  readonly include: readonly string[];
  // A title must contain none of these.
  readonly exclude: readonly string[];
}

export const noTitleFilters: TitleFilters = { include: [], exclude: [] };

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The keyword as whole words, in any case, with any whitespace between a phrase's words.
const wholeWords = (keyword: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}_])${keyword.trim().split(/\s+/).map(escapeRegExp).join("\\s+")}(?![\\p{L}\\p{N}_])`,
    "iu",
  );

const mentionsAny = (keywords: readonly string[], title: string) =>
  keywords.some((keyword) => keyword.trim() !== "" && wholeWords(keyword).test(title));

export const acceptsTitle = ({ include, exclude }: TitleFilters, title: string) =>
  (include.length === 0 || mentionsAny(include, title)) && !mentionsAny(exclude, title);

// Lowercased, sorted and unique, for the context key.
export const canonicalTitleFilters = ({ include, exclude }: TitleFilters): TitleFilters => {
  const canonical = (keywords: readonly string[]) =>
    [...new Set(keywords.map((keyword) => keyword.trim().toLowerCase()))]
      .filter((keyword) => keyword !== "")
      .sort();
  return { include: canonical(include), exclude: canonical(exclude) };
};
