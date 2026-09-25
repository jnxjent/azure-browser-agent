/** In-process admission and FIFO scheduling for browser operations. */
export class RunScheduler {
  private readonly active = new Set<string>();
  private readonly waiting: Array<{ id: string; execute: () => Promise<void> }> = [];

  constructor(
    private readonly concurrentLimit: number,
    private readonly admissionLimit: number,
  ) {
    if (!Number.isInteger(concurrentLimit) || concurrentLimit < 1 ||
        !Number.isInteger(admissionLimit) || admissionLimit < concurrentLimit) {
      throw new RangeError("Invalid run scheduler limits.");
    }
  }

  get admittedCount(): number {
    return this.active.size + this.waiting.length;
  }

  get activeCount(): number {
    return this.active.size;
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  /** A queued position is one-based. Active or unknown runs have no position. */
  waitingPosition(id: string): number | undefined {
    const index = this.waiting.findIndex((entry) => entry.id === id);
    return index < 0 ? undefined : index + 1;
  }

  has(id: string): boolean {
    return this.active.has(id) || this.waiting.some((entry) => entry.id === id);
  }

  admit(id: string, execute: () => Promise<void>): boolean {
    if (this.has(id) || this.admittedCount >= this.admissionLimit) return false;
    this.waiting.push({ id, execute });
    this.drain();
    return true;
  }

  /** Removes a run that has not started. An active run must be aborted separately. */
  removeWaiting(id: string): boolean {
    const index = this.waiting.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.waiting.splice(index, 1);
    return true;
  }

  private drain(): void {
    while (this.active.size < this.concurrentLimit && this.waiting.length > 0) {
      const entry = this.waiting.shift()!;
      this.active.add(entry.id);
      void Promise.resolve().then(entry.execute).catch(() => {
        // The run handler records its own failure; release the execution slot.
      }).finally(() => {
        this.active.delete(entry.id);
        this.drain();
      });
    }
  }
}
