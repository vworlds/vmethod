export const verbs = [
  { name: 'version', stub: 'scripts/agent/version.sh' },
  { name: 'config', stub: 'scripts/agent/config.sh' },
  { name: 'check', stub: 'scripts/agent/check.sh' },
  { name: 'init', stub: 'scripts/agent/init.sh' },
  { name: 'read', stub: 'scripts/agent/read.sh' },
  { name: 'post', stub: 'scripts/agent/post.sh' },
  { name: 'gh-read', stub: 'scripts/agent/gh-read.sh' },
  { name: 'dropped', stub: 'scripts/agent/dropped.sh' },
] as const;

export function stub(verb: string): string {
  if (!/^[a-z][a-z-]*( [a-z][a-z-]*)*$/.test(verb))
    throw new Error('Unsafe registered verb');
  return `#!/bin/sh
# vmethod stub
root=\${VMETHOD_ROOT:-}
if [ -z "$root" ] && command -v git >/dev/null 2>&1; then
  if ! root=$(git rev-parse --show-toplevel); then
    echo "vmethod: git could not find a repository; set VMETHOD_ROOT" >&2
    root=
  fi
fi
if [ -z "$root" ] || [ ! -x "$root/node_modules/.bin/vmethod" ]; then
  echo "vmethod: run npm ci (set VMETHOD_ROOT when no repository is available)" >&2
  exit 2
fi
exec "$root/node_modules/.bin/vmethod" ${verb} "$@"
`;
}
