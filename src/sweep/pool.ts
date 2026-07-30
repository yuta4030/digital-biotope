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
  return checkShape<RunResult>(await dispatch(jobs, onDone), 'survived', 'runMany');
}

/**
 * 返ってきた結果が頼んだ種類のものかを確かめる。
 *
 * 13で踏んだ取り違えは、**別の種類の結果が黙って混ざる**という形で出た。
 * 落ちたのは受け取った側がたまたま `.marks` を触ったからで、
 * 形が近ければ数字だけ入れ替わって通っていた。直列化で原因は消したが、
 * 同じ壊れ方をもう一度されると気づけないので、声を上げる仕掛けを残す。
 */
function checkShape<T>(rs: unknown[], has: keyof T & string, kind: string): T[] {
  const bad = rs.findIndex((r) => r === undefined || !(has in (r as object)));
  if (bad >= 0) {
    throw new Error(
      `${kind} の結果 ${bad} 番目に "${has}" が無い。` +
        'ワーカーの結果が取り違えられている可能性がある（pool.ts の running を参照）',
    );
  }
  return rs as T[];
}

/** 途中経過も要るとき。トレースは1本が長いので、直列だと全体の半分を食う */
export async function traceMany(
  jobs: TraceJob[],
  onDone?: (finished: number) => void,
): Promise<TraceResult[]> {
  return checkShape<TraceResult>(await dispatch(jobs, onDone), 'marks', 'traceMany');
}

/** 侵入の実験。1本が warmup + 投入回数ぶんの長さになるので並列の効きが大きい */
export async function invadeMany(
  jobs: InvasionJob[],
  onDone?: (finished: number) => void,
): Promise<InvasionResult[]> {
  return checkShape<InvasionResult>(await dispatch(jobs, onDone), 'attempts', 'invadeMany');
}

/**
 * 実行中の dispatch。**同時に1本しか走らせない。**
 *
 * ワーカーはモジュールスコープで使い回すので、dispatch を並行させると
 * 同じ Worker に複数の onMessage が載る。Worker の message イベントは
 * 登録されたハンドラを**全部**呼ぶので、他の dispatch の結果が自分の results に
 * 書き込まれ、さらに各ハンドラが feed() を呼んで余分なジョブを投げる。
 *
 * 13の節2でこれを踏んだ。4条件を Promise.all で並行させたところ、
 * **4条件の数字が1ビットも違わない値**になり（他の dispatch の結果で上書きされた）、
 * 続く節の traceMany が RunResult を受け取って `r.marks` で落ちた。
 * 落ちてくれたから気づけたが、条件が近い値だったら黙って通っていた。
 *
 * 並行させても速くならない。1本の dispatch が既に全ワーカーを埋めるので、
 * 2本走らせても同じコアを取り合うだけ。直列化して問題そのものを消す。
 */
let running: Promise<unknown> = Promise.resolve();

async function dispatch(
  jobs: AnyJob[],
  onDone?: (finished: number) => void,
): Promise<(RunResult | TraceResult | InvasionResult)[]> {
  // 前の dispatch が失敗しても列を止めない
  const mine = running.then(
    () => dispatchOne(jobs, onDone),
    () => dispatchOne(jobs, onDone),
  );
  running = mine.catch(() => undefined);
  return mine;
}

async function dispatchOne(
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
