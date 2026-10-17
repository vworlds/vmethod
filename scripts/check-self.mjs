import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

if (!existsSync("vmethod.yaml")) {
  console.log("Skipping vmethod self-check: vmethod.yaml is absent.");
} else {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../dist/vmethod.mjs", import.meta.url)), "check"],
    { encoding: "utf8", env: { ...process.env, VMETHOD_ROOT: process.cwd() } }
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  const ownerSettingsOnly =
    !existsSync(".claude/settings.json") &&
    result.status === 1 &&
    result.stdout ===
      "Install owner-approved .claude/settings.json from templates/claude-settings.json\n" &&
    result.stderr === "";
  if (result.error) {
    console.error(result.error);
  }
  process.exitCode = ownerSettingsOnly ? 0 : (result.status ?? 1);
}
