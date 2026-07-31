import type { SpeciesResult } from './run.ts';
import { runMany, type Job } from './pool.ts';
import type { WorldConfig } from '../core/types.ts';

// runOne を直接使う呼び出し元のために通しておく
export { runOne } from './run.ts';
export type { RunResult, SpeciesResult } from './run.ts';

/** 探索する軸。値ごとに config を書き換える */
export interface SweepAxis {
  label: string;
  values: number[];
  apply(config: WorldConfig, value: number): void;
}

export interface SweepOptions {
  steps: number;
  tail: number;
  /** 同じ条件を何回、異なるシードで試すか。運で生き残った条件を弾く */
  repeats: number;
  baseSeed: number;
  /** 終わった run の数と総数。条件数ではなく run 数（条件数 × repeats） */
  onProgress?(done: number, total: number): void;
}

export interface SweepRow {
  /** 軸ラベル -> 値 */
  values: Record<string, number>;
  /** repeats 回のうち全種生存した回数 */
  survivedCount: number;
  repeats: number;
  species: SpeciesResult[];
  grassMean: number;
  grassProduced: number;
  corpseInput: number;
}

/**
 * 全軸の直積を走査する。
 *
 * 条件×繰り返しをまとめてワーカーに渡す。1条件ずつ待つと、
 * 繰り返し回数がスレッド数より少ないときに遊ぶスレッドが出る。
 */
export async function runSweep(
  base: WorldConfig,
  axes: SweepAxis[],
  opts: SweepOptions,
): Promise<SweepRow[]> {
  const total = axes.reduce((a, ax) => a * ax.values.length, 1);
  const rows: SweepRow[] = [];

  const indices = new Array<number>(axes.length).fill(0);
  const valuesPerCombo: Record<string, number>[] = [];
  const jobs: Job[] = [];

  for (let combo = 0; combo < total; combo++) {
    // combo を各軸の添字に分解する
    let rest = combo;
    for (let a = axes.length - 1; a >= 0; a--) {
      indices[a] = rest % axes[a].values.length;
      rest = Math.floor(rest / axes[a].values.length);
    }

    const values: Record<string, number> = {};
    for (let r = 0; r < opts.repeats; r++) {
      const cfg = structuredClone(base);
      cfg.seed = opts.baseSeed + r * 7919;
      axes.forEach((ax, a) => {
        const v = ax.values[indices[a]];
        values[ax.label] = v;
        ax.apply(cfg, v);
      });
      jobs.push({ config: cfg, steps: opts.steps, tail: opts.tail });
    }
    valuesPerCombo.push(values);
  }

  const all = await runMany(jobs, (n) => opts.onProgress?.(n, jobs.length));

  for (let combo = 0; combo < total; combo++) {
    const values = valuesPerCombo[combo];
    const results = all.slice(combo * opts.repeats, (combo + 1) * opts.repeats);
    const nSpecies = results[0].species.length;
    rows.push({
      values,
      survivedCount: results.filter((r) => r.survived).length,
      repeats: opts.repeats,
      grassMean: avg(results.map((r) => r.grassMean)),
      grassProduced: avg(results.map((r) => r.grassProduced)),
      corpseInput: avg(results.map((r) => r.corpseInput)),
      species: Array.from({ length: nSpecies }, (_, i) => ({
        id: results[0].species[i].id,
        name: results[0].species[i].name,
        mean: avg(results.map((r) => r.species[i].mean)),
        min: Math.min(...results.map((r) => r.species[i].min)),
        max: Math.max(...results.map((r) => r.species[i].max)),
        sd: avg(results.map((r) => r.species[i].sd)),
        killed: avg(results.map((r) => r.species[i].killed)),
        crowded: avg(results.map((r) => r.species[i].crowded)),
        // 測れた試行だけで平均する。絶滅した試行の定義値を混ぜると
        // 初期速度に引き寄せられた偽の数字になる
        ...speedOver(results.map((r) => r.species[i])),
      })),
    });
  }

  return rows;
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * 複数試行の速度をまとめる。測れた試行が1つも無ければ、
 * 定義値をそのまま返したうえで speedSamples を0にして知らせる。
 */
function speedOver(
  rs: SpeciesResult[],
): Pick<SpeciesResult, 'speedMean' | 'speedSd' | 'speedSamples'> {
  const measured = rs.filter((r) => r.speedSamples > 0);
  const samples = rs.reduce((a, r) => a + r.speedSamples, 0);
  if (measured.length === 0) {
    return { speedMean: rs[0].speedMean, speedSd: 0, speedSamples: 0 };
  }
  return {
    speedMean: avg(measured.map((r) => r.speedMean)),
    speedSd: avg(measured.map((r) => r.speedSd)),
    speedSamples: samples,
  };
}

/** 表計算や pandas で読める形にする */
export function toCsv(rows: SweepRow[]): string {
  if (rows.length === 0) return '';

  const axisLabels = Object.keys(rows[0].values);
  const header = [
    ...axisLabels,
    'survived',
    'repeats',
    'grass_mean',
    'grass_produced',
    'corpse_input',
    ...rows[0].species.flatMap((s) => [
      `${s.name}_mean`,
      `${s.name}_min`,
      `${s.name}_max`,
      `${s.name}_speed`,
    ]),
  ];

  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        ...axisLabels.map((l) => row.values[l]),
        row.survivedCount,
        row.repeats,
        row.grassMean.toFixed(1),
        row.grassProduced.toFixed(2),
        row.corpseInput.toFixed(2),
        ...row.species.flatMap((s) => [
          s.mean.toFixed(1),
          s.min,
          s.max,
          s.speedMean.toFixed(3),
        ]),
      ].join(','),
    );
  }
  return lines.join('\n');
}
