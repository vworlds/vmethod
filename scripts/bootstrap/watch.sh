#!/usr/bin/env bash
# Bootstrap watcher for the vmethod orchestrator, until the real `vmethod watch` exists.
# It follows the gateway rules from docs/architecture.md:
# - authors are matched by numeric id against people.tsv; unknown authors are dropped and
#   written to the digest (never shown to the agent);
# - only metadata is printed (kind, ref, author, role, url), never untrusted text;
# - edited comments are flagged, so the agent re-checks the editor before trusting them;
# - one reader per state dir (flock); the cursor persists, so a restart misses nothing;
# - failures are reported: 3 failed polls in a row print a WATCHER ERROR line.
# Usage: watch.sh [repo] [interval] [board-number]. One stdout line per event.
set -uo pipefail

main() {
  local repo=${1:-vworlds/vmethod} interval=${2:-60} board=${3:-5}
  local root; root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
  local people="$root/people.tsv" self
  local state="${XDG_STATE_HOME:-$HOME/.local/state}/vmethod-bootstrap-watch"
  mkdir -p "$state"
  exec 9>"$state/lock"
  flock -n 9 || { echo "WATCHER ERROR: another watcher holds $state/lock"; exit 1; }
  self=$(gh api user --jq .id) || { echo "WATCHER ERROR: cannot read own identity"; exit 1; }
  [ -f "$state/since" ] || date -u +%Y-%m-%dT%H:%M:%SZ >"$state/since"
  touch "$state/seen" "$state/board"
  local fails=0
  while true; do
    if poll "$repo" "$board" "$people" "$self" "$state"; then fails=0; else
      fails=$((fails + 1))
      [ "$fails" -ge 3 ] && { echo "WATCHER ERROR: $fails failed polls in a row (see $state/error.log)"; fails=0; }
    fi
    sleep "$interval"
  done
}

# poll: prints new events; returns non-zero if any GitHub call failed.
poll() {
  local repo=$1 board=$2 people=$3 self=$4 state=$5 since now raw ok=0
  since=$(cat "$state/since"); now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # tab-separated: key, kind, number, author id, author login, created, updated, url
  raw=$( {
    gh api --paginate "repos/$repo/issues/comments?since=$since&per_page=100" \
      --jq '.[] | ["c\(.id)","comment",(.issue_url|split("/")|last),.user.id,.user.login,.created_at,.updated_at,.html_url] | @tsv' &&
    gh api --paginate "repos/$repo/pulls/comments?since=$since&per_page=100" \
      --jq '.[] | ["i\(.id)","inline",(.pull_request_url|split("/")|last),.user.id,.user.login,.created_at,.updated_at,.html_url] | @tsv' &&
    gh api --paginate "repos/$repo/issues?state=all&since=$since&per_page=100" \
      --jq '.[] | select(.created_at >= "'"$since"'") | ["n\(.number)",(if .pull_request then "new-pr" else "new-issue" end),.number,.user.id,.user.login,.created_at,.updated_at,.html_url] | @tsv' &&
    for pr in $(gh api "repos/$repo/pulls?state=open&per_page=100" --jq '.[].number'); do
      gh api "repos/$repo/pulls/$pr/reviews?per_page=100" \
        --jq '.[] | select(.submitted_at >= "'"$since"'") | ["r\(.id)","review-\(.state|ascii_downcase)",'"$pr"',.user.id,.user.login,.submitted_at,.submitted_at,.html_url] | @tsv' || exit 1
    done
  } 2>>"$state/error.log" ) || ok=1
  while IFS=$'\t' read -r key kind num id login created updated url; do
    [ -n "$key" ] || continue
    [ "$id" = "$self" ] && { echo "$key" >>"$state/seen"; continue; }
    local mark="$key@$updated"
    grep -qxF "$mark" "$state/seen" && continue
    echo "$mark" >>"$state/seen"
    local role
    role=$(awk -F'\t' -v id="$id" '$0 !~ /^#/ && $2 == id { print $3 }' "$people")
    if [ -z "$role" ]; then
      printf '%s\tdropped\t%s\t%s#%s\t%s\n' "$now" "$kind" "$repo" "$num" "$url" >>"$state/digest.tsv"
      continue
    fi
    local edited=""
    [ "$created" != "$updated" ] && edited=" (EDITED: verify editor)"
    echo "event: $kind $repo#$num by $login ($role)$edited $url"
  done <<<"$raw"
  # board status changes (project items)
  local b
  b=$(gh api graphql -f query='query($n:Int!){organization(login:"vworlds"){projectV2(number:$n){items(first:100){nodes{content{... on Issue{number} ... on PullRequest{number}} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}' -F n="$board" \
      --jq '.data.organization.projectV2.items.nodes[] | "#\(.content.number) \(.fieldValueByName.name)"' 2>>"$state/error.log" | sort) || ok=1
  if [ -n "$b" ]; then
    [ -s "$state/board" ] && comm -13 "$state/board" <(echo "$b") | sed 's/^/event: board status /'
    echo "$b" >"$state/board"
  fi
  [ "$ok" = 0 ] && echo "$now" >"$state/since"
  return "$ok"
}

main "$@"; exit
