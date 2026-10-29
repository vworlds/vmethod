# Lock policies

Preserve each lock's recovery policy when changing gateway concurrency code.

Use the kinds in [`src/journal/locks.ts`](../src/journal/locks.ts) for local
claims. They share the existing holder and process-identity helpers without
changing file names, serialized records, modes or refusal messages.

| Claim                                     | Recovery policy                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Watcher (`OwnedLock.watch`)               | Match PID and process start. Retain live holders; clear dead/reused PIDs. A holder-less file younger than 60 seconds is still initializing. Release only your own claim.                                                                                                                                                                                 |
| Conflict (`OwnedLock.conflict`)           | Match PID and process start. Return quiet pending for live holders; clear dead/reused PIDs, damaged bodies and legacy directories immediately. Release only your own claim.                                                                                                                                                                              |
| Journal (`PidLock`)                       | Legacy exception: keep PID-only content. Recover only after three seconds and ESRCH. Retain live/reused PIDs and missing, malformed or fresh holders. Changing its format is outside this refactor.                                                                                                                                                      |
| Worker (`DirLock` with `holder`)          | Name the operation, PID, wall time and available process start in `holder.json`; describe stale holders but never remove a contended claim automatically.                                                                                                                                                                                                |
| Learnings, generation, review (`DirLock`) | Keep holder-less directory claims. Never remove a contended claim automatically, regardless of age.                                                                                                                                                                                                                                                      |
| Board migration                           | Keep the field lock in [`src/board/runner.ts`](../src/board/runner.ts) so recovery snapshots, field creation/deletion and README writes retain their ordering. Host, boot, PID and process start prove death. Without proof, a holder at most one hour old or a field younger than one minute refuses recovery; older/unknown holders require `--steal`. |

Keep [`watch --stop`](gateway.md) separate: it verifies the command line and
never sends SIGKILL. Extraction of acquisition does not change that contract.
For migration identity checks, see
[`process-identity.ts`](../src/gateway/process-identity.ts).
