import { presetByKey } from '../../../src/core/presets.ts';
import { World } from '../../../src/core/world.ts';
import { step } from '../../../src/core/step.ts';
import { trial, header, done, mark, speedOf } from './_lib.ts';
import type { WorldConfig } from '../../../src/core/types.ts';

/**
 * レポート07: 移動速度を遺伝させる
 *
 *   node docs/reports/scripts/07-speed-evolution.ts
 *
 * 「進化」構成で、速度がどこへ落ち着くかと、そこが集団にとって
 * 良い場所なのかを調べる。所要40分ほど（視野ありの節が重い）。
 */

const t0 = performance.now();
const SEEDS_8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
const SEEDS_4 = [1000, 2000, 3000, 4000];
const SEEDS_3 = [1000, 2000, 3000];

/**
 * 収束先を測る節は長めに回す。上から出発した集団は降りるのが遅く、
 * 10000ステップでは途中の値を「収束先」と読み違える
 */
const LONG = 20000;
const LONG_TAIL = 4000;
/** 収束が速い節（初期値から動かない対照、速度を固定した比較）はこれで足りる */
const SHORT = 10000;
const SHORT_TAIL = 2000;

interface Opts {
  /** 初期個体に配る速度。ここから動かして収束先を見る */
  start: number;
  /** 子に乗るずれの標準偏差 */
  sigma?: number;
  /** 速い足の代償。0にすると選択が働かなくなる */
  speedCost?: number;
  /** 草食に視野を持たせる。捕食者を見て逃げられるようになる */
  vision?: number;
  predator?: boolean;
}

function build(o: Opts): () => WorldConfig {
  return () => {
    const cfg = presetByKey('evolution').build();
    const [herb, pred] = cfg.species;

    herb.speed = o.start;
    herb.mutation!.speedSigma = o.sigma ?? 0.05;
    if (o.speedCost !== undefined) herb.speedCost = o.speedCost;
    if (o.vision !== undefined) herb.visionRange = o.vision;
    if (o.predator === false) pred.initialCount = 0;

    return cfg;
  };
}

function row(label: string, o: Opts, seeds = SEEDS_8, long = true): void {
  const t = trial(build(o), {
    seeds,
    steps: long ? LONG : SHORT,
    tail: long ? LONG_TAIL : SHORT_TAIL,
  });
  const [herb, pred] = t.species;
  console.log(
    `  ${label.padEnd(20)} ${mark(t)}${t.survived}/${t.total}  ` +
      `速度 ${speedOf(t).padEnd(20)} ばらつき ${herb.speedSd.toFixed(2)}  ` +
      `草食 ${herb.mean.toFixed(0).padStart(4)}  肉食 ${pred.mean.toFixed(0).padStart(4)}`,
  );
}

/**
 * 平均速度の時間発展を出す。
 *
 * 後半だけを平均する表では「まだ動いている途中」と「落ち着いた」が
 * 区別できない。上から出発した集団は降りるのが遅いので、
 * 到達したのかどうかは経過を並べて見るしかない。
 */
function trace(label: string, o: Opts, steps: number, every: number): void {
  const rows = SEEDS_3.map((seed) => {
    const cfg = build(o)();
    cfg.seed = seed;
    const w = new World(cfg);
    const mean = new Float64Array(w.defs.length);
    const sd = new Float64Array(w.defs.length);
    const marks: number[] = [];

    for (let s = 0; s < steps; s++) {
      step(w);
      if ((s + 1) % every === 0) {
        w.speedStats(mean, sd);
        marks.push(mean[0]);
      }
    }
    return marks;
  });

  const avg = rows[0].map(
    (_, i) => rows.reduce((a, r) => a + r[i], 0) / rows.length,
  );
  console.log(`  ${label.padEnd(24)} ${avg.map((v) => v.toFixed(2)).join('  →  ')}`);
}

// ---------------------------------------------------------------------------
// まず機構が効いていることを確かめる。変異を切れば動かず、
// 代償を外せば上限まで走り去るはず。どちらも外れたら以降の数字は読めない
// ---------------------------------------------------------------------------
header('対照: 変異と代償を外す（4シード）');
row('変異なし 初期1.0', { start: 1, sigma: 0 }, SEEDS_4, false);
row('変異なし 初期2.5', { start: 2.5, sigma: 0 }, SEEDS_4, false);
row('速度コスト0 初期1.0', { start: 1, speedCost: 0 }, SEEDS_4, false);

// ---------------------------------------------------------------------------
// 本題。同じ収束先に別々の初期値から辿り着くかどうかを見る。
// 1つの初期値から動いただけでは、選択で動いたのか流されただけなのか分からない
// ---------------------------------------------------------------------------
header('捕食者あり・視野なし: 初期速度を変えて収束先を見る（8シード・20000ステップ）');
for (const start of [0.5, 1, 2, 4]) {
  row(`初期 ${start.toFixed(1)}`, { start });
}

header('対照: 捕食者を消す（8シード・20000ステップ）');
// 肉食を0にした行は「肉食が絶滅している」ことになるので生存の記号は 0/8 で出る。
// ここで見たいのは草食の速度なので、その列は読み飛ばしてよい
for (const start of [1, 3]) {
  row(`初期 ${start.toFixed(1)} 肉食なし`, { start, predator: false });
}

header('平均速度の推移（3シード・10000ステップごと）');
for (const start of [1, 4]) {
  trace(`初期 ${start.toFixed(1)} 捕食者あり`, { start }, 40000, 10000);
  trace(`初期 ${start.toFixed(1)} 肉食なし`, { start, predator: false }, 40000, 10000);
}

// ---------------------------------------------------------------------------
// 05 で「視野の価値は捕食圧が生む」と分かっている。
// 速度についても同じことが言えるなら、逃げる手段を別に持たせると
// 速い足の価値は消えるはず
// ---------------------------------------------------------------------------
header('草食に視野3を与える（8シード・重い）');
row('視野3 捕食者あり', { start: 1, vision: 3 }, SEEDS_8, false);
row('視野3 肉食なし', { start: 1, vision: 3, predator: false }, SEEDS_8, false);

header('視野3で上から出発する（3シード・10000ステップごと）');
trace('初期 3.0 捕食者あり', { start: 3, vision: 3 }, 40000, 10000);

// ---------------------------------------------------------------------------
// 進化が辿り着いた速度は、集団にとって良い場所なのか。
// 速度を固定した集団と個体数を比べる
// ---------------------------------------------------------------------------
header('比較: 速度を固定した集団の個体数（8シード）');
for (const v of [1, 1.5, 2, 2.5, 2.75, 3, 3.5]) {
  row(`固定 ${v.toFixed(2)}`, { start: v, sigma: 0 }, SEEDS_8, false);
}

// ---------------------------------------------------------------------------
// 変異の強さを変えると収束先も動くのか。動くなら「最適点」ではなく
// 変異と選択の釣り合いを見ていることになる
// ---------------------------------------------------------------------------
header('変異の強さを振る（8シード）');
for (const sigma of [0.01, 0.02, 0.05, 0.1, 0.2]) {
  row(`σ=${sigma.toFixed(2)}`, { start: 1, sigma }, SEEDS_8, false);
}

done(t0);
