import { parentPort } from 'node:worker_threads';
import { runOne, runTrace, runInvasion } from './run.ts';
import type { AnyJob } from './pool.ts';

/**
 * 1条件を回して結果を返すだけのワーカー。プールから使い回される。
 * 実行の中身は直列版とまったく同じ runOne / runTrace / runInvasion なので、結果も一致する。
 */
parentPort?.on('message', (job: AnyJob & { index: number }) => {
  parentPort!.postMessage({
    index: job.index,
    result:
      job.kind === 'trace'
        ? runTrace(job.config, job)
        : job.kind === 'invasion'
          ? runInvasion(job.config, job)
          : runOne(job.config, job.steps, job.tail),
  });
});
