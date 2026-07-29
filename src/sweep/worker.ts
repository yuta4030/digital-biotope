import { parentPort } from 'node:worker_threads';
import { runOne } from './sweep.ts';
import type { Job } from './pool.ts';

/**
 * pool.ts から呼ばれる worker 本体。
 *
 * 受け取った config で1回走らせて結果を返すだけ。状態を持たないので、
 * どのジョブがどの worker に割り振られても結果は変わらない。
 */

const port = parentPort;
if (!port) throw new Error('worker.ts は Worker から起動してください');

port.on('message', (req: { id: number; job: Job }) => {
  try {
    const result = runOne(req.job.config, req.job.steps, req.job.tail);
    port.postMessage({ id: req.id, ok: true, result });
  } catch (e) {
    const err = e as Error;
    port.postMessage({ id: req.id, ok: false, message: err.message, stack: err.stack });
  }
});
