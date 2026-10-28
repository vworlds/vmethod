kind: feature

Add orchestrator-only `issue reopen` with pre-Done card restoration and gateway
journaling. Refuse `issue close` when an open blocker exists or blocker metadata is
incomplete, unless `--force` explicitly bypasses the guard.
