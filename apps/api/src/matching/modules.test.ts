import { expect, test } from "bun:test";

// Coverage only reports files a test loads, so this keeps every matching module, including
// a new one without tests, under the coverage threshold.
test("every matching module is loaded under coverage", async () => {
  const files = [...new Bun.Glob("**/*.ts").scanSync(import.meta.dir)].filter(
    (file) => !file.endsWith(".test.ts"),
  );
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) await import(`./${file}`);
});
