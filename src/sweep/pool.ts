import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import {
  runOne,
  runTrace,
  runInvasion,
  type RunResult,
  type TraceOptions,
  type TraceResult,
  type InvasionOptions,
  type InvasionResult,
} from './run.ts';
import type { WorldConfig } from '../core/types.ts';

/**
 * 条件を複数のスレッドに分けて回す。
 *
 * 各 run は完全に独立している。World は毎回作り直し、乱数はシードから
 * 引き直すので、共有する状態が無い。どの順で終わっても結果は変わらず、
 * 直列で回したときと1個体も違わない（_lib.ts の trial から使う）。
 *
 * 視野を使う構成は1個体あたり (2r+1)^2 セルを走査するので極端に遅く、
 * レポート07では全体の半分をそこに使っていた。並列化の効きが一番大きいのはここ。
 *
 * ブラウザ側からは読まれない。node:worker_threads を使うので core/ には置けない。
 */

/** 1条件を回して統計だけ返す */
export interface Job {
  kind?: 'run';
  config: WorldConfig;
  steps: number;
  tail: number;
}

/** 1条件を回して途中経過も返す */
export interface TraceJob extends TraceOptions {
  kind: 'trace';
  config: WorldConfig;
}

/** 平衡に達した世界へ少数を投入して、定着するかを何度も測る */
export interface InvasionJob extends InvasionOptions {
  kind: 'invasion';
  config: WorldConfig;
}

export type AnyJob = Job | TraceJob | InvasionJob;

function execute(job: AnyJob): RunResult | TraceResult | InvasionResult {
  if (job.kind === 'trace') return runTrace(job.config, job);
  if (job.kind === 'invasion') return runInvasion(job.config, job);
  return runOne(job.config, job.steps, job.tail);
}

/**
 * 使うスレッド数。1 なら worker を作らず直列で回す。
 *
 * 呼び出し側のスレッドは runMany を待っている間なにもしないので、
 * コア数ぶん全部使う。スクリプトが自前で回す節（推移トレースなど）は
 * ワーカーと同時には走らないので取り合いにならない。
 */
export function poolSize(): number {
  const env = Number(process.env.BIOTOPE_WORKERS);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  return Math.max(1, availableParallelism());
}

let pool: Worker[] | null = null;

function workers(n: number): Worker[] {
  if (pool === null) {
    const url = new URL('./worker.ts', import.meta.url);
    pool = Array.from({ length: n }, () => new Worker(url));
  }
  return pool;
}

/**
 * ワーカーを畳む。生きたままだとプロセスが終了しないので、
 * スクリプトの最後で必ず呼ぶ（_lib.ts の done がやる）。
 */
export async function closePool(): Promise<void> {
  if (pool === null) return;
  const ws = pool;
  pool = null;
  await Promise.all(ws.map((w) => w.terminate()));
}

/** 統計だけ要るとき */
export async function runMany(
  jobs: Job[],
  onDone?: (finished: number) => void,
): Promise<RunResult[]> {
  return dispatch(jobs, onDone) as Promise<RunResult[]>;
}

/** 途中経過も要るとき。トレースは1本が長いので、直列だと全体の半分を食う */
export async function traceMany(
  jobs: TraceJob[],
  onDone?: (finished: number) => void,
): Promise<TraceResult[]> {
  return dispatch(jobs, onDone) as Promise<TraceResult[]>;
}

/** 侵入の実験。1本が warmup + 投入回数ぶんの長さになるので並列の効きが大きい */
export async function invadeMany(
  jobs: InvasionJob[],
  onDone?: (finished: number) => void,
): Promise<InvasionResult[]> {
  return dispatch(jobs, onDone) as Promise<InvasionResult[]>;
}

async function dispatch(
  jobs: AnyJob[],
  onDone?: (finished: number) => void,
): Promise<(RunResult | TraceResult | InvasionResult)[]> {
  const n = Math.min(poolSize(), jobs.length);
  let finished = 0;

  if (n <= 1) {
    return jobs.map((j) => {
      const r = execute(j);
      onDone?.(++finished);
      return r;
    });
  }

  const results = new Array<RunResult | TraceResult | InvasionResult>(jobs.length);
  const ws = workers(n);
  let next = 0;

  // 各ワーカーは1件終えるたびに次を取りに来る。
  // 条件ごとに所要時間が何倍も違うので、先に等分すると遅い山で待たされる
  await Promise.all(
    ws.slice(0, n).map(
      (w) =>
        new Promise<void>((resolve, reject) => {
          const onMessage = (m: {
            index: number;
            result: RunResult | TraceResult | InvasionResult;
          }) => {
            results[m.index] = m.result;
            onDone?.(++finished);
            feed();
          };
          const onError = (e: Error) => {
            w.off('message', onMessage);
            reject(e);
          };
          const feed = () => {
            if (next >= jobs.length) {
              w.off('message', onMessage);
              w.off('error', onError);
              resolve();
              return;
            }
            const index = next++;
            w.postMessage({ index, ...jobs[index] });
          };

          w.on('message', onMessage);
          w.once('error', onError);
          feed();
        }),
    ),
  );

  return results;
}
