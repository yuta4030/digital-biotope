import { presetByKey } from '../../../src/core/presets.ts';
import { trial, header, done, mark } from './_lib.ts';

/**
 * レポート05: 行動コストと視野への投資
 *
 *   node docs/reports/scripts/05-activity-cost.ts
 *
 * 「燃費」構成で、目に投資する価値がどこで消えるかを調べる。
 * 所要8分ほど。
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

function row(label: string, vc: number, pred: boolean, seeds = SEEDS_8) {
  const t = trial(build(vc, pred), { seeds });
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
for (const vc of [0, 0.02, 0.05, 0.08, 0.12, 0.18]) {
  row(`コスト${vc.toFixed(2)} (実効${effVigilant(vc).toFixed(2)})`, vc, true, [
    1000, 2000, 3000, 4000, 5000,
  ]);
}

header('交差点を詰める（8シード）');
for (const vc of [0.025, 0.03, 0.035, 0.04, 0.045]) {
  row(`コスト${vc.toFixed(3)}`, vc, true);
}

header('対照: 肉食を消すと目の価値が消える（8シード）');
for (const vc of [0, 0.025, 0.03]) {
  row(`コスト${vc.toFixed(3)} 肉食なし`, vc, false);
}

done(t0);
