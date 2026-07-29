import { presetByKey } from '../../../src/core/presets.ts';
import { group, header, done, mark, type Trial } from './_lib.ts';

/**
 * レポート05: 行動コストと視野への投資
 *
 *   node docs/reports/scripts/05-activity-cost.ts
 *
 * 「燃費」構成で、目に投資する価値がどこで消えるかを調べる。
 * 視野ありで重いので並列に回す（worker 数は SWEEP_WORKERS で変えられる）。
 */

const t0 = performance.now();
const SEEDS_8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];

const build = (visionCost: number, withPredator: boolean) => () => {
  const cfg = presetByKey('upkeep').build();
  for (const s of cfg.species) s.visionCost = visionCost;
  if (!withPredator) cfg.species[2].initialCount = 0;
  return cfg;
};

/** 警戒型の実効代謝。基礎0.25 + 速度コスト0.15×1 + 視野コスト×3 */
const effVigilant = (vc: number) => 0.25 + 0.15 + vc * 3;

function row(label: string, t: Trial) {
  const [a, b, c] = t.species;
  const winner = a.mean > b.mean ? '警戒型' : '無警戒型';
  console.log(
    `  ${label.padEnd(22)} ${mark(t)}${t.survived}/${t.total}  ` +
      `警戒型 ${a.mean.toFixed(0).padStart(4)}  無警戒型 ${b.mean.toFixed(0).padStart(4)}  ` +
      `肉食 ${c.mean.toFixed(0).padStart(4)}   → ${winner}の勝ち`,
  );
}

header('視野コストを振る（肉食あり / 5シード）');
console.log(`  警戒型の実効代謝 = 0.40 + 視野コスト×3`);
await group(
  [0, 0.02, 0.05, 0.08, 0.12, 0.18],
  (vc) => build(vc, true)(),
  (vc, t) => row(`コスト${vc.toFixed(2)} (実効${effVigilant(vc).toFixed(2)})`, t),
  { seeds: [1000, 2000, 3000, 4000, 5000] },
);

header('交差点を詰める（8シード）');
await group(
  [0.025, 0.03, 0.035, 0.04, 0.045],
  (vc) => build(vc, true)(),
  (vc, t) => row(`コスト${vc.toFixed(3)}`, t),
  { seeds: SEEDS_8 },
);

header('対照: 肉食を消すと目の価値が消える（8シード）');
await group(
  [0, 0.025, 0.03],
  (vc) => build(vc, false)(),
  (vc, t) => row(`コスト${vc.toFixed(3)} 肉食なし`, t),
  { seeds: SEEDS_8 },
);

done(t0);
