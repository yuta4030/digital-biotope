import { presetByKey } from '../../../src/core/presets.ts';
import { runSweep, toCsv, type SweepAxis } from '../../../src/sweep/sweep.ts';
import { done, banner } from './_lib.ts';

/**
 * レポート01: 3層の共存域を探す
 *
 *   node docs/reports/scripts/01-coexistence-region.ts
 *
 * 肉食動物の代謝と捕食利得を総当たりして、どこで共存するかを調べる。
 * 所要40秒ほど。
 */

const axes: SweepAxis[] = [
  {
    label: '肉食_代謝',
    values: [0.3, 0.4, 0.5, 0.6, 0.8, 1.0],
    apply: (cfg, v) => (cfg.species[1].metabolism = v),
  },
  {
    label: '肉食_捕食利得',
    values: [12, 15, 18, 22, 26, 30],
    apply: (cfg, v) => (cfg.species[1].gainFromPrey = v),
  },
];

const t0 = performance.now();
banner();

const rows = await runSweep(presetByKey('basic').build(), axes, {
  steps: 4000,
  tail: 2000,
  repeats: 3,
  baseSeed: 1000,
  // ファイルへリダイレクトすると \r が改行になってしまうので端末のときだけ出す
  onProgress: (d, n) => {
    if (process.stdout.isTTY) process.stdout.write(`\r探索中 ${d}/${n}`);
  },
});

if (process.stdout.isTTY) process.stdout.write('\r'.padEnd(30) + '\r');
console.log('  代謝  利得  生存    草食(平均 最小-最大)      肉食(平均 最小-最大)');
console.log('  ' + '-'.repeat(66));

for (const row of rows) {
  const m = row.survivedCount === row.repeats ? 'OK' : row.survivedCount === 0 ? '--' : ' △';
  const cells = row.species.map(
    (s) => `${s.mean.toFixed(0).padStart(5)}(${String(s.min).padStart(4)}-${String(s.max).padStart(4)})`,
  );
  console.log(
    `  ${String(row.values['肉食_代謝']).padStart(4)}` +
      `  ${String(row.values['肉食_捕食利得']).padStart(4)}` +
      `  ${m}${row.survivedCount}/${row.repeats}  ${cells.join('  ')}`,
  );
}

console.log('\nCSV: ' + toCsv(rows).split('\n').length + ' 行（npm run sweep で data/sweep.csv に出力される）');
done(t0);
