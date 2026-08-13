import { presetByKey } from '../../../src/core/presets.ts';
import { traceMany, type TraceJob } from '../../../src/sweep/pool.ts';
import { trial, header, done, mark, visionOf, banner } from './_lib.ts';
import type { WorldConfig } from '../../../src/core/types.ts';
import type { VisionProfile } from '../../../src/sweep/run.ts';

/**
 * レポート22: 採食規則（視野）を遺伝させる
 *
 *   node docs/reports/scripts/22-vision-evolution.ts
 *
 * [21](../21-r-star.md) が「視野の有無が2本目のニッチ軸を作っている」まで出したが、
 * そこでは視野は種の定数だった。**規則の違いが変異から出てくるのか**を測る。
 *
 * 10 が速度でやったことと同じ形にしてある（対照 → 収束先 → 分布 → 機構）ので、
 * 表はそのまま突き合わせられる。4スレッドで約31分。
 */

const t0 = performance.now();
banner();
const SEEDS_8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
const SEEDS_4 = [1000, 2000, 3000, 4000];

/**
 * 収束先を測る節。10 で「上から出発した集団は降りるのが遅い」を踏んでいるので、
 * 視野でも上（5）から出発する行を必ず入れて、同じ所へ着くかで判定する。
 */
const LONG = 20000;
const LONG_TAIL = 4000;
const SHORT = 10000;
const SHORT_TAIL = 2000;

interface Opts {
  /** 初期個体に配る視野。ここから動かして収束先を見る */
  start: number;
  /** 子に乗るずれの標準偏差。0 にすると初期値から動かない（対照） */
  sigma?: number;
  /** 見ることの代償。0 にすると選択が働かず上限まで走り去るはず */
  visionCost?: number;
  /** 視野の上限 */
  max?: number;
  /** 草食の速度。既定は1（固定。軸は1本ずつ足す） */
  speed?: number;
  predator?: boolean;
}

function build(o: Opts): () => WorldConfig {
  return () => {
    const cfg = presetByKey('vision').build();
    const [herb, pred] = cfg.species;

    herb.visionRange = o.start;
    herb.visionMutation!.sigma = o.sigma ?? 0.05;
    if (o.max !== undefined) herb.visionMutation!.max = o.max;
    if (o.visionCost !== undefined) herb.visionCost = o.visionCost;
    if (o.speed !== undefined) herb.speed = o.speed;
    if (o.predator === false) pred.initialCount = 0;

    return cfg;
  };
}

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
      `視野 ${visionOf(t).padEnd(20)} ばらつき ${herb.visionSd.toFixed(2)}  ` +
      `草食 ${herb.mean.toFixed(0).padStart(4)}  肉食 ${pred.mean.toFixed(0).padStart(4)}`,
  );
}

/**
 * シードごとの平均視野の推移を1行ずつ出す。
 *
 * シード間で平均すると、行き先が2つに割れている集団と中間に落ち着いた集団が
 * 同じ数字になる（10 の視野3・利得26がその形だった）。
 */
async function tracePerSeed(label: string, o: Opts, steps: number, every: number): Promise<void> {
  console.log(`  ${label}`);
  const rs = await traceMany(SEEDS_8.map((seed) => job(o, seed, steps, every)));

  rs.forEach((r, i) => {
    const marks = r.marks.map((m) =>
      m.population.some((c) => c === 0) ? ' 崩壊 ' : m.visionMean[0].toFixed(2),
    );
    console.log(`    seed ${SEEDS_8[i]}  ${marks.join('  →  ')}`);
  });
}

/**
 * 集団内の視野の分布を出す。**この節がこのレポートの本題。**
 *
 * 平均と標準偏差では「1点に集まっている」のか「二型に割れている」のかが
 * 区別できない（20 で踏んだ）。21 が見つけた軸が変異から出るなら、
 * 集団は視野0付近と視野3付近の二山になるはず。
 */
async function histograms(label: string, o: Opts, seeds: number[], steps: number): Promise<void> {
  const BIN = 0.25;
  const rs = await traceMany(
    seeds.map((seed) => ({ ...job(o, seed, steps, steps), histogramBin: BIN, histogramTrait: 'vision' as const })),
  );

  rs.forEach((r, i) => {
    const last = r.marks[r.marks.length - 1];
    const h = r.histogram!;
    console.log(
      `  ${label} seed ${seeds[i]}: 平均 ${last.visionMean[0].toFixed(2)} ± ` +
        `${last.visionSd[0].toFixed(2)}（個体数 ${h.total}）`,
    );
    h.counts.forEach((c, b) => {
      if (c === 0) return;
      const bar = '#'.repeat(Math.round((c / h.total) * 40)) || '.';
      console.log(
        `    ${(b * h.bin).toFixed(2)}-${((b + 1) * h.bin).toFixed(2)}  ` +
          `${String(c).padStart(5)}  ${bar}`,
      );
    });
  });
}

/**
 * 視野ビン別の採食と、死因別の平均視野。
 *
 * 21 は種をまたいで「無警戒型は94%の歩で0.423ずつ、警戒型は46%の歩で1.032ずつ」を
 * 出した。同じ形が視野の軸の上に並ぶかを見る。
 *
 * 死因を分けるのが肝。見れば逃げられる（被捕食を下げる）と見る代償で先に飢える
 * （餓死を上げる）は逆を向くので、正味の増減だけでは何も言えない。
 */
function printProfile(label: string, p: VisionProfile): void {
  const popMean = p.popCount > 0 ? p.popVisionSum / p.popCount : NaN;
  console.log(`  ${label}  集団平均 ${popMean.toFixed(3)}（個体×歩 ${p.popCount.toLocaleString()}）`);

  p.rows.forEach((r) => {
    // 標本が少ないビンは裾の数個体で決まるので出さない
    if (r.agentSteps < 2000) return;
    const freq = r.grazeSteps / r.agentSteps;
    const per = r.grazeSteps > 0 ? r.grazeAmount / r.grazeSteps : 0;
    console.log(
      `    視野 ${r.from.toFixed(2)}-${(r.from + p.bin).toFixed(2)}  ` +
        `個体×歩 ${String(r.agentSteps).padStart(9)}  ` +
        `採食 ${(freq * 100).toFixed(1).padStart(5)}%  ` +
        `1回 ${per.toFixed(3)}  歩あたり ${(r.grazeAmount / r.agentSteps).toFixed(3)}`,
    );
  });

  const dead = (d: { count: number; visionSum: number }) =>
    d.count > 0 ? d.visionSum / d.count : NaN;
  const eaten = dead(p.eaten);
  const starved = dead(p.starved);
  console.log(
    `    死因別の平均視野  被捕食 ${eaten.toFixed(3)}（差 ${(eaten - popMean).toFixed(3)}, ` +
      `${p.eaten.count.toLocaleString()}体）  ` +
      `餓死 ${starved.toFixed(3)}（差 ${(starved - popMean).toFixed(3)}, ` +
      `${p.starved.count.toLocaleString()}体）`,
  );
}

async function profileRow(label: string, o: Opts, seed: number, steps: number): Promise<void> {
  const rs = await traceMany([
    { ...job(o, seed, steps, steps), profileFrom: Math.floor(steps * 0.8), profileBin: 0.25 },
  ]);
  printProfile(label, rs[0].profile!);
}

// ---------------------------------------------------------------------------
// 対照。変異を切れば動かず、代償を外せば上限まで走り去るはず。
// どちらも外れたら以降の数字は読めない（10 と同じ形の確認）
// ---------------------------------------------------------------------------
header('対照: 変異と代償を外す（4シード・10000ステップ）');
await row('変異なし 初期0', { start: 0, sigma: 0 }, SEEDS_4, false);
await row('変異なし 初期3', { start: 3, sigma: 0 }, SEEDS_4, false);
await row('視野コスト0 初期0', { start: 0, visionCost: 0 }, SEEDS_4, false);

// ---------------------------------------------------------------------------
// 本題その1。別々の初期値から同じ所へ着くか。
// 1つの初期値から動いただけでは、選択で動いたのか流されただけなのか分からない
// ---------------------------------------------------------------------------
header('捕食者あり: 初期視野を変えて収束先を見る（8シード・20000ステップ）');
for (const start of [0, 0.5, 1, 3, 5]) {
  await row(`初期 ${start.toFixed(1)}`, { start });
}

header('対照: 捕食者を消す（8シード・20000ステップ）');
// 肉食を0にした行は「肉食が絶滅している」ので生存の記号は 0/8 で出る。
// 見たいのは草食の視野なのでその列は読み飛ばしてよい（10 と同じ）
for (const start of [0, 3]) {
  await row(`初期 ${start.toFixed(1)} 肉食なし`, { start, predator: false });
}

header('平均視野の推移をシードごとに（8シード・10000ステップごと）');
await tracePerSeed('初期 0.0 捕食者あり', { start: 0 }, 40000, 10000);
await tracePerSeed('初期 3.0 捕食者あり', { start: 3 }, 40000, 10000);

// ---------------------------------------------------------------------------
// 本題その2。**ここが規則の遺伝の答え。**
//
// 21 の軸（視野0と視野3）が変異から出るなら、集団は二山に割れるはず。
// 平均と標準偏差では割れているかどうかが分からないので、分布を直接見る
// ---------------------------------------------------------------------------
header('集団内の視野の分布（40000ステップ時点）');
await histograms('捕食者あり', { start: 0 }, SEEDS_4, 40000);
await histograms('肉食なし', { start: 0, predator: false }, [1000, 2000], 40000);

// ---------------------------------------------------------------------------
// 機構。視野は何を買っていて、何を払っているのか。
// ---------------------------------------------------------------------------
// 21 は**捕食者なし**で測っている。そこでは1個体あたりの摂取が実効代謝と
// ビタ一致する（比 1.00）が、捕食者がいると個体数が捕食で抑えられるぶん
// 摂取が代謝を上回る。並べて読むときはこの2つを混ぜないこと
header('視野を固定した集団の採食統計・捕食者なし（21 の軸をそのまま引き直す）');
for (const v of [0, 1, 2, 3]) {
  await profileRow(`固定 視野${v} 肉食なし`, { start: v, sigma: 0, predator: false }, 1000, 10000);
}

header('同じものを捕食者ありで（摂取と代謝の比が崩れる側）');
for (const v of [0, 1, 2, 3]) {
  await profileRow(`固定 視野${v}`, { start: v, sigma: 0 }, 1000, 10000);
}

header('進化した集団の中の視野別の採食（局所の勾配）');
await profileRow('捕食者あり 収束後', { start: 0 }, 1000, 20000);
await profileRow('肉食なし 収束後', { start: 0, predator: false }, 1000, 20000);

// ---------------------------------------------------------------------------
// 進化が着いた視野は、集団にとって良い場所なのか。
// 視野を固定した集団の個体数と比べる（10 の同名の節と同じ形）
// ---------------------------------------------------------------------------
header('比較: 視野を固定した集団の個体数（8シード・10000ステップ）');
for (const v of [0, 0.5, 0.75, 1, 1.5, 2, 3]) {
  await row(`固定 ${v.toFixed(2)}`, { start: v, sigma: 0 }, SEEDS_8, false);
}

// ---------------------------------------------------------------------------
// 21 の共存構成そのものに変異を入れる。
//
// 21 は視野0の種と視野3の種が共存すると出した（30000歩・相互侵入が両方向）。
// その2種に変異を入れると、両方とも同じ点へ寄るのか、離れたままなのか。
// 寄るなら**進化は自分が乗っている軸を潰す**ことになる。
// ---------------------------------------------------------------------------
/**
 * **21 の共存は捕食者なしで測られている**（478 : 1055・相互侵入が両方向）。
 * 既定を捕食者なしにしてあるのはそのため。捕食者を戻すと 05 の
 * 「警戒型がわずかに勝つ」構成になり、21 が共存と呼んだものとは別物になる。
 *
 * sigma を省くと変異そのものを入れない。21 の数字をそのまま引き直すためで、
 * σ=0 で変異機構だけ入れた場合とは違う（σ=0 でも childVision は正規乱数を1つ引くので、
 * 乱数列がずれて同じ数字にはならない）。
 */
function upkeepMutating(sigma?: number, predator = false): () => WorldConfig {
  return () => {
    const cfg = presetByKey('upkeep').build();
    if (!predator) cfg.species[2].initialCount = 0;
    if (sigma === undefined) return cfg;
    for (const herb of [cfg.species[0], cfg.species[1]]) {
      herb.visionMutation = { sigma, min: 0, max: 5 };
    }
    return cfg;
  };
}

async function upkeepRow(
  label: string,
  sigma: number | undefined,
  steps: number,
  tail: number,
  predator = false,
): Promise<void> {
  const t = await trial(upkeepMutating(sigma, predator), { seeds: SEEDS_8, steps, tail });
  const [a, b, pred] = t.species;
  // 捕食者を消した行は「肉食が絶滅している」ので生存の記号は 0/8 で出る。
  // 草食2種が両方生きているかは個体数を見て判断すること
  console.log(
    `  ${label.padEnd(24)} ${mark(t)}${t.survived}/${t.total}  ` +
      `警戒型 視野 ${visionOf(t, 0).padEnd(20)} ${a.mean.toFixed(0).padStart(4)}体  ` +
      `無警戒型 視野 ${visionOf(t, 1).padEnd(20)} ${b.mean.toFixed(0).padStart(4)}体  ` +
      `肉食 ${pred.mean.toFixed(0).padStart(4)}`,
  );
}

header('21 の共存構成（捕食者なし）に変異を入れる（8シード）');
await upkeepRow('変異なし（21 の再現）', undefined, 6000, 3000);
await upkeepRow('変異なし 30000歩', undefined, 30000, 5000);
await upkeepRow('σ=0.05 6000歩', 0.05, 6000, 3000);
await upkeepRow('σ=0.05 30000歩', 0.05, 30000, 5000);

header('同じものを捕食者ありで（8シード）');
await upkeepRow('変異なし', undefined, 6000, 3000, true);
await upkeepRow('σ=0.05 30000歩', 0.05, 30000, 5000, true);

// ---------------------------------------------------------------------------
// 変異の刻みが小さすぎて割れを見逃していないかの対照。
//
// 21 の軸は視野0と視野3で、σ=0.05 の刻みからは遠い。刻みを変えても
// 同じ所に着くなら、着かないのは刻みのせいではない（10 の同名の節と同じ形）
// ---------------------------------------------------------------------------
header('変異の強さを振る（8シード・20000ステップ）');
for (const sigma of [0.01, 0.05, 0.1, 0.2]) {
  await row(`σ=${sigma.toFixed(2)} 初期0`, { start: 0, sigma });
}
await histograms('σ=0.20 捕食者あり', { start: 0, sigma: 0.2 }, [1000, 2000], 40000);

await done(t0);
