import { World } from '../core/world.ts';
import { step } from '../core/step.ts';
import type { WorldConfig } from '../core/types.ts';

/**
 * 途中経過を記録しながら1条件を回す。
 *
 * 遺伝する形質は世代を通してしか動かないので、後半平均だけでは
 * 「まだ動いている途中」と「落ち着いた」が区別できない。
 * 収束を主張するには経過を並べる必要がある（docs/reports/07 参照）。
 */
export interface TraceOptions {
  steps: number;
  /** 何ステップごとに記録するか */
  every: number;
  /** 最後に速度の分布も返す場合の刻み幅 */
  histogramBin?: number;
}

export interface TraceMark {
  step: number;
  /** 種インデックス別の平均速度と標準偏差 */
  speedMean: number[];
  speedSd: number[];
  population: number[];
}

export interface TraceResult {
  marks: TraceMark[];
  /** 種インデックス0の速度の分布。histogramBin を指定したときだけ入る */
  histogram?: { bin: number; counts: number[]; total: number };
}

export function runTrace(config: WorldConfig, opts: TraceOptions): TraceResult {
  const w = new World(config);
  const n = w.defs.length;
  const mean = new Float64Array(n);
  const sd = new Float64Array(n);
  const counts = new Int32Array(n);
  const marks: TraceMark[] = [];

  for (let s = 0; s < opts.steps; s++) {
    step(w);
    if ((s + 1) % opts.every !== 0) continue;

    w.speedStats(mean, sd);
    w.countBySpecies(counts);
    marks.push({
      step: s + 1,
      speedMean: Array.from(mean),
      speedSd: Array.from(sd),
      population: Array.from(counts),
    });
  }

  if (opts.histogramBin === undefined) return { marks };

  const bin = opts.histogramBin;
  const hist: number[] = [];
  let total = 0;
  for (let i = 0; i < w.count; i++) {
    if (w.aSpecies[i] !== 0) continue;
    const b = Math.floor(w.aSpeed[i] / bin);
    while (hist.length <= b) hist.push(0);
    hist[b]++;
    total++;
  }
  return { marks, histogram: { bin, counts: hist, total } };
}

export interface SpeciesResult {
  id: number;
  name: string;
  mean: number;
  min: number;
  max: number;
  /**
   * 集計区間での平均移動速度と、集団内のばらつき（標準偏差の平均）。
   *
   * speedSamples が0のとき、この値は測定値ではなく定義値。
   * 種が絶滅していても定義値が入るので、**生存しなかった試行の速度を
   * そのまま平均に混ぜてはいけない**。混ぜると初期速度に引き寄せられた
   * 偽の数字が出る。
   */
  speedMean: number;
  speedSd: number;
  /** 速度を実際に測れた回数。0 なら集計区間にこの種の個体がいなかった */
  speedSamples: number;
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

  // 速度の集計。個体がいない種を平均に混ぜないよう、種ごとに標本数を数える
  const speedMean = new Float64Array(n);
  const speedSd = new Float64Array(n);
  const speedMeanSum = new Float64Array(n);
  const speedSdSum = new Float64Array(n);
  const speedSamples = new Float64Array(n);

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

      // 速度は個体数ぶん舐めるので、遺伝させる種がいるときだけ、しかも間引いて取る
      if (w.anyMutation && s % 10 === 0) {
        w.speedStats(speedMean, speedSd);
        for (let i = 0; i < n; i++) {
          if (counts[i] === 0) continue;
          speedMeanSum[i] += speedMean[i];
          speedSdSum[i] += speedSd[i];
          speedSamples[i]++;
        }
      }

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
      speedMean: speedSamples[i] > 0 ? speedMeanSum[i] / speedSamples[i] : def.speed,
      speedSd: speedSamples[i] > 0 ? speedSdSum[i] / speedSamples[i] : 0,
      speedSamples: speedSamples[i],
    })),
  };
}
