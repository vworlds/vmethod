import { build } from "esbuild";
import { readFile, chmod } from "node:fs/promises";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
await build({
  entryPoints: ["src/cli/main.ts"],
  outfile: "dist/vmethod.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  minify: false,
  sourcemap: true,
  splitting: false,
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
  define: {
    __VERSION__: JSON.stringify(pkg.version),
    __BOARD_VERSION__: JSON.stringify(pkg.boardVersion),
  },
});
await chmod("dist/vmethod.mjs", 0o755);
