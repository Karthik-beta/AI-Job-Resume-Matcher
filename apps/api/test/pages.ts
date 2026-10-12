// Markdown of careers pages, as Firecrawl returns their main content.
export const pageFixture = (name: string) =>
  Bun.file(new URL(`./fixtures/pages/${name}`, import.meta.url)).text();
