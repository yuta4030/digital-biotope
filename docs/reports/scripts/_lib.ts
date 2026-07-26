import { runOne } from '../../../src/sweep/sweep.ts';
import type { WorldConfig } from '../../../src/core/types.ts';

/** レポートの既定。特に断りがなければこの条件で測っている */
export const SEEDS = [1000, 2000, 3000, 4000, 5000];
export const STEPS = 8000;
export const TAIL = 4000;

export interface Trial {
  survived: number;
  total: number;
  species: { name: string; mean: number; min: number; max: number }[];
  /** 崩壊した試行の絶滅ステップ */
  extinctAt: number[];
}

/**
 * 同じ条件をシードだけ変えて複数回走らせ、まとめる。
 * まぐれで生き残った条件を弾くため、1回では判断しない。
 */
export function trial(
  build: () => WorldConfig,
  opts: { seeds?: number[]; steps?: number; tail?: number } = {},
): Trial {
  const seeds = opts.seeds ?? SEEDS;
  const steps = opts.steps ?? STEPS;
  const tail = opts.tail ?? TAIL;

  const rs = seeds.map((seed) => {
    const cfg = build();
    cfg.seed = seed;
    return runOne(cfg, steps, tail);
  });

  return {
    survived: rs.filter((r) => r.survived).length,
    total: seeds.length,
    extinctAt: rs.filter((r) => !r.survived).map((r) => r.extinctAt),
    species: rs[0].species.map((s, i) => ({
      name: s.name,
      mean: rs.reduce((a, r) => a + r.species[i].mean, 0) / seeds.length,
      min: Math.min(...rs.map((r) => r.species[i].min)),
      max: Math.max(...rs.map((r) => r.species[i].max)),
    })),
  };
}

/** 生存の記号。全部生き残ったら OK、全滅なら --、まだらなら △ */
export function mark(t: Trial): string {
  if (t.survived === t.total) return 'OK';
  if (t.survived === 0) return '--';
  return ' △';
}

export function fmt(t: Trial, opts: { range?: boolean } = {}): string {
  return t.species
    .map((s) => {
      const head = `${s.name} ${s.mean.toFixed(0).padStart(4)}`;
      return opts.range === false
        ? head
        : `${head}(${String(s.min).padStart(3)}-${String(s.max).padStart(4)})`;
    })
    .join('  ');
}

export function line(label: string, t: Trial, opts: { range?: boolean } = {}): void {
  console.log(
    `  ${label.padEnd(26)} ${mark(t)}${t.survived}/${t.total}  ${fmt(t, opts)}`,
  );
}

export function header(title: string): void {
  console.log(`\n=== ${title} ===`);
}

/** 実行時間を表示して終える */
export function done(t0: number): void {
  console.log(`\n所要 ${((performance.now() - t0) / 1000).toFixed(0)}秒`);
}
