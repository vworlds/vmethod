import { checkMarkdown } from "../gateway/markdown.js";
import { setHeaderPart, taskRelation, updateTaskMarker } from "./markers.js";
import { TaskCommon } from "./common.js";

/** Promote or demote structured task relations and their Development links. */
export class TaskLink extends TaskCommon {
  /** Backfill Development links; complete promotes, unlink demotes to a partial task. */
  async link(ref: string, complete = false, unlink = false): Promise<string> {
    if (typeof complete !== "boolean" || typeof unlink !== "boolean" || (complete && unlink)) {
      throw new Error("Invalid or conflicting link flags");
    }
    const item = await this.pr(ref);
    if (item.state !== "OPEN") {
      throw new Error("PR is not open");
    }
    let body = String(item.body);
    const relation = taskRelation(body);
    if (!relation) {
      throw new Error("Missing structured task relation");
    }
    if (!relation.issues.length) {
      return `Task #${ref} links already current`;
    }
    if ((complete && relation.part) || (unlink && !relation.part)) {
      relation.part = unlink;
      body = setHeaderPart(body, relation.part);
      body = updateTaskMarker(body, relation.issues, relation.part);
    }
    if (body !== item.body) {
      await checkMarkdown(this.root, body);
    }
    const changed =
      unlink || !relation.part ? await this.closingLinks(item, relation.issues, unlink) : false;
    if (!changed && body === item.body) {
      return `Task #${ref} links already current`;
    }
    if (body !== item.body) {
      // Only structured plan flags change, never reference prose or prompt text.
      await this.host.github.rest(this.path(ref, "pulls"), "PATCH", { body }, false);
    }
    return `${unlink ? "Unlinked" : "Linked"} task #${ref}${complete ? " as completing" : ""}`;
  }
}
