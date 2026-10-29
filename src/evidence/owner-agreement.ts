import { object, type ObjectData, type PeopleFilter } from "../gateway/people.js";
import { repoOf } from "../github/diagnostic.js";

/** Validate the current, effectively owner-authored comment and an exact block quotation.
 * The caller's flag attests that the quoted words constitute agreement; we never infer
 * agreement from arbitrary prose. URLs and creation times bind it to this summons.
 */
export function ownerAgreement(
  comment: ObjectData,
  filter: PeopleFilter,
  repo: string,
  ref: string,
  url: string,
  since: number,
  handback: string
): boolean {
  const match =
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/([1-9]\d*)#issuecomment-([1-9]\d*)$/.exec(
      url
    );
  const author = filter.identity(comment.lastEditedAt == null ? comment.author : comment.editor);
  const created = Date.parse(String(comment.createdAt));
  if (
    !match ||
    match[1] !== repo ||
    match[2] !== ref ||
    comment.url !== url ||
    repoOf(comment).repo !== repo ||
    author?.role !== "owner" ||
    !Number.isFinite(since) ||
    !Number.isFinite(created) ||
    created <= since ||
    typeof comment.body !== "string" ||
    (comment.lastEditedAt != null && !Number.isFinite(Date.parse(String(comment.lastEditedAt))))
  ) {
    return false;
  }
  if (
    object(comment.issue).number !== Number(ref) &&
    object(comment.pullRequest).number !== Number(ref)
  ) {
    return false;
  }
  const quotes = [...handback.matchAll(/(?:^>[^\n]*(?:\n|$))+/gm)]
    .map((quote) =>
      quote[0]
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => line.replace(/^> ?/, ""))
        .join("\n")
        .trim()
    )
    .filter(Boolean);
  return quotes.some((quote) => String(comment.body).includes(quote));
}
