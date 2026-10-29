import { expect, test } from "vitest";
import { ownerAgreement } from "../../src/evidence/owner-agreement.js";
import { Digest } from "../../src/gateway/digest.js";
import { PeopleFilter, type ObjectData } from "../../src/gateway/people.js";
import { actor, people } from "../gateway/helpers.js";
import { scopeComment } from "../gateway/scope-fixture.js";
import { fixture } from "../helpers.js";

test.each([
  ["owner", {}, true],
  ["owner edit", { lastEditedAt: "2026-01-03T00:00:00Z", editor: actor() }, true],
  [
    "owner effective author",
    { author: actor(2), lastEditedAt: "2026-01-03T00:00:00Z", editor: actor() },
    true,
  ],
  ["foreign editor", { lastEditedAt: "2026-01-03T00:00:00Z", editor: actor(2) }, false],
  ["missing editor", { lastEditedAt: "2026-01-03T00:00:00Z", editor: null }, false],
  ["spoofed owner", { author: { ...actor(), databaseId: 99999 } }, false],
  ["other thread", { issue: { number: 28 } }, false],
  ["PR comment", { issue: null, pullRequest: { number: 27 } }, true],
  ["other repo", { repository: { nameWithOwner: "example/other" } }, false],
  ["before summons", { createdAt: "2025-01-01T00:00:00Z" }, false],
  ["missing time", { createdAt: null }, false],
  ["changed current quote", { body: "No, do not proceed." }, false],
] as [string, ObjectData, boolean][])("agreement validates %s", (_name, overrides, valid) => {
  const filter = new PeopleFilter(
    people,
    "example",
    new Digest({ XDG_STATE_HOME: fixture() }, "agreement", () => 0)
  );
  const url = "https://github.com/example/project/pull/27#issuecomment-123";
  const comment = scopeComment({
    author: actor(),
    url,
    issue: { number: 27 },
    body: "Yes, proceed.\nUse the revised flow.",
    ...overrides,
  });
  expect(
    ownerAgreement(
      comment,
      filter,
      "example/project",
      "27",
      url,
      Date.parse("2026-01-01T00:00:00Z"),
      "> Yes, proceed.\n> Use the revised flow.\n\nI attest that this is agreement."
    )
  ).toBe(valid);
  expect(
    ownerAgreement(
      comment,
      filter,
      "example/project",
      "27",
      url,
      Date.parse("2026-01-01T00:00:00Z"),
      "Yes, proceed."
    )
  ).toBe(false);
  expect(
    ownerAgreement(comment, filter, "example/project", "27", url + "?spoof", 0, "> Yes, proceed.")
  ).toBe(false);
});
