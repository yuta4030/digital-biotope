import { World } from '../../../src/core/world.ts';
import { step } from '../../../src/core/step.ts';
import { presetByKey } from '../../../src/core/presets.ts';
import { group, line, header, done, banner } from './_lib.ts';

/**
 * レポート03: 視野と追跡
 *
 *   node docs/reports/scripts/03-vision-and-pursuit.ts
 *
 * 視野の計算コストと、追跡を成立させるのに何が要るか。
 * 視野ありは重いので並列に回す（スレッド数は BIOTOPE_WORKERS で変えられる）。
 * 冒頭の steps/sec だけは1スレッドの速度そのものを測るので直列のまま。
 */

const t0 = performance.now();
banner();
const SEEDS_6 = [1000, 2000, 3000, 4000, 5000, 6000];

header('視野の計算コスト（草食のみ・約1000個体）');
console.log('  視野  steps/sec');
for (const v of [0, 1, 2, 3, 5, 8]) {
  const cfg = presetByKey('basic').build();
  cfg.seed = 1000;
  cfg.species[0].visionRange = v;
  cfg.species[1].visionRange = v;
  const w = new World(cfg);
  for (let s = 0; s < 300; s++) step(w); // 個体数が落ち着くまで捨てる
  const t = performance.now();
  const N = 1000;
  for (let s = 0; s < N; s++) step(w);
  console.log(`  ${String(v).padStart(4)}  ${(N / ((performance.now() - t) / 1000)).toFixed(0).padStart(9)}`);
}

/** basic をいじって追跡の条件を作る */
function pursuit(o: {
  hVision?: number;
  cVision?: number;
  cSpeed?: number;
  cap?: number;
  gain?: number;
}) {
  const cfg = presetByKey('basic').build();
  cfg.species[0].visionRange = o.hVision ?? 0;
  cfg.species[1].visionRange = o.cVision ?? 0;
  cfg.species[1].speed = o.cSpeed ?? 1;
  cfg.species[1].captureRate = o.cap ?? 1;
  cfg.species[1].gainFromPrey = o.gain ?? 18;
  return cfg;
}

header('捕獲成功率なし（=1.0）だと共存域が無い');
await group(
  [1, 2, 3],
  (cSpeed) => pursuit({ hVision: 2, cVision: 3, cSpeed }),
  (cSpeed, t) => line(`草食視野2 肉食速度${cSpeed}`, t, { range: false }),
);

header('捕獲成功率を下げる（草食視野2 / 肉食 速度2・視野3・利得18）');
await group(
  [0.5, 0.25, 0.12, 0.08, 0.05, 0.03],
  (cap) => pursuit({ hVision: 2, cVision: 3, cSpeed: 2, cap }),
  (cap, t) => line(`成功率${cap}`, t, { range: false }),
);

header('速度差が無いと成功率は効かない（遭遇そのものが起きない）');
await group(
  [0.5, 0.12, 0.03],
  (cap) => pursuit({ hVision: 2, cVision: 3, cSpeed: 1, cap }),
  (cap, t) => line(`速度1 成功率${cap}`, t, { range: false }),
);

header(`採用値の確認（${SEEDS_6.length}シード）`);
await group(
  [
    [0.03, 18],
    [0.04, 18],
    [0.05, 18],
    [0.06, 18],
    [0.03, 30],
  ] as const,
  ([cap, gain]) => pursuit({ hVision: 2, cVision: 3, cSpeed: 2, cap, gain }),
  ([cap, gain], t) => line(`成功率${cap} 利得${gain}`, t),
  { seeds: SEEDS_6 },
);

// 採用値では壊れない。詳しくは 06-enrichment.ts
header('採用値では草食の繁殖確率を上げても壊れない');
await group(
  [0.08, 0.12, 0.16, 0.2],
  (rp) => {
    const cfg = pursuit({ hVision: 2, cVision: 3, cSpeed: 2, cap: 0.04 });
    cfg.species[0].reproduceProb = rp;
    return cfg;
  },
  (rp, t) => line(`草食の繁殖確率${rp}`, t, { range: false }),
);

done(t0);
