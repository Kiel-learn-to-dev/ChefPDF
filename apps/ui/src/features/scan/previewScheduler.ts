/**
 * Debounced, latest-wins runner for scan previews. At most one run is in flight: a newer
 * request cancels the running job (cooperative) and the newest params run once it has
 * settled. Results of superseded runs are dropped. The core deletes the previous preview
 * images on every run, so two runs must never overlap.
 */

export interface PreviewRunner<P, R> {
  /** Starts a run. `onStarted` receives the job id as soon as the core accepted it. */
  run(params: P, onStarted: (jobId: string) => void): Promise<R>;
  /** Cooperative cancel of a started job. */
  cancel(jobId: string): void;
}

export interface PreviewHandlers<R> {
  onResult(result: R): void;
  onError(error: unknown): void;
  /** True for the error of a run that was cancelled on purpose (ignored). */
  isCancelled(error: unknown): boolean;
}

export interface SchedulerTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: SchedulerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface Flight {
  seq: number;
  jobId?: string;
  cancelled: boolean;
}

export class PreviewScheduler<P, R> {
  private seq = 0;
  private latest: { params: P; seq: number } | null = null;
  private due = false;
  private timer: unknown = null;
  private inFlight: Flight | null = null;
  private disposed = false;

  constructor(
    private readonly runner: PreviewRunner<P, R>,
    private readonly handlers: PreviewHandlers<R>,
    private readonly debounceMs = 400,
    private readonly timers: SchedulerTimers = realTimers,
  ) {}

  request(params: P): void {
    if (this.disposed) return;
    this.seq++;
    this.latest = { params, seq: this.seq };
    this.due = false;
    this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.due = true;
      this.pump();
    }, this.debounceMs);
    if (this.inFlight && !this.inFlight.cancelled) this.cancel(this.inFlight);
  }

  /** Stops everything: pending timers, the running job, and any later requests. */
  dispose(): void {
    this.disposed = true;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
    if (this.inFlight && !this.inFlight.cancelled) this.cancel(this.inFlight);
  }

  private cancel(flight: Flight): void {
    flight.cancelled = true;
    if (flight.jobId !== undefined) this.runner.cancel(flight.jobId);
  }

  private pump(): void {
    if (this.disposed || this.inFlight || !this.due || !this.latest) return;
    this.due = false;
    const { params, seq } = this.latest;
    const flight: Flight = { seq, cancelled: false };
    this.inFlight = flight;
    const settle = () => {
      if (this.inFlight === flight) this.inFlight = null;
      this.pump();
    };
    const current = () => !this.disposed && !flight.cancelled && seq === this.latest?.seq;
    let started: Promise<R>;
    try {
      started = this.runner.run(params, (jobId) => {
        flight.jobId = jobId;
        if (flight.cancelled) this.runner.cancel(jobId);
      });
    } catch (error) {
      started = Promise.reject(error);
    }
    started.then(
      (result) => {
        if (current()) this.handlers.onResult(result);
        settle();
      },
      (error: unknown) => {
        if (current() && !this.handlers.isCancelled(error)) this.handlers.onError(error);
        settle();
      },
    );
  }
}
