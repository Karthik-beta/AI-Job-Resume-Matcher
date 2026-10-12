import { expect, test } from "bun:test";
import { fetchListings } from "../../../test/ats";
import { adapterFor } from "./registry";

test("fails a search source until search is supported", async () => {
  const source = { url: "https://example.com", kind: "SEARCH", adapterKey: null } as const;
  const { result } = await fetchListings(adapterFor("SEARCH"), source, {});
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { message: "Search sources are not supported yet." },
  });
});
