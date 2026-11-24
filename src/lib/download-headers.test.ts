import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { buildContentDisposition } from "./services/storage.ts";

// A header value may only hold Latin-1, and `new Response` throws on
// anything else. A file name taken from an envelope's title can hold any
// character, so it has to go through buildContentDisposition.

const titles = ["NDA — Acme", "Mary’s lease", "合同", "Résumé"];

test("a file name with any character gives a header a response accepts", () => {
  for (const title of titles) {
    const fileName = `${title}-audit-trail.csv`;
    const value = buildContentDisposition(fileName);
    const response = new Response("", {
      headers: { "content-disposition": value },
    });

    assert.equal(response.headers.get("content-disposition"), value);
    assert.match(value, /^attachment; filename="[\x20-\x7e]*"; filename\*=/);
    assert.ok(
      value.endsWith(`filename*=UTF-8''${encodeURIComponent(fileName)}`),
      value,
    );
  }
});

test("writing such a name into the header by hand throws", () => {
  assert.throws(
    () =>
      new Response("", {
        headers: {
          "content-disposition": `attachment; filename="合同-audit-trail.csv"`,
        },
      }),
  );
});

test("no route writes a computed file name into a header by hand", () => {
  const apiRoot = path.resolve(import.meta.dirname, "..", "app", "api");
  const routes = globSync("**/route.ts", { cwd: apiRoot });

  assert.ok(routes.length > 0, "found no route files to check");

  for (const route of routes) {
    const source = readFileSync(path.join(apiRoot, route), "utf8");

    for (const line of source.split("\n")) {
      if (/filename="\$\{/.test(line)) {
        assert.fail(`${route} builds a file name by hand: ${line.trim()}`);
      }
    }
  }
});
