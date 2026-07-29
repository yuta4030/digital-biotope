import { presets, presetByKey } from '../../../src/core/presets.ts';
import { group, line, header, done, SEEDS } from './_lib.ts';

/**
 * レポート02: 構成の検証
 *
 *   node docs/reports/scripts/02-preset-validation.ts
 *
 * 全構成が成立するかの確認と、「雑食」「4層」で見つかった不具合の切り分け。
 * 並列に回す（worker 数は SWEEP_WORKERS で変えられる）。
 */

const t0 = performance.now();

header(`全構成（${SEEDS.length}シード × 8000ステップ）`);
await group(
  presets,
  (p) => p.build(),
  (p, t) => line(p.label, t),
);

header('競合: 捕食者を消すと劣位種はどうなるか');
await group(
  [true, false],
  (withPredator) => {
    const c = presetByKey('keystone').build();
    if (!withPredator) c.species[2].initialCount = 0;
    return c;
  },
  (withPredator, t) => line(withPredator ? '捕食者あり' : '捕食者なし', t),
);

header('雑食: 採食量と代謝(0.7)の大小が分かれ目');
await group(
  [3, 2, 1.2, 0.8, 0.4],
  (g) => {
    const c = presetByKey('omnivore').build();
    c.species[1].gainFromGrass = g;
    return c;
  },
  (g, t) => line(`採食量=${g}`, t),
);

header('4層: 頂点捕食者の代謝とピラミッドの形');
await group(
  [0.3, 0.45, 0.55, 0.65, 0.75],
  (m) => {
    const c = presetByKey('fourtier').build();
    c.species[2].metabolism = m;
    return c;
  },
  (m, t) => line(`頂点の代謝=${m}`, t, { range: false }),
);

done(t0);
