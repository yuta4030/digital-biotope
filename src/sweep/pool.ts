import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { runOne, type RunResult } from './run.ts';
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

export interface Job {
  config: WorldConfig;
  steps: number;
  tail: number;
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

/** 全ジョブを回して、渡した順に結果を返す。onDone は終わった件数を受け取る */
export async function runMany(
  jobs: Job[],
  onDone?: (finished: number) => void,
): Promise<RunResult[]> {
  const n = Math.min(poolSize(), jobs.length);
  let finished = 0;

  if (n <= 1) {
    return jobs.map((j) => {
      const r = runOne(j.config, j.steps, j.tail);
      onDone?.(++finished);
      return r;
    });
  }

  const results = new Array<RunResult>(jobs.length);
  const ws = workers(n);
  let next = 0;

  // 各ワーカーは1件終えるたびに次を取りに来る。
  // 条件ごとに所要時間が何倍も違うので、先に等分すると遅い山で待たされる
  await Promise.all(
    ws.slice(0, n).map(
      (w) =>
        new Promise<void>((resolve, reject) => {
          const onMessage = (m: { index: number; result: RunResult }) => {
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
