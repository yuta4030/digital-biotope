import { presetByKey } from '../../../src/core/presets.ts';
import { trial, header, done, banner, visionOf } from './_lib.ts';
import { traceMany, type TraceJob } from '../../../src/sweep/pool.ts';
import type { WorldConfig, SpeciesDef } from '../../../src/core/types.ts';

/**
 * レポート24: 視野の端数の扱いが、生態系の挙動に化けていないか
 *
 *   node docs/reports/scripts/24-quantize-check.ts
 *
 * [22](../22-vision-evolution.md) の高い丘（平均3.04）で占有分布を取ったら、
 * **整数3.0のところが凹んで、2.4付近と3.4付近に山ができていた**（2シードとも同じ形）。
 * 山が半整数、谷が整数に並ぶ——刻み幅1の周期構造なので、量子化を疑う。
 *
 * 走査半径は端数を確率で繰り上げる（step.ts の quantize）。整数ちょうどの個体は
 * 常に同じ半径だが、端数を持つ個体は2つの半径を混ぜる。走査面積は (2r+1)² で
 * 半径に対して**凸**なので、混ぜたほうが期待面積が大きい：
 *
 *   v=2.5 → 0.5×25 + 0.5×49 = 37セル   ／  「真の半径2.5」なら 36セル
 *
 * 差は2.8%と小さいが、**代償は連続値にかかるので混ぜ得になりうる**。
 * そうなら 03 で3回踏んだ「実装の都合が生態系の挙動として観察される」の再来で、
 * 22 の高い丘の構造は生態ではなく格子の話になる。
 *
 * 個体数の平衡はエネルギー収支で決まる（生産÷実効代謝）ので適応度の代弁にならない。
 * **対競争で直接どちらが勝つかを見る。** 4スレッドで約8分。
 */

const t0 = performance.now();
banner();
const SEEDS_8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];

/**
 * 視野だけが違う草食2種＋肉食。
 *
 * 端数のある視野を使うには `visionMutation` が要る（無いと定義値がそのまま
 * 走査半径に入り、非整数だと添字が壊れる）。σ=0 にしてあるので値は動かないが、
 * 子1体につき正規乱数を1つ引く。**両種で同じ**なので比較は公平。
 */
function pair(vA: number, vB: number): () => WorldConfig {
  return () => {
    const cfg = presetByKey('vision').build();
    const base = cfg.species[0];
    const herb = (id: number, v: number): SpeciesDef => ({
      ...base,
      id,
      name: `視野${v.toFixed(2)}`,
      visionRange: v,
      visionMutation: { sigma: 0, min: 0, max: 5 },
      initialCount: 300,
    });
    cfg.species = [herb(1, vA), herb(2, vB), { ...cfg.species[1], id: 3, preys: [1, 2] }];
    return cfg;
  };
}

async function duel(vA: number, vB: number): Promise<void> {
  const t = await trial(pair(vA, vB), { seeds: SEEDS_8, steps: 6000, tail: 3000 });
  const [a, b] = t.species;
  const total = a.mean + b.mean;
  const share = total > 0 ? (a.mean / total) * 100 : NaN;
  const win = a.mean > b.mean * 1.1 ? '←' : b.mean > a.mean * 1.1 ? '  →' : ' 拮抗';
  console.log(
    `  視野 ${vA.toFixed(2)} 対 ${vB.toFixed(2)}   ` +
      `${a.mean.toFixed(0).padStart(4)}(${String(a.min).padStart(3)}-${String(a.max).padStart(4)})` +
      ` 対 ${b.mean.toFixed(0).padStart(4)}(${String(b.min).padStart(3)}-${String(b.max).padStart(4)})` +
      `   A ${share.toFixed(0).padStart(3)}%  ${win}`,
  );
}

/** 整数を跨がない帯に閉じ込めて、どこへ寄るか */
function banded(start: number, min: number, max: number): () => WorldConfig {
  return () => {
    const cfg = presetByKey('vision').build();
    cfg.species[0].visionRange = start;
    cfg.species[0].visionMutation = { sigma: 0.02, min, max };
    return cfg;
  };
}

async function bandRow(label: string, start: number, min: number, max: number): Promise<void> {
  const t = await trial(banded(start, min, max), { seeds: SEEDS_8, steps: 20000, tail: 4000 });
  console.log(
    `  ${label.padEnd(28)} 視野 ${visionOf(t).padEnd(20)} ` +
      `ばらつき ${t.species[0].visionSd.toFixed(3)}  草食 ${t.species[0].mean.toFixed(0)}`,
  );
}

// ---------------------------------------------------------------------------
// 節1: 整数をまたぐ対競争。
//
// 量子化の副作用なら、混ぜ方が最も均衡する半整数が両隣に勝つはず。
// 副作用でないなら、代償が連続値に線形にかかるので低いほうが勝つはず
// ---------------------------------------------------------------------------
header('整数と半整数の対競争（8シード・6000ステップ）');
await duel(2.0, 2.5);
await duel(2.5, 3.0);
await duel(3.0, 3.5);
await duel(3.5, 4.0);

// ---------------------------------------------------------------------------
// 節2: 同じ整数帯の中だけの対競争。
//
// 2.1 と 2.9 はどちらも半径2と3を混ぜる。混ぜ方の均衡度は同じ（0.1 対 0.9）で、
// 違うのは代償だけ。**代償だけが効くなら 2.1 が勝つ。**
// ここで拮抗したら、代償を打ち消す何かが混ざっている
// ---------------------------------------------------------------------------
header('同じ整数帯の中での対競争（半径2と3の混合のみ）');
await duel(2.1, 2.9);
await duel(2.1, 2.5);
await duel(2.5, 2.9);

// ---------------------------------------------------------------------------
// 節3: 対照。整数をまたぐ差と、またがない同じ幅の差を比べる。
//
// 2.4→2.6（またぐ手前）と 2.9→3.1（またぐ）は、どちらも幅0.2。
// またぐほうにだけ何かが起きるなら、それは格子の話
// ---------------------------------------------------------------------------
header('同じ幅0.2の差を、整数をまたぐ場合とまたがない場合で');
await duel(2.4, 2.6);
await duel(2.9, 3.1);
await duel(3.4, 3.6);

// ---------------------------------------------------------------------------
// 節4: 帯に閉じ込めた進化。
//
// 2.05〜2.95 に閉じ込めれば全個体が半径2と3を混ぜる。
// 混ぜ得なら真ん中（2.5）に寄り、代償だけなら下端に張り付く。
// 両端から出発して同じ所に来るかで判定する（10 と同じ形）
// ---------------------------------------------------------------------------
header('整数を跨がない帯に閉じ込める（8シード・20000ステップ・σ=0.02）');
await bandRow('帯 2.05-2.95 初期2.1', 2.1, 2.05, 2.95);
await bandRow('帯 2.05-2.95 初期2.9', 2.9, 2.05, 2.95);
await bandRow('帯 3.05-3.95 初期3.1', 3.1, 3.05, 3.95);
await bandRow('帯 3.05-3.95 初期3.9', 3.9, 3.05, 3.95);

// ---------------------------------------------------------------------------
// 節5: 22 の高い丘の占有分布を、シードを増やして確かめる。
//
// 凹みが2シードだけの偶然でないかを見る。8シードでも同じ位置に出るなら本物
// ---------------------------------------------------------------------------
header('高い丘の分布を8シードで（初期3・40000ステップ）');
{
  const BIN = 0.25;
  const jobs: TraceJob[] = SEEDS_8.map((seed) => {
    const cfg = presetByKey('vision').build();
    cfg.seed = seed;
    cfg.species[0].visionRange = 3;
    return { kind: 'trace', config: cfg, steps: 40000, every: 40000, histogramBin: BIN, histogramTrait: 'vision' };
  });
  const rs = await traceMany(jobs);
  rs.forEach((r, i) => {
    const h = r.histogram!;
    const last = r.marks[r.marks.length - 1];
    const cells = h.counts
      .map((c, b) => ({ from: b * BIN, c }))
      .filter((x) => x.from >= 1.75 && x.from < 4.25)
      .map((x) => `${x.from.toFixed(2)}:${String(x.c).padStart(4)}`)
      .join(' ');
    console.log(`  seed ${SEEDS_8[i]} 平均 ${last.visionMean[0].toFixed(2)}  ${cells}`);
  });
}

await done(t0);
