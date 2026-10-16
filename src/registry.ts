export const verbs = [
  { name: 'version', stub: 'scripts/agent/version.sh' },
  { name: 'config', stub: 'scripts/agent/config.sh' },
  { name: 'check', stub: 'scripts/agent/check.sh' },
  { name: 'init', stub: 'scripts/agent/init.sh' },
] as const;

export function stub(verb: string): string {
  if (!/^[a-z][a-z-]*( [a-z][a-z-]*)*$/.test(verb))
    throw new Error('Unsafe registered verb');
  return `#!/bin/sh
# vmethod stub
if command -v git >/dev/null 2>&1; then
  root=$(git rev-parse --show-toplevel) || { echo "vmethod: cannot find repository root" >&2; exit 1; }
else
  root=\${VMETHOD_ROOT:-}
fi
if [ -z "$root" ] || [ ! -x "$root/node_modules/.bin/vmethod" ]; then
  echo "vmethod: run npm ci (set VMETHOD_ROOT when git is unavailable)" >&2
  exit 2
fi
exec "$root/node_modules/.bin/vmethod" ${verb} "$@"
`;
}
