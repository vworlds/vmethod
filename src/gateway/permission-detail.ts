import { object } from "./people.js";

/** Only permission type and target are diagnostic data, never metadata or authority.
 * V2 uses action/resources; older servers use type/pattern. Each request is
 * terminal-safe and capped at 200 characters, including any truncation marker. */
export function permissionDetails(requests: unknown[], redact: (text: string) => string): string[] {
  return requests.map((value) => {
    const request = object(value);
    const type = request.action ?? request.type ?? "unknown";
    const target = request.resources ?? request.pattern;
    return boundedPermission(
      redact(
        `${typeof type === "string" ? type : "unknown"}${target === undefined ? "" : `: ${JSON.stringify(target)}`}`
      )
    );
  });
}

/** Mark every request separately; safe in a single-line WORKER event or status. */
export function renderPermissions(details: readonly string[] = []): string {
  return details.map((detail) => ` untrusted permission: «${boundedPermission(detail)}»`).join("");
}

function boundedPermission(text: string): string {
  // Unicode escaping keeps terminal controls and line breaks inert, even in a type.
  const safe = text
    .replace(
      // eslint-disable-next-line no-control-regex -- escape terminal control characters
      /[\u0000-\u001f\u007f-\u009f]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
    )
    .replace(/\p{Cf}/gu, "")
    .replace(/«/g, "‹")
    .replace(/»/g, "›");
  return safe.length > 200 ? safe.slice(0, 199) + "…" : safe;
}
