import { World } from '../core/world.ts';
import { step } from '../core/step.ts';
import type { WorldConfig } from '../core/types.ts';

export interface SpeciesResult {
  id: number;
  name: string;
  mean: number;
  min: number;
  max: number;
}

export interface RunResult {
  survived: boolean;
  /** 最初にどれかの種が絶滅したステップ。生存し切ったら -1 */
  extinctAt: number;
  species: SpeciesResult[];
  grassMean: number;
}

/**
 * 1条件を1回走らせる。
 *
 * 統計は後半 tail ステップぶんだけ取る。序盤は初期配置から落ち着くまでの
 * 過渡状態で、共存できるかどうかの判断には邪魔なため。
 */
export function runOne(config: WorldConfig, steps: number, tail: number): RunResult {
  const w = new World(config);
  const n = w.defs.length;

  const counts = new Int32Array(n);
  const sum = new Float64Array(n);
  const min = new Float64Array(n).fill(Infinity);
  const max = new Float64Array(n).fill(0);

  let samples = 0;
  let grassSum = 0;
  let grassSamples = 0;
  let extinctAt = -1;

  const tailFrom = steps - tail;

  for (let s = 0; s < steps; s++) {
    step(w);
    w.countBySpecies(counts);

    if (extinctAt < 0) {
      for (let i = 0; i < n; i++) {
        if (counts[i] === 0) {
          extinctAt = s;
          break;
        }
      }
    }

    if (s >= tailFrom) {
      for (let i = 0; i < n; i++) {
        const c = counts[i];
        sum[i] += c;
        if (c < min[i]) min[i] = c;
        if (c > max[i]) max[i] = c;
      }
      samples++;

      // 草の総量はセル数ぶん舐めるので間引く
      if (s % 50 === 0) {
        let g = 0;
        for (let c = 0; c < w.cells; c++) g += w.grass[c];
        grassSum += g;
        grassSamples++;
      }
    }
  }

  return {
    survived: extinctAt < 0,
    extinctAt,
    grassMean: grassSamples > 0 ? grassSum / grassSamples : 0,
    species: w.defs.map((def, i) => ({
      id: def.id,
      name: def.name,
      mean: samples > 0 ? sum[i] / samples : 0,
      min: min[i] === Infinity ? 0 : min[i],
      max: max[i],
    })),
  };
}

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
}

/** 1条件ぶんの展開結果。configs は repeats 個（シードだけが違う） */
export interface SweepCombo {
  values: Record<string, number>;
  configs: WorldConfig[];
}

/**
 * 全軸の直積を、走らせる直前の config の列まで展開する。
 *
 * 軸の apply は関数で worker に送れないので、展開はメインスレッドで済ませ、
 * 並列実行側には確定した config だけを渡す。直列版と並列版がまったく同じ
 * config を作ることを、この関数を共有することで担保する。
 */
export function expandSweep(
  base: WorldConfig,
  axes: SweepAxis[],
  opts: SweepOptions,
): SweepCombo[] {
  const total = axes.reduce((a, ax) => a * ax.values.length, 1);
  const indices = new Array<number>(axes.length).fill(0);
  const combos: SweepCombo[] = [];

  for (let combo = 0; combo < total; combo++) {
    // combo を各軸の添字に分解する
    let rest = combo;
    for (let a = axes.length - 1; a >= 0; a--) {
      indices[a] = rest % axes[a].values.length;
      rest = Math.floor(rest / axes[a].values.length);
    }

    const values: Record<string, number> = {};
    const configs: WorldConfig[] = [];

    for (let r = 0; r < opts.repeats; r++) {
      const cfg = structuredClone(base);
      cfg.seed = opts.baseSeed + r * 7919;
      axes.forEach((ax, a) => {
        const v = ax.values[indices[a]];
        values[ax.label] = v;
        ax.apply(cfg, v);
      });
      configs.push(cfg);
    }

    combos.push({ values, configs });
  }

  return combos;
}

/** 同一条件の repeats 回ぶんの結果を1行にまとめる */
export function aggregateRow(
  values: Record<string, number>,
  results: RunResult[],
): SweepRow {
  const nSpecies = results[0].species.length;
  return {
    values,
    survivedCount: results.filter((r) => r.survived).length,
    repeats: results.length,
    grassMean: avg(results.map((r) => r.grassMean)),
    species: Array.from({ length: nSpecies }, (_, i) => ({
      id: results[0].species[i].id,
      name: results[0].species[i].name,
      mean: avg(results.map((r) => r.species[i].mean)),
      min: Math.min(...results.map((r) => r.species[i].min)),
      max: Math.max(...results.map((r) => r.species[i].max)),
    })),
  };
}

/**
 * 全軸の直積を走査する（単一スレッド）。
 * 並列に回すなら sweep/pool.ts の runSweepParallel を使う。
 */
export function runSweep(
  base: WorldConfig,
  axes: SweepAxis[],
  opts: SweepOptions,
): SweepRow[] {
  const combos = expandSweep(base, axes, opts);

  return combos.map((combo, i) => {
    const results = combo.configs.map((cfg) => runOne(cfg, opts.steps, opts.tail));
    opts.onProgress?.(i + 1, combos.length);
    return aggregateRow(combo.values, results);
  });
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
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
    ...rows[0].species.flatMap((s) => [`${s.name}_mean`, `${s.name}_min`, `${s.name}_max`]),
  ];

  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        ...axisLabels.map((l) => row.values[l]),
        row.survivedCount,
        row.repeats,
        row.grassMean.toFixed(1),
        ...row.species.flatMap((s) => [s.mean.toFixed(1), s.min, s.max]),
      ].join(','),
    );
  }
  return lines.join('\n');
}
