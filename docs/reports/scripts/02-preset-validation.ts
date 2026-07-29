import { presets, presetByKey } from '../../../src/core/presets.ts';
import { trial, line, header, done, SEEDS, banner } from './_lib.ts';

/**
 * レポート02: 構成の検証
 *
 *   node docs/reports/scripts/02-preset-validation.ts
 *
 * 全構成が成立するかの確認と、「雑食」「4層」で見つかった不具合の切り分け。
 * 所要3分ほど。
 */

const t0 = performance.now();
banner();

header(`全構成（${SEEDS.length}シード × 8000ステップ）`);
for (const p of presets) {
  line(p.label, await trial(() => p.build()));
}

header('競合: 捕食者を消すと劣位種はどうなるか');
line('捕食者あり', await trial(() => presetByKey('keystone').build()));
line('捕食者なし', await trial(() => {
  const c = presetByKey('keystone').build();
  c.species[2].initialCount = 0;
  return c;
}));

header('雑食: 採食量と代謝(0.7)の大小が分かれ目');
for (const g of [3, 2, 1.2, 0.8, 0.4]) {
  line(`採食量=${g}`, await trial(() => {
    const c = presetByKey('omnivore').build();
    c.species[1].gainFromGrass = g;
    return c;
  }));
}

header('4層: 頂点捕食者の代謝とピラミッドの形');
for (const m of [0.3, 0.45, 0.55, 0.65, 0.75]) {
  line(`頂点の代謝=${m}`, await trial(() => {
    const c = presetByKey('fourtier').build();
    c.species[2].metabolism = m;
    return c;
  }), { range: false });
}

await done(t0);
