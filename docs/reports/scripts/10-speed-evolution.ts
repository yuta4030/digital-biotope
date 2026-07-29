import { presetByKey } from '../../../src/core/presets.ts';
import { traceMany, type TraceJob } from '../../../src/sweep/pool.ts';
import { trial, header, done, mark, speedOf, banner } from './_lib.ts';
import type { WorldConfig } from '../../../src/core/types.ts';

/**
 * レポート07: 移動速度を遺伝させる
 *
 *   node docs/reports/scripts/10-speed-evolution.ts
 *
 * 「進化」構成で、速度がどこへ落ち着くかと、そこが集団にとって
 * 良い場所なのかを調べる。4スレッドで23分ほど（直列だと82分）。
 */

const t0 = performance.now();
banner();
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
  /** 草食の基礎代謝。上げると平衡個体数が下がる */
  metabolism?: number;
  /** 捕食1回で肉食が得るエネルギー。上げると養われる捕食者が増え、捕食圧が上がる */
  gainFromPrey?: number;
  /** 同じセルの獲物を捕らえる確率。1回あたりの危険さ */
  captureRate?: number;
  predator?: boolean;
}

/** 肉食の実効代謝。0.2 + 速度コスト0.15×2 + 視野コスト0.025×3 */
const PRED_METABOLISM = 0.575;

function build(o: Opts): () => WorldConfig {
  return () => {
    const cfg = presetByKey('evolution').build();
    const [herb, pred] = cfg.species;

    herb.speed = o.start;
    herb.mutation!.speedSigma = o.sigma ?? 0.05;
    if (o.speedCost !== undefined) herb.speedCost = o.speedCost;
    if (o.vision !== undefined) herb.visionRange = o.vision;
    if (o.metabolism !== undefined) herb.metabolism = o.metabolism;
    if (o.gainFromPrey !== undefined) pred.gainFromPrey = o.gainFromPrey;
    if (o.captureRate !== undefined) pred.captureRate = o.captureRate;
    if (o.predator === false) pred.initialCount = 0;

    return cfg;
  };
}

/** トレース用のジョブ。シードだけ差し替える */
function job(o: Opts, seed: number, steps: number, every: number): TraceJob {
  const config = build(o)();
  config.seed = seed;
  return { kind: 'trace', config, steps, every };
}

async function row(label: string, o: Opts, seeds = SEEDS_8, long = true): Promise<void> {
  const t = await trial(build(o), {
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
 * シードごとの平均速度の推移を1行ずつ出す。
 *
 * シード間で平均してしまうと、行き先が2つに割れている集団と
 * 中間に落ち着いた集団が同じ数字になる。割れているかどうかは
 * 平均する前の値を並べないと見えない。
 */
async function tracePerSeed(label: string, o: Opts, steps: number, every: number): Promise<void> {
  console.log(`  ${label}`);
  const rs = await traceMany(SEEDS_8.map((seed) => job(o, seed, steps, every)));

  rs.forEach((r, i) => {
    const marks = r.marks.map((m) =>
      m.population.some((c) => c === 0) ? ' 崩壊 ' : m.speedMean[0].toFixed(2),
    );
    console.log(`    seed ${SEEDS_8[i]}  ${marks.join('  →  ')}`);
  });
}

/**
 * 集団内の速度の分布を出す。
 *
 * 行き先が2つあると分かっても、それが「試行ごとにどちらかを選ぶ」のか
 * 「1つの集団の中で二型に割れる」のかは平均と標準偏差では区別できない。
 * 二山になっていれば後者、単峰なら前者。
 */
async function histograms(label: string, o: Opts, seeds: number[], steps: number): Promise<void> {
  const BIN = 0.25;
  const rs = await traceMany(
    seeds.map((seed) => ({ ...job(o, seed, steps, steps), histogramBin: BIN })),
  );

  rs.forEach((r, i) => {
    const last = r.marks[r.marks.length - 1];
    const h = r.histogram!;
    console.log(
      `  ${label} seed ${seeds[i]}: 平均 ${last.speedMean[0].toFixed(2)} ± ` +
        `${last.speedSd[0].toFixed(2)}（個体数 ${h.total}）`,
    );
    h.counts.forEach((c, b) => {
      if (c === 0) return;
      const bar = '#'.repeat(Math.round((c / h.total) * 40)) || '.';
      console.log(`    ${(b * h.bin).toFixed(2)}-${((b + 1) * h.bin).toFixed(2)}  ${String(c).padStart(4)}  ${bar}`);
    });
  });
}

/**
 * 平均速度の時間発展を出す。
 *
 * 後半だけを平均する表では「まだ動いている途中」と「落ち着いた」が
 * 区別できない。上から出発した集団は降りるのが遅いので、
 * 到達したのかどうかは経過を並べて見るしかない。
 */
async function trace(label: string, o: Opts, steps: number, every: number): Promise<void> {
  const rs = await traceMany(SEEDS_3.map((seed) => job(o, seed, steps, every)));
  const avg = rs[0].marks.map(
    (_, i) => rs.reduce((a, r) => a + r.marks[i].speedMean[0], 0) / rs.length,
  );
  console.log(`  ${label.padEnd(24)} ${avg.map((v) => v.toFixed(2)).join('  →  ')}`);
}

// ---------------------------------------------------------------------------
// まず機構が効いていることを確かめる。変異を切れば動かず、
// 代償を外せば上限まで走り去るはず。どちらも外れたら以降の数字は読めない
// ---------------------------------------------------------------------------
header('対照: 変異と代償を外す（4シード）');
await row('変異なし 初期1.0', { start: 1, sigma: 0 }, SEEDS_4, false);
await row('変異なし 初期2.5', { start: 2.5, sigma: 0 }, SEEDS_4, false);
await row('速度コスト0 初期1.0', { start: 1, speedCost: 0 }, SEEDS_4, false);

// ---------------------------------------------------------------------------
// 本題。同じ収束先に別々の初期値から辿り着くかどうかを見る。
// 1つの初期値から動いただけでは、選択で動いたのか流されただけなのか分からない
// ---------------------------------------------------------------------------
header('捕食者あり・視野なし: 初期速度を変えて収束先を見る（8シード・20000ステップ）');
for (const start of [0.5, 1, 2, 4]) {
  await row(`初期 ${start.toFixed(1)}`, { start });
}

header('対照: 捕食者を消す（8シード・20000ステップ）');
// 肉食を0にした行は「肉食が絶滅している」ことになるので生存の記号は 0/8 で出る。
// ここで見たいのは草食の速度なので、その列は読み飛ばしてよい
for (const start of [1, 3]) {
  await row(`初期 ${start.toFixed(1)} 肉食なし`, { start, predator: false });
}

header('平均速度の推移（3シード・10000ステップごと）');
for (const start of [1, 4]) {
  await trace(`初期 ${start.toFixed(1)} 捕食者あり`, { start }, 40000, 10000);
  await trace(`初期 ${start.toFixed(1)} 肉食なし`, { start, predator: false }, 40000, 10000);
}

// ---------------------------------------------------------------------------
// 05 で「視野の価値は捕食圧が生む」と分かっている。
// 速度についても同じことが言えるなら、逃げる手段を別に持たせると
// 速い足の価値は消えるはず
// ---------------------------------------------------------------------------
header('草食に視野3を与える（8シード・重い）');
await row('視野3 捕食者あり', { start: 1, vision: 3 }, SEEDS_8, false);
await row('視野3 肉食なし', { start: 1, vision: 3, predator: false }, SEEDS_8, false);

header('視野3で上から出発する（3シード・10000ステップごと）');
await trace('初期 3.0 捕食者あり', { start: 3, vision: 3 }, 40000, 10000);

// 視野3では捕食者がいるほうが遅い（0.76 対 0.83）。
// 捕食者が草食を減らして草の奪い合いが緩んだせいか、を確かめようとした節。
// 代謝を上げれば個体数は下がるが、餌を探す価値も同時に上がるので
// 切り分けにならない（下の結果を参照）
header('視野3・肉食なしで代謝を上げて密度を揃える（4シード）');
await row('代謝 0.25（既定）', { start: 1, vision: 3, predator: false }, SEEDS_4, false);
await row('代謝 0.44', { start: 1, vision: 3, predator: false, metabolism: 0.44 }, SEEDS_4, false);

// ---------------------------------------------------------------------------
// 捕食圧そのものを振る。
//
// 捕食者の頭数と捕食圧は別物で、視野3のほうが肉食は多い（461 対 337）のに
// 速度は低い。頭数ではなく「草食1個体あたり毎ステップどれだけ食われるか」で
// 見ないと、速度が何に反応しているのか分からない
// ---------------------------------------------------------------------------

/**
 * 定常状態では、捕食で得るエネルギーが捕食者の代謝と釣り合っている。
 * そこから毎ステップの捕食回数を逆算し、草食1個体あたりの被捕食率にする。
 */
async function pressureRow(label: string, o: Opts, gain: number, seeds = SEEDS_8): Promise<void> {
  const t = await trial(build(o), { seeds, steps: 15000, tail: 3000 });
  const [herb, pred] = t.species;

  if (t.survived === 0) {
    console.log(`  ${label.padEnd(20)} --0/${t.total}  （崩壊）`);
    return;
  }
  const risk = ((pred.mean * PRED_METABOLISM) / gain / herb.mean) * 100;
  console.log(
    `  ${label.padEnd(20)} ${mark(t)}${t.survived}/${t.total}  ` +
      `速度 ${speedOf(t).padEnd(20)} ` +
      `草食 ${herb.mean.toFixed(0).padStart(4)}  肉食 ${pred.mean.toFixed(0).padStart(4)}  ` +
      `被捕食率 ${risk.toFixed(2)}%/step`,
  );
}

header('捕獲成功率を振る（8シード）: つまみとして使えるか');
for (const cr of [0.02, 0.04, 0.08, 0.15]) {
  await pressureRow(`成功率 ${cr.toFixed(2)}`, { start: 1, captureRate: cr }, 18);
}

header('捕食利得で捕食圧を振る・視野0（8シード）');
for (const gain of [14, 16, 18, 22, 26, 32]) {
  await pressureRow(`利得 ${gain}`, { start: 1, gainFromPrey: gain }, gain);
}

header('捕食利得で捕食圧を振る・視野3（8シード・重い）');
for (const gain of [16, 18, 22, 26, 32]) {
  await pressureRow(`利得 ${gain} 視野3`, { start: 1, vision: 3, gainFromPrey: gain }, gain);
}

// 視野3で捕食圧を上げた行はシード間の幅が広い（利得26で 0.77-2.27）。
// 平均だけ見ると「中間に落ち着いた」ように読めるが、
// シードごとに並べると2つの行き先に割れている
header('視野3・利得26でシードごとに並べる（10000ステップごと）');
await tracePerSeed('視野3 利得26', { start: 1, vision: 3, gainFromPrey: 26 }, 40000, 10000);

// 2つの行き先それぞれで集団内の分布を見る。単峰なら試行ごとの分岐、
// 二山なら1つの集団の中で二型が共存していることになる
header('分岐した先での集団内の分布（40000ステップ時点）');
await histograms('視野3 利得26', { start: 1, vision: 3, gainFromPrey: 26 }, [1000, 5000, 7000, 4000], 40000);

// ---------------------------------------------------------------------------
// 進化が辿り着いた速度は、集団にとって良い場所なのか。
// 速度を固定した集団と個体数を比べる
// ---------------------------------------------------------------------------
header('比較: 速度を固定した集団の個体数（8シード）');
for (const v of [1, 1.5, 2, 2.5, 2.75, 3, 3.5]) {
  await row(`固定 ${v.toFixed(2)}`, { start: v, sigma: 0 }, SEEDS_8, false);
}

// ---------------------------------------------------------------------------
// 変異の強さを変えると収束先も動くのか。
//
// この表は10000ステップで打ち切っているので、変異が弱い行は
// 「低い所に落ち着いた」のではなく「まだ着いていない」。
// 次の節で長く回して確かめる
// ---------------------------------------------------------------------------
header('変異の強さを振る（8シード・10000ステップで打ち切り）');
for (const sigma of [0.01, 0.02, 0.05, 0.1, 0.2]) {
  await row(`σ=${sigma.toFixed(2)}`, { start: 1, sigma }, SEEDS_8, false);
}

header('変異が弱いときの推移（3シード・20000ステップごと）');
for (const sigma of [0.01, 0.02, 0.05]) {
  await trace(`σ=${sigma.toFixed(2)}`, { start: 1, sigma }, 80000, 20000);
}

await done(t0);
