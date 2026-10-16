import { fragmentKind } from "./changelog.mjs";

export function releasePlan(metadata, fragments, candidate) {
  if (!fragments.length) throw new Error("nothing to release: no new changelog fragments");
  const kinds = fragments.map(fragmentKind);
  const stable = metadata?.["dist-tags"]?.latest ?? "0.0.0";
  if (!/^\d+\.\d+\.\d+$/.test(stable)) throw new Error(`Invalid latest stable version: ${stable}`);
  const parts = stable.split(".").map(Number);
  const level = kinds.includes("breaking") ? 0 : kinds.includes("feature") ? 1 : 2;
  parts[level]++;
  for (let index = level + 1; index < parts.length; index++) parts[index] = 0;
  let version = parts.join(".");
  if (candidate) {
    const prefix = `${version}-rc.`;
    const previous = (metadata?.versions ?? [])
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => Number(entry.slice(prefix.length)))
      .filter(Number.isInteger);
    version += `-rc.${Math.max(0, ...previous) + 1}`;
  }
  if (metadata?.versions?.includes(version))
    throw new Error(`Version ${version} already published`);
  return { version, tag: candidate ? "next" : "latest" };
}
