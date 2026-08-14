import { presetByKey } from '../../../src/core/presets.ts';
import { trial, header, done, visionOf, banner } from './_lib.ts';
import { traceMany, type TraceJob } from '../../../src/sweep/pool.ts';
import type { WorldConfig } from '../../../src/core/types.ts';

/**
 * レポート27: どちらが動いて共存を壊しているのか
 *
 *   node docs/reports/scripts/27-who-moves.ts
 *
 * [22](../22-vision-evolution.md) 節6 は 21 の共存構成の**両方**に変異を入れて
 * 「6000歩で警戒型が絶滅」を出した。動いたのは無警戒型（0 → 0.79）で、
 * 警戒型はほぼその場（3.00 → 2.92）だった。
 *
 * ところが [26](../26-position-or-gap.md) 節1 は、**高いほうは下がるほど得をする**と
 * 出した（視野3で481体、視野1で594体）。22 節6 の σ=0.01・30000歩でも
 * 警戒型は 3.00 → 2.80 と下へ動いていた。**低いほうが上へ、高いほうが下へ、
 * 両方が境界（0.55〜0.60）へ向かっている可能性がある。**
 *
 * 22 は両方に同時に変異を入れたので、**どちらの動きが壊しているのかが合成**されている。
 * 片方ずつ変異させれば分かれる。
 *
 * ## 本題は「高いほうだけ動かすとどこで止まるか」
 *
 * 26 節1 は高いほうを 1.0 で止めていて、それより下を測っていない。
 * 1.0 を割ると高いほうも部分的に盲目になり、**低いほう（視野0・約1000体）と
 * 同じ規則に入り始める**。ここに壁があるかもしれない。
 *
 *   1.0 のすぐ上で止まる → 盲目の規則との競合が個体レベルの壁になっている
 *   0.81 まで降りる      → 壁は無い。22 節2 の単独進化の着地点と同じ
 *
 * **予測は前者。** ただし後者でも共存は壊れないかもしれない——26 の規則A
 * （効くのは低いほうの絶対位置）に従うなら、低いほうが0に固定されている限り
 * 高いほうが 0.81 まで降りても共存は残るはず。**節1 で先に静的に測っておく。**
 *
 * ## 非対称の見立て
 *
 * 低いほうには 0.55 に壁が無いはずだ——0.5 から 0.6 へ動いても、
 * 相手（視野3・少数）に近づくわけではないので、ただ採食が上手くなるだけ。
 * **境界は2種の組にとっての境界であって、個体には見えない。**
 *
 * 高いほうには壁がありうる。降りると相手（視野0・多数）の規則に入るので、
 * 1000体との競合が自分に返ってくる。**壁が片側にしか無いなら、それが
 * 「進化が窓の外へ出る」の非対称の正体になる。**
 *
 * 4スレッドで約20分。
 */

const t0 = performance.now();
banner();
const SEEDS_8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];

/**
 * 21 の共存構成（`upkeep` から捕食者を消したもの）。
 * 草食2種の視野と、どちらが変異するかを指定する。
 *
 * 端数のある視野には `visionMutation` が要る（無いと定義値がそのまま走査半径に
 * 入り、非整数だと添字が壊れる）。σ=0 なら値は動かない。26 と同じ扱い。
 */
interface Opts {
  vLo: number;
  vHi: number;
  /** 変異させる側。'lo' | 'hi' | 'both' | 'none' */
  mutate: 'lo' | 'hi' | 'both' | 'none';
  sigma?: number;
}

function build(o: Opts): () => WorldConfig {
  return () => {
    const cfg = presetByKey('upkeep').build();
    cfg.species[2].initialCount = 0; // 21 の共存は捕食者なしで測られている
    const hi = cfg.species[0];
    const lo = cfg.species[1];
    hi.visionRange = o.vHi;
    lo.visionRange = o.vLo;

    const sigma = o.sigma ?? 0.05;
    // 変異させない側でも、端数を持つなら σ=0 の visionMutation が要る。
    // 整数なら付けない（乱数を余計に引かないため）
    const arm = (s: typeof hi, on: boolean, v: number) => {
      if (on) s.visionMutation = { sigma, min: 0, max: 5 };
      else if (!Number.isInteger(v)) s.visionMutation = { sigma: 0, min: 0, max: 5 };
    };
    arm(hi, o.mutate === 'hi' || o.mutate === 'both', o.vHi);
    arm(lo, o.mutate === 'lo' || o.mutate === 'both', o.vLo);
    return cfg;
  };
}

/** 平衡の1行。到達視野は両種とも出す（どちらが動いたかを読むため） */
async function row(label: string, o: Opts, steps = 30000): Promise<void> {
  const t = await trial(build(o), { seeds: SEEDS_8, steps, tail: 5000 });
  const [hi, lo] = t.species;
  console.log(
    `  ${label.padEnd(30)}` +
      `高い側 視野 ${visionOf(t, 0).padEnd(20)} ${hi.mean.toFixed(0).padStart(4)}(${String(hi.min).padStart(3)}-${String(hi.max).padStart(4)})  ` +
      `低い側 視野 ${visionOf(t, 1).padEnd(20)} ${lo.mean.toFixed(0).padStart(4)}(${String(lo.min).padStart(3)}-${String(lo.max).padStart(4)})`,
  );
}

/**
 * 両種の視野の推移をシードごとに出す。
 *
 * **平衡値だけでは「両方が境界へ向かう」が見えない。** 22 節6 は最終値しか
 * 出していないので、警戒型が 2.92 で「ほぼ動いていない」のか
 * 「下り始めたところで死んだ」のかが区別できなかった。
 */
async function trace(label: string, o: Opts, steps: number, every: number): Promise<void> {
  console.log(`  ${label}`);
  const jobs: TraceJob[] = SEEDS_8.map((seed) => {
    const config = build(o)();
    config.seed = seed;
    return { kind: 'trace', config, steps, every };
  });
  const rs = await traceMany(jobs);
  rs.forEach((r, i) => {
    const cells = r.marks.map((m) => {
      // 絶滅した種の視野は測定値ではないので数字を出さない
      const hi = m.population[0] > 0 ? m.visionMean[0].toFixed(2) : ' -- ';
      const lo = m.population[1] > 0 ? m.visionMean[1].toFixed(2) : ' -- ';
      return `${hi}/${lo}`;
    });
    console.log(`    seed ${SEEDS_8[i]}  ${cells.join('  ')}`);
  });
}

// ---------------------------------------------------------------------------
// 節1: 26 が測らなかった帯 — 高いほうを 1.0 より下へ（静的）
//
// 26 節1 は高いほうを 1.0 で止めた。高いほうの進化の着地先候補を
// 先に静的に測っておかないと、節3 の結果が読めない。
//
// 26 の規則A（効くのは低いほうの絶対位置）に従うなら、低いほうが0に
// 固定されている限り、高いほうが 0.81 まで降りても共存は残るはず。
// ---------------------------------------------------------------------------
header('高い側を1.0より下へ（低い側は0固定・変異なし・8シード・30000歩）');
for (const vHi of [1.0, 0.9, 0.81, 0.7, 0.6]) {
  await row(`低0.00 / 高${vHi.toFixed(2)}`, { vLo: 0, vHi, mutate: 'none' });
}

// ---------------------------------------------------------------------------
// 節2: 低いほうだけ変異させる
//
// 22 節6 は両方に入れた。低いほうだけで壊れるなら、壊しているのは
// 低いほうの上昇だけということになる。
// ---------------------------------------------------------------------------
header('低い側だけ変異（高い側は視野3固定・σ=0.05・8シード）');
await row('6000歩', { vLo: 0, vHi: 3, mutate: 'lo' }, 6000);
await row('30000歩', { vLo: 0, vHi: 3, mutate: 'lo' });
await trace('低い側だけ変異 30000歩（高/低・5000歩ごと）', { vLo: 0, vHi: 3, mutate: 'lo' }, 30000, 5000);

// ---------------------------------------------------------------------------
// 節3: 高いほうだけ変異させる。**このレポートの本題。**
//
// 26 節1 は高いほうが下がるほど得をすると示した。実際に動かすと
// どこで止まるのか。1.0 のすぐ上なら盲目の規則との競合が壁になっている。
// ---------------------------------------------------------------------------
header('高い側だけ変異（低い側は視野0固定・σ=0.05・8シード）');
await row('6000歩', { vLo: 0, vHi: 3, mutate: 'hi' }, 6000);
await row('30000歩', { vLo: 0, vHi: 3, mutate: 'hi' });
await trace('高い側だけ変異 30000歩（高/低・5000歩ごと）', { vLo: 0, vHi: 3, mutate: 'hi' }, 30000, 5000);

// 下から出発しても同じ所へ来るか（10・22 と同じ形の確認）。
// 上からしか測っていないと「初期値に張り付いただけ」と区別できない
header('高い側だけ変異・下から出発（低い側は視野0固定・8シード・30000歩）');
await row('高い側 初期1.2', { vLo: 0, vHi: 1.2, mutate: 'hi' });
await row('高い側 初期1.5', { vLo: 0, vHi: 1.5, mutate: 'hi' });

// ---------------------------------------------------------------------------
// 節4: 両方変異（22 節6 の再現）+ 推移
//
// 22 は最終値しか出していないので、警戒型が「ほぼ動いていない」のか
// 「下り始めたところで死んだ」のかが分からなかった。推移で見る。
// ---------------------------------------------------------------------------
header('両方変異（22 節6 の再現・σ=0.05・8シード）');
await row('6000歩', { vLo: 0, vHi: 3, mutate: 'both' }, 6000);
await row('30000歩', { vLo: 0, vHi: 3, mutate: 'both' });
await trace('両方変異 30000歩（高/低・2500歩ごと）', { vLo: 0, vHi: 3, mutate: 'both' }, 30000, 2500);

// σ=0.01 は 25 で「6000歩では共存に見えて30000歩で1体」だった条件。
// 遅いぶん、高いほうが下り始めるところが見えるはず
header('両方変異・σ=0.01（25 で遅い排除が出た条件）');
await row('30000歩 σ=0.01', { vLo: 0, vHi: 3, mutate: 'both', sigma: 0.01 });
await trace('両方変異 σ=0.01（高/低・5000歩ごと）', { vLo: 0, vHi: 3, mutate: 'both', sigma: 0.01 }, 30000, 5000);

await done(t0);
