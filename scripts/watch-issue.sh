#!/usr/bin/env bash
# Usage: watch-issue.sh <issue> [repo] [interval-seconds]
# Polls an issue and prints one line per new comment (author, id, first line).
# Skips comments by $SELF (default vimescmd). Stays silent between comments.
set -u
issue=$1; repo=${2:-vworlds/vmethod}; interval=${3:-60}
seen=$(gh api "repos/$repo/issues/$issue/comments?per_page=100" --jq '.[].id' 2>/dev/null | tail -1)
seen=${seen:-0}
while true; do
  out=$(gh api "repos/$repo/issues/$issue/comments?per_page=100" \
    --jq ".[] | select(.id > $seen and .user.login != \"${SELF:-vimescmd}\") | \"\(.id)\t\(.user.login)\t\(.body | split(\"\n\")[0] | .[0:120])\"" 2>/dev/null) || { sleep "$interval"; continue; }
  if [ -n "$out" ]; then
    while IFS=$'\t' read -r id who first; do
      echo "issue #$issue new comment $id by $who: $first"; seen=$id
    done <<<"$out"
  fi
  sleep "$interval"
done
