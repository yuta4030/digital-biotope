import { World } from '../core/world.ts';
import { step } from '../core/step.ts';
import { Rng } from '../core/rng.ts';
import type { WorldConfig } from '../core/types.ts';

/**
 * 途中経過を記録しながら1条件を回す。
 *
 * 遺伝する形質は世代を通してしか動かないので、後半平均だけでは
 * 「まだ動いている途中」と「落ち着いた」が区別できない。
 * 収束を主張するには経過を並べる必要がある（docs/reports/10 参照）。
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

/**
 * 侵入の実験の設定。平衡に達した世界へ少数の個体を投入し、定着するかを何度も測る。
 *
 * 投入に使う乱数は世界本体とは**別のストリーム**から引く。同じ rng を使うと
 * 投入した回数だけ消費数がずれて、在来の挙動が「侵入者を入れなかった場合」と
 * 一致しなくなる。一致していることが、定着率を在来の状態と結びつけて読むための前提。
 * パッチ場（world.ts の buildPatchField）と同じ理由で同じ手を使っている。
 */
export interface InvasionOptions {
  /** 侵入者の種インデックス。これ以外の種はすべて在来として扱う */
  invaderIdx: number;
  /** 在来が平衡に落ち着くまで回すステップ数。ここでの投入はしない */
  warmup: number;
  /** 侵入を試す回数 */
  attempts: number;
  /** 1回に投入する個体数 */
  propagule: number;
  /**
   * true なら投入個体を同一セルに固める。既定 (false) は無作為なセルへ撒く。
   *
   * この模型は無性生殖でつがい探しが無く、草食は視野0で群れの利益も無いので、
   * 固めることに利点が1つも無い（1セルの草は最大8、採食量4なので2個体で空になる）。
   * 本編は false で回し、これは 09 の裏返しを1条件だけ確かめるための軸。
   */
  clumped: boolean;
  /** 侵入者がこの個体数に達したら定着とみなす */
  establishAt: number;
  /** 1回の試行の打ち切り。定着も絶滅もしないまま超えたら「判定なし」に数える */
  timeout: number;
  /**
   * 定着した侵入者を除去してから次を投入するまでの最短の待ち。
   * 在来が元の分布に戻ってから次を入れるため。
   */
  recovery: number;
  /**
   * recovery に足す一様乱数の幅。0 だと投入が等間隔になり、在来の振動と
   * 同期して常に同じ位相で入れることになりうる（08 で踏んだ周期の罠）。
   * 谷で入れたかどうかを測りたいので、位相はばらけさせる。
   */
  jitter: number;
  /**
   * 定着した系統を追い続けるステップ数。0 なら到達時点で除去する（段A）。
   *
   * 1以上にすると**最初の定着でその走行の投入を打ち切り**、その系統を追う（段B）。
   * 打ち切るのは、本当に定着した侵入者は在来を置き換えてしまうため。
   * 置き換わった後の世界へ投入を続けても、測りたかった世界ではない。
   *
   * 段Aと分けたのは、閾値30への到達は「定着」ではなく「30体に達した」でしかなく、
   * そこから居座るかどうかは別に測らないと分からないため。
   */
  followUp: number;
  /** 追跡中に個体数を記録する刻み */
  followEvery: number;
}

/** 追跡の終わり方 */
export type FollowEnd =
  /** 追跡しきっても侵入者と在来が両方いる */
  | 'survived'
  /** 侵入者が消えた。30体に達しても居座るとは限らない */
  | 'lost'
  /** 在来のどれかが絶滅した。侵入者が置き換えた */
  | 'replaced';

export interface FollowResult {
  /** 定着（閾値到達）したステップ */
  from: number;
  /** followEvery ごとの個体数（種インデックス別） */
  marks: { offset: number; counts: number[] }[];
  end: FollowEnd;
  /** 追跡した長さ */
  followed: number;
}

/**
 * 1回の投入の結末。
 *
 * timeout を失敗に混ぜない。混ぜると「判定できなかった」が「定着しなかった」に化けて、
 * 閾値や打ち切りが短すぎることに気づけなくなる。
 */
export type InvasionOutcome = 'established' | 'lost' | 'timeout';

export interface InvasionAttempt {
  /** 投入したステップ */
  step: number;
  /**
   * 投入した瞬間の個体数（種インデックス別、侵入者は0）。
   *
   * 在来だけでなく捕食者も入れてある。捕食者は在来と位相がずれるので、
   * 「在来が谷」は同時に「捕食圧が高い」を意味しうる。分けて数えないと
   * どちらが効いているか言えない（08 で踏んだ交絡と同じ形）。
   */
  resident: number[];
  /**
   * 投入した瞬間の草の総量。在来が少ない時期は1個体あたりの草が多いので、
   * 谷の効果が「侵入の機会」ではなく単なる密度依存かもしれない。
   * その切り分けに要る量なので、代弁させずに直接測る。
   */
  grass: number;
  outcome: InvasionOutcome;
  /** 結末までに掛かったステップ数 */
  waited: number;
}

export interface InvasionResult {
  attempts: InvasionAttempt[];
  /**
   * 在来のどれかが絶滅したステップ。-1 なら最後まで保った。
   *
   * 崩壊すると在来の個体数分布そのものが変わるので、それ以降の投入は
   * 別の世界を測ることになる。09 で「崩壊したから変動係数が高い」のを
   * 「変動係数が高いから崩壊した」と読んだ失敗があるので、崩壊で打ち切る。
   */
  collapsedAt: number;
  /**
   * warmup 以降の在来個体数（種インデックス別）。揺らぎの大きさを測る側として要る。
   *
   * 侵入者がいる区間も含めて毎ステップ取っている。除くと、定着が起きた区間
   * （= 在来が谷にいた区間）だけが抜けて最小値が上に偏るため。
   * 侵入者は多くても establishAt 体なので、在来への影響は数%に収まる。
   */
  resident: { name: string; mean: number; sd: number; min: number; max: number }[];
  /**
   * warmup 以降の草の総量の平均。attempt.grass を比に直す基準に使う。
   * セル数ぶん舐めるので runOne と同じく間引いて取る
   */
  grassMean: number;
  /**
   * 段Bの追跡。followUp > 0 で、実際に定着が起きた走行にだけ入る。
   *
   * 追跡中は在来の統計を取らない。侵入者が数百体まで増えるので、
   * その区間の在来個体数は「侵入者を入れなかった世界」の値ではなくなる。
   */
  follow?: FollowResult;
}

/**
 * 閾値に達した系統を追う。段Bの中身。
 *
 * ここでは在来の絶滅を「崩壊」として扱わない。**それは侵入者が置き換えたという
 * 結果そのもの**であって、測定を捨てる理由ではないため。段Aで崩壊を外すのは
 * 「投入と無関係に壊れた世界の定着率は測りたいものではない」という理由なので、
 * 置き換えとは別の話になる。
 */
function followLineage(
  w: World,
  counts: Int32Array,
  inv: number,
  opts: InvasionOptions,
): FollowResult {
  const from = w.stepCount;
  const marks: { offset: number; counts: number[] }[] = [];
  let end: FollowEnd = 'survived';
  let followed = 0;

  while (followed < opts.followUp) {
    step(w);
    w.countBySpecies(counts);
    followed++;

    if (followed % opts.followEvery === 0) {
      marks.push({ offset: followed, counts: Array.from(counts) });
    }
    if (counts[inv] === 0) {
      end = 'lost';
      break;
    }
    if (!residentsAlive(counts, inv)) {
      end = 'replaced';
      break;
    }
  }

  return { from, marks, end, followed };
}

/** 侵入者を除く全種が生存しているか */
function residentsAlive(counts: Int32Array, invaderIdx: number): boolean {
  for (let i = 0; i < counts.length; i++) {
    if (i !== invaderIdx && counts[i] === 0) return false;
  }
  return true;
}

export function runInvasion(config: WorldConfig, opts: InvasionOptions): InvasionResult {
  const w = new World(config);
  const n = w.defs.length;
  const inv = opts.invaderIdx;
  const counts = new Int32Array(n);

  // 世界本体の乱数列を汚さないための別ストリーム。定数は他の派生ストリームと重ならない値
  const rng = new Rng((config.seed ^ 0x2f6a1c53) >>> 0);
  const energy = w.defs[inv].initialEnergy;

  const sum = new Float64Array(n);
  const sqSum = new Float64Array(n);
  const min = new Float64Array(n).fill(Infinity);
  const max = new Float64Array(n).fill(0);
  let samples = 0;
  let grassSum = 0;
  let grassSamples = 0;

  let collapsedAt = -1;
  let follow: FollowResult | undefined;
  const attempts: InvasionAttempt[] = [];

  const totalGrass = (): number => {
    let g = 0;
    for (let c = 0; c < w.cells; c++) g += w.grass[c];
    return g;
  };

  /** 1ステップ進めて在来の個体数を集計する。崩壊したら false */
  const advance = (): boolean => {
    step(w);
    w.countBySpecies(counts);
    for (let i = 0; i < n; i++) {
      if (i === inv) continue;
      const c = counts[i];
      sum[i] += c;
      sqSum[i] += c * c;
      if (c < min[i]) min[i] = c;
      if (c > max[i]) max[i] = c;
    }
    samples++;
    // 草はセル数ぶん舐めるので間引く。runOne と同じ刻み
    if (samples % 50 === 0) {
      grassSum += totalGrass();
      grassSamples++;
    }
    if (collapsedAt < 0 && !residentsAlive(counts, inv)) {
      collapsedAt = w.stepCount;
      return false;
    }
    return true;
  };

  // warmup 中は統計を取らない。初期配置から落ち着くまでの過渡状態なので
  for (let s = 0; s < opts.warmup; s++) {
    step(w);
    w.countBySpecies(counts);
    if (!residentsAlive(counts, inv)) {
      collapsedAt = w.stepCount;
      break;
    }
  }

  /** 侵入者を全部取り除く。step の末尾と同じ手順なので、間に呼んでも整合する */
  const cull = (): void => {
    for (let i = 0; i < w.count; i++) if (w.aSpecies[i] === inv) w.aAlive[i] = 0;
    w.compact();
  };

  for (let a = 0; a < opts.attempts && collapsedAt < 0; a++) {
    w.countBySpecies(counts);
    const resident = Array.from(counts);
    resident[inv] = 0;
    const grassAt = totalGrass();

    if (opts.clumped) {
      const x = rng.int(w.width);
      const y = rng.int(w.height);
      for (let k = 0; k < opts.propagule; k++) w.spawn(inv, x, y, energy);
    } else {
      for (let k = 0; k < opts.propagule; k++) {
        w.spawn(inv, rng.int(w.width), rng.int(w.height), energy);
      }
    }

    let outcome: InvasionOutcome = 'timeout';
    let waited = 0;
    while (waited < opts.timeout) {
      if (!advance()) break;
      waited++;
      if (counts[inv] === 0) {
        outcome = 'lost';
        break;
      }
      if (counts[inv] >= opts.establishAt) {
        outcome = 'established';
        break;
      }
    }

    attempts.push({ step: w.stepCount, resident, grass: grassAt, outcome, waited });
    if (collapsedAt >= 0) break;

    // 段B: 最初の定着でこの走行の投入は終わり。あとはその系統を追う
    if (outcome === 'established' && opts.followUp > 0) {
      follow = followLineage(w, counts, inv, opts);
      break;
    }

    // lost なら侵入者はもう0なので何も起きない。timeout の居残りもここで消す
    if (outcome !== 'lost') cull();

    const gap = opts.recovery + (opts.jitter > 0 ? rng.int(opts.jitter) : 0);
    for (let g = 0; g < gap; g++) if (!advance()) break;
  }

  return {
    attempts,
    collapsedAt,
    follow,
    grassMean: grassSamples > 0 ? grassSum / grassSamples : 0,
    resident: w.defs.map((def, i) => {
      const mean = samples > 0 ? sum[i] / samples : 0;
      const variance = samples > 0 ? sqSum[i] / samples - mean * mean : 0;
      return {
        name: def.name,
        mean,
        sd: variance > 0 ? Math.sqrt(variance) : 0,
        min: min[i] === Infinity ? 0 : min[i],
        max: max[i],
      };
    }),
  };
}

export interface SpeciesResult {
  id: number;
  name: string;
  mean: number;
  min: number;
  max: number;
  /**
   * 集計区間での個体数の標準偏差。揺らぎの大きさを測る側として要る。
   *
   * 最小・最大だけだと1回の外れ値に引きずられる。揺らぎを軸にした操作
   * （13）では、平均を変えずに揺らぎだけ動かせているかを毎回確かめる必要がある。
   */
  sd: number;
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
  /**
   * 1ステップあたり実際に草に加わった量の平均。
   * 名目の生産量（回復速度 × セル数）から上限で捨てたぶんを引いたもの。
   * 草地を不均質にすると名目が同じでもここが下がるので、
   * 「不均質にした効果」と「実質的に痩せた効果」を切り分けるのに要る。
   */
  grassProduced: number;
  /**
   * 1ステップあたり死骸から草へ戻った量の平均。
   * 回復速度による生産（grassProduced）とは別口の流入なので、
   * 合計が世界に入る総エネルギーになる。豊穣化と切り分けるのに要る。
   */
  corpseInput: number;
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
  const sqSum = new Float64Array(n);
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
  let producedSum = 0;
  let corpseSum = 0;
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
        sqSum[i] += c * c;
        if (c < min[i]) min[i] = c;
        if (c > max[i]) max[i] = c;
      }
      samples++;
      // 生産量は step が計算済みなので毎ステップ足しても安い
      producedSum += w.grassAdded;
      corpseSum += w.grassFromCorpses;

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
    grassProduced: samples > 0 ? producedSum / samples : 0,
    corpseInput: samples > 0 ? corpseSum / samples : 0,
    species: w.defs.map((def, i) => {
      const mean = samples > 0 ? sum[i] / samples : 0;
      const variance = samples > 0 ? sqSum[i] / samples - mean * mean : 0;
      return {
      id: def.id,
      name: def.name,
      mean,
      min: min[i] === Infinity ? 0 : min[i],
      max: max[i],
      sd: variance > 0 ? Math.sqrt(variance) : 0,
      speedMean: speedSamples[i] > 0 ? speedMeanSum[i] / speedSamples[i] : def.speed,
      speedSd: speedSamples[i] > 0 ? speedSdSum[i] / speedSamples[i] : 0,
      speedSamples: speedSamples[i],
      };
    }),
  };
}
