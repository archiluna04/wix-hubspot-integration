/**
 * Durable in-process job queue backed by SQLite.
 * - Webhooks enqueue and return immediately; work survives restarts.
 * - `dedupeKey` coalesces bursts (e.g. HubSpot sends one webhook per changed property)
 *   into a single pending job, and jobs sharing a key never run concurrently.
 * - Failures retry with exponential backoff; non-retryable errors fail fast.
 */
import { isRetryable } from '../lib/http.js';
import { errorInfo, log, scrub } from '../lib/logger.js';
import type { Job, Store } from '../store.js';

export type JobHandler = (job: Job) => Promise<void>;

export interface QueueOptions {
  concurrency: number;
  pollMs: number;
  maxAttempts: number;
}

export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  private busyKeys = new Set<string>();
  private running = 0;
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private readonly opts: QueueOptions;

  constructor(
    private readonly store: Store,
    opts: Partial<QueueOptions> = {},
  ) {
    this.opts = { concurrency: 4, pollMs: 300, maxAttempts: 6, ...opts };
  }

  register(type: string, handler: JobHandler): this {
    this.handlers.set(type, handler);
    return this;
  }

  enqueue(
    instanceId: string,
    type: string,
    payload: object,
    { dedupeKey = null, delayMs = 0 }: { dedupeKey?: string | null; delayMs?: number } = {},
  ): void {
    this.store.enqueueJob(instanceId, type, payload, dedupeKey, Date.now() + delayMs);
    if (!this.stopped && delayMs === 0) setImmediate(() => this.tick());
  }

  start(): void {
    this.store.resetRunningJobs();
    this.stopped = false;
    this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    while (this.running > 0) await new Promise((r) => setTimeout(r, 50));
  }

  private tick(): void {
    clearTimeout(this.timer);
    if (this.stopped) return;
    const free = this.opts.concurrency - this.running;
    if (free > 0) {
      for (const job of this.store.claimJobs(free, this.busyKeys)) void this.run(job);
    }
    this.timer = setTimeout(() => this.tick(), this.opts.pollMs);
  }

  private async run(job: Job): Promise<void> {
    const key = job.dedupeKey ?? `job:${job.id}`;
    this.busyKeys.add(key);
    this.running++;
    try {
      const handler = this.handlers.get(job.type);
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      await handler(job);
      this.store.completeJob(job.id);
    } catch (err) {
      const attempts = job.attempts + 1;
      const retry = isRetryable(err) && attempts < this.opts.maxAttempts;
      const retryAt = retry ? Date.now() + Math.min(1000 * 2 ** attempts, 5 * 60_000) : null;
      this.store.failJob(job.id, attempts, scrub(err instanceof Error ? err.message : String(err)), retryAt);
      log.warn('job failed', { jobId: job.id, type: job.type, attempts, willRetry: retry, error: errorInfo(err) });
    } finally {
      this.busyKeys.delete(key);
      this.running--;
    }
  }
}
