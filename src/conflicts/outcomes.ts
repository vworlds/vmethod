/** Expected reconciliation races, distinct from failed reads or unsafe task gates. */
export class ConflictOutcome extends Error {
  constructor(
    readonly outcome: "closed" | "retry",
    message: string
  ) {
    super(message);
    this.name = "ConflictOutcome";
  }
}
