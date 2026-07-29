import { writeFileSync, mkdirSync } from 'node:fs';
import { defaultConfig } from '../core/presets.ts';
import { runSweep, toCsv, type SweepAxis, type SweepRow } from './sweep.ts';
import { defaultWorkerCount, runSweepParallel } from './pool.ts';

/**
 * パラメータ探索を回して CSV に落とす。
 *
 *   npm run sweep
 *   npm run sweep -- --serial      直列で回す（並列版との突き合わせ用）
 *   SWEEP_WORKERS=2 npm run sweep  worker 数を指定する
 *
 * 調べたい軸はここを直接書き換える。UI から回せるようにするより、
 * 軸の定義をコードで書けたほうが自由度が高い。
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

const STEPS = 4000;
const TAIL = 2000;
const REPEATS = 3;

const serial = process.argv.includes('--serial');
const workers = serial ? 1 : defaultWorkerCount();

const opts = {
  steps: STEPS,
  tail: TAIL,
  repeats: REPEATS,
  baseSeed: 1000,
  onProgress(done: number, total: number) {
    process.stdout.write(`\r探索中 ${done}/${total}`);
  },
};

const t0 = performance.now();

const rows: SweepRow[] = serial
  ? runSweep(defaultConfig(), axes, opts)
  : await runSweepParallel(defaultConfig(), axes, { ...opts, workers });

process.stdout.write('\r'.padEnd(30) + '\r');

const labels = Object.keys(rows[0].values);
const head = [...labels.map((l) => l.padStart(12)), '生存'.padStart(6)];
for (const s of rows[0].species) head.push(`${s.name}(平均 最小-最大)`.padStart(24));
console.log(head.join(' '));
console.log('-'.repeat(head.join(' ').length));

for (const row of rows) {
  const mark = row.survivedCount === row.repeats ? 'OK' : row.survivedCount === 0 ? '--' : '△';
  const cells = [
    ...labels.map((l) => String(row.values[l]).padStart(12)),
    `${mark} ${row.survivedCount}/${row.repeats}`.padStart(6),
  ];
  for (const s of row.species) {
    cells.push(`${s.mean.toFixed(0)} (${s.min}-${s.max})`.padStart(24));
  }
  console.log(cells.join(' '));
}

mkdirSync('data', { recursive: true });
const out = 'data/sweep.csv';
// BOM を付けないと日本語Windowsの Excel が ANSI と誤認して列名が化ける。
// pandas で読むときは encoding='utf-8-sig' を指定する。
writeFileSync(out, '﻿' + toCsv(rows), 'utf8');

const total = rows.length * REPEATS;
console.log(
  `\n${total} runs × ${STEPS} steps = ${((total * STEPS) / 1000).toFixed(0)}k steps` +
    ` / ${((performance.now() - t0) / 1000).toFixed(1)}s` +
    ` (${serial ? '直列' : `worker ${workers}`})`,
);
console.log(`→ ${out}`);
