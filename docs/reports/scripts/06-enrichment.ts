import { presetByKey } from '../../../src/core/presets.ts';
import type { WorldConfig } from '../../../src/core/types.ts';
import { trial, header, done, mark } from './_lib.ts';

/**
 * レポート06: 環境を豊かにすると何が起きるか
 *
 *   node docs/reports/scripts/06-enrichment.ts
 *
 * 「豊穣化のパラドックス」（餌を増やすと捕食者-被食者系が不安定化する）が
 * このモデルに出るのかを、草の回復速度と草食の繁殖確率の2通りで確かめる。
 * 所要6分ほど。
 */

const t0 = performance.now();
const SEEDS_8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
const CELLS = 120 * 90;

function row(label: string, build: () => WorldConfig) {
  const t = trial(build, { seeds: SEEDS_8, steps: 6000, tail: 3000 });
  const cols = t.species.map(
    (s) => `${s.name} ${s.mean.toFixed(0).padStart(4)}(${String(s.min).padStart(4)}-${String(s.max).padStart(4)})`,
  );
  console.log(
    `  ${label.padEnd(30)} ${mark(t)}${t.survived}/${t.total}  ${cols.join('  ')}` +
      `  ${t.extinctAt.length ? '絶滅@' + t.extinctAt.join(',') : ''}`,
  );
}

for (const key of ['basic', 'pursuit'] as const) {
  header(`${key}: 草の回復速度を上げる（本来の意味の豊穣化）`);
  for (const r of [0.04, 0.06, 0.09, 0.12, 0.18, 0.25]) {
    const cap = ((r * CELLS) / 0.6).toFixed(0);
    row(`回復${r.toFixed(2)} (草食上限≈${cap})`, () => {
      const cfg = presetByKey(key).build();
      cfg.grass.regrow = r;
      return cfg;
    });
  }

  header(`${key}: 草食の繁殖確率を上げる`);
  for (const p of [0.08, 0.12, 0.16, 0.2, 0.25]) {
    row(`繁殖確率${p.toFixed(2)}`, () => {
      const cfg = presetByKey(key).build();
      cfg.species[0].reproduceProb = p;
      return cfg;
    });
  }
}

done(t0);
