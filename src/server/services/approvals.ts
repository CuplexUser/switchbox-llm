interface Pending {
  resolve: (approved: boolean) => void;
}

/** Tool calls waiting for the user. A call resolves once, when the user answers or the reply is stopped. */
export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();

  wait(id: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onAbort = () => this.answer(id, false);
      this.pending.set(id, {
        resolve: (approved) => {
          signal.removeEventListener('abort', onAbort);
          resolve(approved);
        },
      });
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Returns false when nothing is waiting under that id. */
  answer(id: string, approved: boolean): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    entry.resolve(approved);
    return true;
  }

  get size(): number {
    return this.pending.size;
  }
}
