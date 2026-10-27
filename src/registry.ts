export const verbs = [
  { name: "learnings", stub: "scripts/agent/learnings.sh" },
  { name: "issue", stub: "scripts/orchestrator/issue.sh" },
  { name: "scope-review", stub: "scripts/orchestrator/scope-review.sh" },
  { name: "worker", stub: "scripts/orchestrator/worker.sh" },
  { name: "worktrees", stub: "scripts/orchestrator/worktrees.sh" },
  { name: "suggest-model", stub: "scripts/orchestrator/suggest-model.sh" },
  { name: "grade", stub: "scripts/orchestrator/grade.sh" },
  { name: "open-task", stub: "scripts/orchestrator/open-task.sh" },
  { name: "review", stub: "scripts/orchestrator/review.sh" },
  { name: "merge-task", stub: "scripts/orchestrator/merge-task.sh" },
  { name: "close-task", stub: "scripts/orchestrator/close-task.sh" },
  { name: "resolve-conflicts", stub: "scripts/orchestrator/resolve-conflicts.sh" },
  { name: "link-task", stub: "scripts/orchestrator/link-task.sh" },
  { name: "release-hold", stub: "scripts/orchestrator/release-hold.sh" },
  { name: "watch", stub: "scripts/agent/watch.sh" },
  { name: "mute", stub: "scripts/agent/mute.sh" },
  { name: "unmute", stub: "scripts/agent/unmute.sh" },
  { name: "mutes", stub: "scripts/agent/mutes.sh" },
  { name: "wait-checks", stub: "scripts/agent/wait-checks.sh" },
  { name: "verify", stub: "scripts/orchestrator/verify.sh" },
  { name: "refresh-checks", stub: "scripts/orchestrator/refresh-checks.sh" },
  { name: "check-task-ci", stub: "scripts/orchestrator/check-task-ci.sh" },
  { name: "board", stub: "scripts/agent/board.sh" },
  { name: "version", stub: "scripts/agent/version.sh" },
  { name: "config", stub: "scripts/agent/config.sh" },
  { name: "check", stub: "scripts/agent/check.sh" },
  { name: "init", stub: "scripts/agent/init.sh" },
  { name: "read", stub: "scripts/agent/read.sh" },
  { name: "post", stub: "scripts/agent/post.sh" },
  { name: "gh-read", stub: "scripts/agent/gh-read.sh" },
  { name: "dropped", stub: "scripts/agent/dropped.sh" },
  { name: "read-pr", stub: "scripts/agent/read-pr.sh" },
  { name: "pr-comment", stub: "scripts/agent/pr-comment.sh" },
  { name: "push", stub: "scripts/agent/push.sh" },
  { name: "check-markdown", stub: "scripts/agent/check-markdown.sh" },
] as const;

export function stub(verb: string): string {
  if (!/^[a-z][a-z-]*( [a-z][a-z-]*)*$/.test(verb)) {
    throw new Error("Unsafe registered verb");
  }
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
