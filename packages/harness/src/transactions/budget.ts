/**
 * The time one tool call may spend (PV-WRITE-001, A.1 / A.4). A ChatGPT tool call that runs past its window is
 * abandoned by the client while the server keeps writing; the executor therefore stops on its own, at a write
 * boundary, and reports IN_PROGRESS so the next call resumes from the journal.
 */
export const HARNESS_CALL_BUDGET_MS = 35_000;

/** Time kept in reserve before starting one more Notion write (a write, its retries and the journal update). */
export const WRITE_RESERVE_MS = 4_000;

export class Deadline {
  readonly #clock: () => number;
  readonly #endsAt: number;

  constructor(clock: () => number = Date.now, budgetMs: number = HARNESS_CALL_BUDGET_MS) {
    this.#clock = clock;
    this.#endsAt = clock() + budgetMs;
  }

  remaining(): number {
    return Math.max(0, this.#endsAt - this.#clock());
  }

  /** True while at least `ms` remain. */
  allows(ms: number): boolean {
    return this.remaining() >= ms;
  }
}
