import { presetByKey } from '../core/presets.ts';
import { runSweep, type SweepAxis } from './sweep.ts';
import { defaultWorkerCount, runSweepParallel } from './pool.ts';
import type { WorldConfig } from '../core/types.ts';

/**
 * 並列版が直列版と同じ結果を出すことの確認。
 *
 *   npm run check-parallel
 *
 * 並列化で怖いのは速度ではなく、シードの配り方や集計順で結果が静かにずれること。
 * 速度を測っても見つからないので、同じ条件を両方で回して全項目を突き合わせる。
 * 生存数・平均・最小・最大まで完全一致しなければ失敗で終わる。
 *
 * 視野ありの構成も含めるのは、種ごとに手番を分ける経路（moveAgents）を通すため。
 * 所要1分弱。
 */

interface Case {
  name: string;
  build: () => WorldConfig;
  axes: SweepAxis[];
  steps: number;
  repeats: number;
}

const cases: Case[] = [
  {
    name: '基本（視野なし）',
    build: () => presetByKey('basic').build(),
    axes: [
      {
        label: '肉食_代謝',
        values: [0.4, 0.6, 0.8],
        apply: (cfg, v) => (cfg.species[1].metabolism = v),
      },
      {
        label: '肉食_捕食利得',
        values: [15, 22],
        apply: (cfg, v) => (cfg.species[1].gainFromPrey = v),
      },
    ],
    steps: 1500,
    repeats: 3,
  },
  {
    name: '追跡（視野あり）',
    build: () => presetByKey('pursuit').build(),
    axes: [
      {
        label: '肉食_捕獲成功率',
        values: [0.03, 0.05],
        apply: (cfg, v) => (cfg.species[1].captureRate = v),
      },
    ],
    steps: 800,
    repeats: 3,
  },
];

let failed = 0;
const workers = defaultWorkerCount();
console.log(`worker ${workers} で確認する\n`);

for (const c of cases) {
  const opts = { steps: c.steps, tail: Math.floor(c.steps / 2), repeats: c.repeats, baseSeed: 1000 };

  const t1 = performance.now();
  const a = runSweep(c.build(), c.axes, opts);
  const serialMs = performance.now() - t1;

  const t2 = performance.now();
  const b = await runSweepParallel(c.build(), c.axes, { ...opts, workers });
  const parallelMs = performance.now() - t2;

  const same = JSON.stringify(a) === JSON.stringify(b);
  const runs = a.length * c.repeats;

  console.log(
    `${same ? 'OK  ' : 'NG  '}${c.name.padEnd(14)} ${runs} runs  ` +
      `直列 ${(serialMs / 1000).toFixed(1)}s → 並列 ${(parallelMs / 1000).toFixed(1)}s` +
      ` (${(serialMs / parallelMs).toFixed(1)}倍)`,
  );

  if (!same) {
    failed++;
    // 最初に食い違った行だけ出す。全部出しても読めない
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
        console.log(`  行 ${i} が食い違う`);
        console.log(`    直列: ${JSON.stringify(a[i])}`);
        console.log(`    並列: ${JSON.stringify(b[i])}`);
        break;
      }
    }
  }
}

if (failed > 0) {
  console.log(`\n${failed} 件が不一致`);
  process.exit(1);
}
console.log('\n全件一致');
