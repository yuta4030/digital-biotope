import { parentPort } from 'node:worker_threads';
import { runOne } from './run.ts';
import type { WorldConfig } from '../core/types.ts';

/**
 * 1条件を回して結果を返すだけのワーカー。プールから使い回される。
 * 実行の中身は直列版とまったく同じ runOne なので、結果も一致する。
 */

export interface WorkerJob {
  index: number;
  config: WorldConfig;
  steps: number;
  tail: number;
}

parentPort?.on('message', (job: WorkerJob) => {
  parentPort!.postMessage({
    index: job.index,
    result: runOne(job.config, job.steps, job.tail),
  });
});
