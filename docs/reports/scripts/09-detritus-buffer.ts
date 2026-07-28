import { presetByKey } from '../../../src/core/presets.ts';
import { World } from '../../../src/core/world.ts';
import { step } from '../../../src/core/step.ts';
import type { WorldConfig } from '../../../src/core/types.ts';
import { header, done } from './_lib.ts';

/**
 * レポート09: 死骸を均す — 時間と空間
 *
 *   node docs/reports/scripts/09-detritus-buffer.ts
 *
 * [08](../08-corpse-recycling.md) で「還元は同じエネルギーでも豊穣化より壊れやすい」
 * まで分かったが、その原因を流入の変動係数だと書いた。ここではまずその主張を
 * 検証し直し（崩壊した試行を含めて計算していた誤り）、
 * 時間方向の均し（在庫）と空間方向の均し（まき散らし）を分けて測る。
 *
 * 所要8分ほど。
 */

const t0 = performance.now();

const SEEDS8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
const STEPS = 6000;
const TAIL = 3000;

interface Result {
  survived: number;
  mean: number;
  min: number;
  max: number;
  total: number;
  /** 生き残った試行だけで求めた流入の変動係数 */
  cv: number;
  /** 全試行で求めた変動係数。崩壊した試行では流入が0で固まるので跳ね上がる */
  cvAll: number;
  detritus: number;
}

function measure(build: () => WorldConfig): Result {
  let survived = 0;
  let popSum = 0;
  let popMin = Infinity;
  let popMax = 0;
  let inputSum = 0;
  let detSum = 0;
  let n = 0;
  const alive: number[] = [];
  const all: number[] = [];

  for (const seed of SEEDS8) {
    const cfg = build();
    cfg.seed = seed;
    const w = new World(cfg);
    const counts = new Int32Array(w.defs.length);
    const series: number[] = [];
    let extinct = false;

    for (let s = 0; s < STEPS; s++) {
      step(w);
      w.countBySpecies(counts);
      for (let i = 0; i < w.defs.length; i++) if (counts[i] === 0) extinct = true;
      if (s < STEPS - TAIL) continue;

      popSum += counts[0];
      if (counts[0] < popMin) popMin = counts[0];
      if (counts[0] > popMax) popMax = counts[0];
      inputSum += w.grassAdded + w.grassFromCorpses;
      detSum += w.totalDetritus();
      series.push(w.grassFromCorpses);
      n++;
    }

    all.push(...series);
    if (!extinct) {
      survived++;
      alive.push(...series);
    }
  }

  const cv = (xs: number[]) => {
    if (xs.length === 0) return 0;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    if (m === 0) return 0;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) / m;
  };

  return {
    survived,
    mean: popSum / n,
    min: popMin,
    max: popMax,
    total: inputSum / n,
    cv: cv(alive),
    cvAll: cv(all),
    detritus: detSum / n,
  };
}

function row(label: string, r: Result, extra = ''): void {
  console.log(
    `  ${label.padEnd(18)} ${r.survived}/8  総入力${r.total.toFixed(0).padStart(5)}  ` +
      `変動係数${r.cv.toFixed(2)}  草食 ${r.mean.toFixed(0).padStart(4)}(${String(r.min).padStart(4)}-${String(r.max).padStart(4)})${extra}`,
  );
}

/** 08 の条件。肉食動物だけを還元し、80で崩壊する */
function corpse(amount: number, opts: { rate?: number; spread?: number; regrow?: number } = {}) {
  return () => {
    const c = presetByKey('basic').build();
    c.species[1].corpseGrass = amount;
    if (opts.spread !== undefined) c.species[1].corpseSpread = opts.spread;
    if (opts.rate !== undefined) c.grass.detritusRelease = opts.rate;
    if (opts.regrow !== undefined) c.grass.regrow = opts.regrow;
    return c;
  };
}

// ---------------------------------------------------------------------------
header('1. 08の変動係数は崩壊した試行に汚染されていた');
console.log('  崩壊すると死骸の流入が0で固まるので、変動係数が跳ね上がる。');
console.log('  「変動係数が高いから崩壊した」ではなく「崩壊したから高い」の可能性がある\n');
console.log('  条件            生存   全試行のCV   生存試行のみのCV');
for (const [label, build] of [
  ['肉食の還元40', corpse(40)],
  ['肉食の還元80', corpse(80)],
  [
    '両方の還元40',
    () => {
      const c = presetByKey('basic').build();
      c.species.forEach((s) => (s.corpseGrass = 40));
      return c;
    },
  ],
] as [string, () => WorldConfig][]) {
  const r = measure(build);
  console.log(
    `  ${label.padEnd(14)} ${r.survived}/8      ${r.cvAll.toFixed(2)}         ${r.cv.toFixed(2)}`,
  );
}

// ---------------------------------------------------------------------------
header('2. 時間方向に均す: 死骸を在庫に積み、放出率で絞る');
console.log('  放出率1が08と同じ挙動。下げるほど在庫が溜まって流入が均される');
for (const rate of [1, 0.3, 0.1, 0.03, 0.01]) {
  const r = measure(corpse(80, { rate }));
  row(`放出率${rate}`, r, `  在庫${r.detritus.toFixed(0)}`);
}

// ---------------------------------------------------------------------------
header('3. 放出率と回復速度の格子。総入力を揃えた行どうしで比べる');
console.log('  変動係数が生存を説明するなら、同じ総入力では低いCVほど良いはず');
console.log('  放出率  回復速度  生存  総入力  変動係数  草食の振れ幅');
for (const rate of [1, 0.1, 0.03, 0.01]) {
  for (const regrow of [0.05, 0.06, 0.07]) {
    const r = measure(corpse(80, { rate, regrow }));
    console.log(
      `  ${String(rate).padEnd(6)} ${String(regrow).padEnd(8)}  ${r.survived}/8  ` +
        `${r.total.toFixed(0).padStart(5)}   ${r.cv.toFixed(2)}     ` +
        `${r.mean.toFixed(0).padStart(4)}(${String(r.min).padStart(4)}-${String(r.max).padStart(4)})`,
    );
  }
}

// ---------------------------------------------------------------------------
header('4. 空間方向に均す: 死骸を半径ぶんの範囲にまき散らす');
console.log('  総入力も変動係数もほぼ動かないので、変わるのは空間の集中だけ');
console.log('  半径  セル数  生存  総入力  変動係数  草食の振れ幅');
for (const spread of [0, 1, 2, 3, 5]) {
  const r = measure(corpse(80, { spread }));
  console.log(
    `  ${String(spread).padEnd(4)} ${String((2 * spread + 1) ** 2).padStart(5)}   ${r.survived}/8  ` +
      `${r.total.toFixed(0).padStart(5)}   ${r.cv.toFixed(2)}     ` +
      `${r.mean.toFixed(0).padStart(4)}(${String(r.min).padStart(4)}-${String(r.max).padStart(4)})`,
  );
}

// ---------------------------------------------------------------------------
header('5. なぜ集中が効くのか（未解決）');
console.log('  山の上の個体は採食量(4)を丸ごと食べられる。代謝0.6に対し毎ステップ3.4の黒字で、');
console.log('  繁殖閾値20を数ステップで超える。山が繁殖の拠点になっている、が最初の仮説だった\n');
console.log('  半径  上限超セル  そこにいる割合  満腹で食えた割合  繁殖可能な割合  1セル最大個体数');

for (const spread of [0, 1, 3]) {
  let hot = 0;
  let onHot = 0;
  let full = 0;
  let fertile = 0;
  let maxPerCell = 0;
  let n = 0;

  for (const seed of SEEDS8.slice(0, 4)) {
    const cfg = corpse(80, { spread })();
    cfg.seed = seed;
    const w = new World(cfg);
    const max = w.config.grass.max;
    const ration = w.defs[0].gainFromGrass;
    const thr = w.defs[0].reproduceThreshold;
    const perCell = new Int32Array(w.cells);

    for (let s = 0; s < STEPS; s++) {
      // 採食前の草で判定する。ステップ後だと食べた結果を見てしまう
      const before = s >= STEPS - TAIL ? w.grass.slice() : null;
      step(w);
      if (!before) continue;

      let h = 0;
      for (let c = 0; c < w.cells; c++) if (before[c] > max) h++;
      hot += h;

      perCell.fill(0);
      let herb = 0;
      let on = 0;
      let canEat = 0;
      let canBreed = 0;
      for (let i = 0; i < w.count; i++) {
        if (w.aSpecies[i] !== 0) continue;
        herb++;
        const c = w.aY[i] * w.width + w.aX[i];
        perCell[c]++;
        if (before[c] > max) on++;
        if (before[c] >= ration) canEat++;
        if (w.aEnergy[i] >= thr) canBreed++;
      }
      if (herb === 0) continue;
      onHot += on / herb;
      full += canEat / herb;
      fertile += canBreed / herb;
      let m = 0;
      for (let c = 0; c < w.cells; c++) if (perCell[c] > m) m = perCell[c];
      maxPerCell += m;
      n++;
    }
  }

  console.log(
    `  ${String(spread).padEnd(4)} ${(hot / n).toFixed(0).padStart(9)}  ` +
      `${((onHot / n) * 100).toFixed(1).padStart(12)}%  ${((full / n) * 100).toFixed(1).padStart(14)}%  ` +
      `${((fertile / n) * 100).toFixed(1).padStart(12)}%  ${(maxPerCell / n).toFixed(1).padStart(13)}`,
  );
}

done(t0);
