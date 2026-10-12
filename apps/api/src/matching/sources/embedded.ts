import { type DetectedSource, detectSource } from "./detect";
import { decodeEntities } from "./text";

// URLs on the supported ATS hosts, including protocol-relative script and iframe sources.
const atsUrlPattern =
  /(?:https?:)?\/\/[a-z0-9.-]+\.(?:greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|recruitee\.com)(?:[/?#][^\s"'<>\\]*)?/gi;

const absolute = (url: string) => (url.startsWith("//") ? `https:${url}` : url);

// The first ATS board a careers page embeds or links to, from its links and then its HTML.
export const detectEmbeddedBoard = (
  html: string,
  links: readonly string[],
): DetectedSource | null => {
  const inHtml = [...decodeEntities(html).matchAll(atsUrlPattern)].map(([url]) => absolute(url));
  for (const url of [...links, ...inHtml]) {
    const detected = detectSource(url);
    if (detected.kind !== "PAGE") return detected;
  }
  return null;
};
