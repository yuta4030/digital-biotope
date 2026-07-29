import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import {
  aggregateRow,
  expandSweep,
  runOne,
  type RunResult,
  type SweepAxis,
  type SweepOptions,
  type SweepRow,
} from './sweep.ts';
import type { WorldConfig } from '../core/types.ts';

/**
 * 1回ぶんの試行。worker に渡せるのは素のデータだけなので、
 * 軸の適用（関数）はメインスレッドで済ませて確定した config を送る。
 */
export interface Job {
  config: WorldConfig;
  steps: number;
  tail: number;
}

export interface PoolOptions {
  /** 使う worker 数。既定は CPU 数とジョブ数の小さい方。1 なら worker を作らず直列に回す */
  workers?: number;
  onProgress?(done: number, total: number): void;
}

/** メインスレッドから worker へ */
interface Request {
  id: number;
  job: Job;
}

/** worker からメインスレッドへ */
type Response =
  | { id: number; ok: true; result: RunResult }
  | { id: number; ok: false; message: string; stack?: string };

export function defaultWorkerCount(): number {
  const env = Number(process.env.SWEEP_WORKERS);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  return availableParallelism();
}

/**
 * ジョブを並列に走らせ、**投入順**で結果を返す。
 *
 * 各ジョブは World を1つ作って閉じた乱数列で回るだけなので、
 * どの worker がどの順で処理しても結果は直列実行と完全に一致する。
 * 並べ替えはここで吸収するので、呼ぶ側は完了順を気にしなくていい。
 */
export async function runJobs(jobs: Job[], opts: PoolOptions = {}): Promise<RunResult[]> {
  const total = jobs.length;
  if (total === 0) return [];

  const workerCount = Math.max(1, Math.min(opts.workers ?? defaultWorkerCount(), total));
  if (workerCount === 1) return runJobsSerial(jobs, opts);

  const results = new Array<RunResult>(total);
  let next = 0;
  let done = 0;

  const workers: Worker[] = [];
  const url = new URL('./worker.ts', import.meta.url);

  await new Promise<void>((resolve, reject) => {
    let failed = false;

    const fail = (err: Error) => {
      if (failed) return;
      failed = true;
      reject(err);
    };

    const send = (w: Worker): void => {
      if (failed) return;
      if (next >= total) {
        // 残りが無い worker から順に畳む
        void w.terminate();
        return;
      }
      const id = next++;
      const req: Request = { id, job: jobs[id] };
      w.postMessage(req);
    };

    for (let k = 0; k < workerCount; k++) {
      const w = new Worker(url);
      workers.push(w);

      w.on('message', (res: Response) => {
        if (!res.ok) {
          const err = new Error(`worker でエラー: ${res.message}`);
          if (res.stack) err.stack = res.stack;
          fail(err);
          return;
        }
        results[res.id] = res.result;
        done++;
        opts.onProgress?.(done, total);
        if (done === total) {
          resolve();
          return;
        }
        send(w);
      });

      w.on('error', fail);
      w.on('exit', (code) => {
        // terminate() 由来の終了コード1は正常。それ以外で落ちたら失敗扱い
        if (code !== 0 && code !== 1 && done < total) {
          fail(new Error(`worker が終了コード ${code} で落ちました`));
        }
      });

      send(w);
    }
  }).finally(() => {
    for (const w of workers) void w.terminate();
  });

  return results;
}

/**
 * 全軸の直積を並列に走査する。runSweep の並列版。
 *
 * 条件×シードの1回ぶんを1ジョブにして配る。条件単位ではなく試行単位で
 * 配ることで、重い条件が1つあっても他の worker が遊ばない。
 *
 * onProgress は「完了した試行数 / 全試行数」で呼ばれる（直列版は条件数）。
 * 結果の行は直列版と完全に一致する。
 */
export async function runSweepParallel(
  base: WorldConfig,
  axes: SweepAxis[],
  opts: SweepOptions & { workers?: number },
): Promise<SweepRow[]> {
  const combos = expandSweep(base, axes, opts);

  const jobs: Job[] = combos.flatMap((c) =>
    c.configs.map((config) => ({ config, steps: opts.steps, tail: opts.tail })),
  );

  const results = await runJobs(jobs, {
    workers: opts.workers,
    onProgress: opts.onProgress,
  });

  // 投入順に戻っているので、条件ごとに repeats 個ずつ切り出せる
  let at = 0;
  return combos.map((c) => {
    const slice = results.slice(at, at + c.configs.length);
    at += c.configs.length;
    return aggregateRow(c.values, slice);
  });
}

function runJobsSerial(jobs: Job[], opts: PoolOptions): RunResult[] {
  const results: RunResult[] = [];
  for (let i = 0; i < jobs.length; i++) {
    results.push(runOne(jobs[i].config, jobs[i].steps, jobs[i].tail));
    opts.onProgress?.(i + 1, jobs.length);
  }
  return results;
}
