import { World } from '../../../src/core/world.ts';
import { step } from '../../../src/core/step.ts';
import { presetByKey } from '../../../src/core/presets.ts';
import { trial, header, done, mark, banner } from './_lib.ts';

/**
 * レポート04: 代謝を下げると生態系が壊れる
 *
 *   node docs/reports/scripts/04-metabolism-stability.ts
 *
 * 4層で草食の代謝だけを下げると何が起きるか。
 * 3シードでは判断を誤るので8シードで測る。所要4分ほど。
 */

const t0 = performance.now();
banner();
const SEEDS_8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
const CELLS = 120 * 90;
const REGROW = 0.06;

const build = (m: number) => () => {
  const cfg = presetByKey('fourtier').build();
  cfg.species[0].metabolism = m;
  return cfg;
};

header('3シードだと 0.35 だけが不安定に見える（誤り）');
console.log('  代謝  生存   草食           中位           頂点');
for (const m of [0.45, 0.4, 0.35, 0.3, 0.25]) {
  const t = await trial(build(m), { seeds: [1000, 2000, 3000], steps: 6000, tail: 3000 });
  const cols = t.species.map((s) => `${s.mean.toFixed(0).padStart(4)}(max${String(s.max).padStart(5)})`);
  console.log(`  ${m.toFixed(2)}  ${mark(t)}${t.survived}/3  ${cols.join('  ')}`);
}

// 生存回数は0.55〜0.25でほぼ横ばいで、0.20に崖がある。
// 代謝とともに単調に動くのは生存回数ではなく振れ幅のほう。
header('8シードで測ると、単調なのは振れ幅であって生存回数ではない');
console.log('  代謝  生存    草食の振れ幅     絶滅ステップ      草食の理論上限');
for (const m of [0.55, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2]) {
  const t = await trial(build(m), { seeds: SEEDS_8, steps: 6000, tail: 3000 });
  const h = t.species[0];
  console.log(
    `  ${m.toFixed(2)}  ${mark(t)}${t.survived}/8   ${String(h.min).padStart(4)} - ${String(h.max).padStart(4)}` +
      `   ${(t.extinctAt.join(', ') || '-').padEnd(16)}  ${((REGROW * CELLS) / m).toFixed(0)}`,
  );
}

header('崩壊の経過（代謝0.35・seed1000）');
{
  const cfg = presetByKey('fourtier').build();
  cfg.seed = 1000;
  cfg.species[0].metabolism = 0.35;
  const w = new World(cfg);
  const counts = new Int32Array(3);
  console.log('  step   草食   中位   頂点  草/セル');
  for (let s = 0; s <= 600; s++) {
    if (s % 60 === 0) {
      w.countBySpecies(counts);
      let g = 0;
      for (let c = 0; c < w.cells; c++) g += w.grass[c];
      console.log(
        `  ${String(s).padStart(4)}  ${String(counts[0]).padStart(5)}  ` +
          `${String(counts[1]).padStart(5)}  ${String(counts[2]).padStart(5)}   ` +
          (g / w.cells).toFixed(2),
      );
    }
    step(w);
  }
}

await done(t0);
