/** The complete banner emitted by open-task --hold; quoted prose is not a hold. */
export const holdBanner = "> ⛔ ON HOLD. Wait for [orchestrator] GO.";

const bannerLine = /^> ⛔ ON HOLD\. Wait for \[orchestrator\] GO\.(?:\r?\n|$)/m;
const titlePrefix = /^\[HOLD(?::[^\]\r\n]*)?\](?:[\t ]+|$)/i;

/** Remove only machine hold markers, retaining the rest of the title and prompt. */
export function withoutHold(title: string, body: string): { title: string; body: string } {
  return { title: title.replace(titlePrefix, ""), body: body.replace(bannerLine, "") };
}

/** Legacy title prefixes also count, but mentions elsewhere do not. */
export function taskHeld(title: string, body: string): boolean {
  return titlePrefix.test(title) || bannerLine.test(body);
}
