import { presetByKey } from '../../../src/core/presets.ts';
import { trial, header, done, mark, visionOf, banner } from './_lib.ts';
import type { WorldConfig, SpeciesDef } from '../../../src/core/types.ts';

/**
 * レポート25: 低い丘（視野0.8）と、22 節6 の共存崩壊は何で決まっているのか
 *
 *   node docs/reports/scripts/25-low-hill-check.ts
 *
 * [22](../22-vision-evolution.md) の看板は2つある。
 *
 *   1. 低い丘 = 約0.80。捕食者を消すと初期0からも初期3からもここへ来る（節2）
 *   2. 21 の共存構成に変異を入れると6000歩で片方が絶滅する（節6）。
 *      壊すのは「中間へ動いた側が両方の資源を取る」——無警戒型が視野0から0.79へ
 *
 * どちらにも確かめていない前提が1つずつ残っている。
 *
 * **穴1: [24](../24-quantize-check.md) の帯試験は帯[0,1)を踏んでいない。**
 * 24 は帯2.05-2.95 と 3.05-3.95 を閉じ込めて内点収束を示し、混ぜ得を突き止めた。
 * ところが低い丘も節6の勝者もどちらも帯[0,1)に居る。24 は「22 の共存崩壊は
 * 視野0と3の比較で整数どうしだから影響を受けない」と書いたが、それは**初期値**の話で、
 * **勝った側は 0.79** という端数だった。
 *
 * ただし混ぜ得だけでは低い丘の位置を説明できない。走査面積の混ぜ得は
 *
 *   G(f) = [(1-f)·1 + f·9] - (2f+1)² = 4f(1-f)      ← 頂点は f=0.5
 *
 * で、代償は連続値に線形にかかって下へ押す。**混ぜ得だけなら内点は 0.5 未満に来る。**
 * 22 が出したのは 0.78-0.80 で、予測より**上**にある。だから
 *
 *   帯[0.05,0.95] の収束先が 0.5 未満  → 混ぜ得が効いている。22 節6 の読み直しが要る
 *   0.8 付近に来る                     → 混ぜ得では説明できない。低い丘は生態の側
 *
 * のどちらかが出る。**予測は後者**（上の計算から）。外れたら 24 の射程が広がる。
 *
 * **穴2: 節6 は σ=0.05 でしか測っていない。** 表の全行がσ=0.05 で、
 * ところが同じレポートの節7 が「**変異の刻みが行き先を決める**」（σ=0.05 なら低い丘、
 * σ=0.10 なら8シード全部が高い丘）を出している。刻みが結果を変えると自分で
 * 示した軸の1点だけで看板の結論を測っている。σを下げれば無警戒型が0.79へ動く速度も
 * 落ちるので、**共存崩壊が刻みの閾値である可能性**が潰せていない。
 *
 * 加えて、節6 は進化の走行なので「中間型が両取りする」機構と「そこへ動く」動態が
 * 混ざっている。節3 で中間型を**手で置いて**変異なしで戦わせ、機構だけを取り出す
 * （23 節4 が p=0.90 で専門型の化けの皮を剥いだのと同じ形）。
 *
 * 4スレッドで約50分。
 */

const t0 = performance.now();
banner();
const SEEDS_8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];

// ---------------------------------------------------------------------------
// 節1: 帯[0.05, 0.95]に閉じ込める（24 節4 とまったく同じ形）
//
// 帯に閉じ込めれば全個体が半径0と1だけを混ぜる。両端から出発して同じ内点に
// 来るなら、そこに山がある。24 は帯2・帯3でこれをやって混ぜ得を突き止めた。
// 帯[0,1) だけが未検査で、そこに低い丘と節6の勝者が両方居る。
// ---------------------------------------------------------------------------

/** 24 の banded() と同じ。捕食者を消せるようにしただけ */
function banded(start: number, min: number, max: number, predator: boolean): () => WorldConfig {
  return () => {
    const cfg = presetByKey('vision').build();
    cfg.species[0].visionRange = start;
    cfg.species[0].visionMutation = { sigma: 0.02, min, max };
    if (!predator) cfg.species[1].initialCount = 0;
    return cfg;
  };
}

async function bandRow(
  label: string,
  start: number,
  min: number,
  max: number,
  predator: boolean,
): Promise<void> {
  const t = await trial(banded(start, min, max, predator), {
    seeds: SEEDS_8,
    steps: 20000,
    tail: 4000,
  });
  console.log(
    `  ${label.padEnd(30)} 視野 ${visionOf(t).padEnd(20)} ` +
      `ばらつき ${t.species[0].visionSd.toFixed(3)}  草食 ${t.species[0].mean.toFixed(0)}`,
  );
}

header('帯[0.05,0.95]に閉じ込める・捕食者なし（8シード・20000歩・σ=0.02）');
// 捕食者なしを先に置くのは、節6（共存崩壊）が捕食者なしで測られているため。
// 22 節2 の「初期0からも初期3からも0.80」もこの条件
await bandRow('帯 0.05-0.95 初期0.1 肉食なし', 0.1, 0.05, 0.95, false);
await bandRow('帯 0.05-0.95 初期0.9 肉食なし', 0.9, 0.05, 0.95, false);

header('同じものを捕食者ありで（24 の他の帯と揃える）');
await bandRow('帯 0.05-0.95 初期0.1', 0.1, 0.05, 0.95, true);
await bandRow('帯 0.05-0.95 初期0.9', 0.9, 0.05, 0.95, true);

// ---------------------------------------------------------------------------
// 節2: 帯の中と、整数1をまたぐ対競争（24 節1〜3 と同じ形）
//
// 個体数の平衡は生産÷実効代謝で決まるので適応度の代弁にならない。
// 同じ世界に2つ入れて奪い合わせる（24 が確立した測り方）。
//
// 24 は「同じ幅0.2でも整数をまたぐときだけ一方的になる」（2.40対2.60は拮抗、
// 2.90対3.10は完全排除）を格子の指紋として使った。同じ指紋が整数1の周りに
// 出るかを見る。
// ---------------------------------------------------------------------------

/** 24 の pair() と同じ。視野だけが違う草食2種＋肉食 */
function pair(vA: number, vB: number, predator = true): () => WorldConfig {
  return () => {
    const cfg = presetByKey('vision').build();
    const base = cfg.species[0];
    // 端数のある視野を使うには visionMutation が要る（無いと定義値がそのまま
    // 走査半径に入り、非整数だと添字が壊れる）。σ=0 で値は動かないが子1体につき
    // 正規乱数を1つ引く。両種で同じなので比較は公平
    const herb = (id: number, v: number): SpeciesDef => ({
      ...base,
      id,
      name: `視野${v.toFixed(2)}`,
      visionRange: v,
      visionMutation: { sigma: 0, min: 0, max: 5 },
      initialCount: 300,
    });
    const pred = { ...cfg.species[1], id: 3, preys: [1, 2] };
    if (!predator) pred.initialCount = 0;
    cfg.species = [herb(1, vA), herb(2, vB), pred];
    return cfg;
  };
}

async function duel(vA: number, vB: number, predator = true): Promise<void> {
  const t = await trial(pair(vA, vB, predator), { seeds: SEEDS_8, steps: 6000, tail: 3000 });
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

header('帯[0,1)の中での対競争（8シード・6000歩）');
await duel(0.0, 0.5);
await duel(0.5, 0.8);
await duel(0.0, 0.8);
await duel(0.8, 1.0);

header('同じ幅0.2の差を、整数1をまたぐ場合とまたがない場合で');
// 24 の 2.40対2.60（拮抗）／2.90対3.10（完全排除）に対応する組。
// またぐ側だけが一方的になるなら格子の指紋
await duel(0.6, 0.8);
await duel(0.9, 1.1);
await duel(1.4, 1.6);

// ---------------------------------------------------------------------------
// 節3: 中間型を手で置く。節6 の機構を進化の動態から切り離す
//
// 節6 は「無警戒型が視野0から0.79へ動いて警戒型を締め出した」と読んだ。
// これは (a) 中間型が両取りして専門型に勝つ という機構と
//        (b) 変異でそこへ動ける という動態 の合成で、進化の走行では分けられない。
//
// 中間型を最初から置いて変異なしで戦わせれば (a) だけが残る。
// v=0 の行は 21 の共存（478:1055）の再現なので**陽性対照**になる。
// ただし両種に visionMutation(σ=0) を付けるので乱数列は 21 とずれる。
// ビット一致はしないが、統計的に同じ所に来るはず。
//
// 23 節4 が「p=0.90 の名目上の専門型が実は A50% を取っている」を出したのと同じ形。
// どこから専門型が排除されるかで、軸がどれだけ狭いかが分かる。
// ---------------------------------------------------------------------------

/**
 * 21 の共存構成（upkeep から捕食者を消したもの）で、無警戒型の視野だけを振る。
 * 警戒型は視野3のまま。2種の違いは視野だけなので、これで軸の上を動かせる。
 */
function upkeepPair(vLow: number, predator = false): () => WorldConfig {
  return () => {
    const cfg = presetByKey('upkeep').build();
    if (!predator) cfg.species[2].initialCount = 0;
    // 端数を使うために両種へ入れる。σ=0 なので値は動かない
    for (const herb of [cfg.species[0], cfg.species[1]]) {
      herb.visionMutation = { sigma: 0, min: 0, max: 5 };
    }
    cfg.species[1].visionRange = vLow;
    return cfg;
  };
}

async function upkeepPairRow(vLow: number, steps: number, tail: number): Promise<void> {
  const t = await trial(upkeepPair(vLow), { seeds: SEEDS_8, steps, tail });
  const [hi, lo] = t.species;
  const total = hi.mean + lo.mean;
  const share = total > 0 ? (hi.mean / total) * 100 : NaN;
  console.log(
    `  無警戒型の視野 ${vLow.toFixed(2)}   ` +
      `警戒型(視野3) ${hi.mean.toFixed(0).padStart(4)}(${String(hi.min).padStart(3)}-${String(hi.max).padStart(4)})` +
      `  無警戒型 ${lo.mean.toFixed(0).padStart(4)}(${String(lo.min).padStart(3)}-${String(lo.max).padStart(4)})` +
      `   警戒 ${share.toFixed(0).padStart(3)}%`,
  );
}

header('21 の共存構成で中間型を手で置く・6000歩（8シード・変異なし・捕食者なし）');
for (const v of [0, 0.25, 0.5, 0.8, 1.0]) {
  await upkeepPairRow(v, 6000, 3000);
}

// 規則7: 共存の判定に6000歩は足りない。21 自身が 07 のパッチで
// 「6000歩で 8/8、30000歩で 3/8」を踏んでいる
header('同じものを30000歩で（規則7: 共存の判定には6000歩では足りない）');
for (const v of [0, 0.25, 0.5, 0.8, 1.0]) {
  await upkeepPairRow(v, 30000, 5000);
}

// ---------------------------------------------------------------------------
// 節4: 節6 を σ で振る。**穴2はここ。**
//
// 22 節6 の表は全行が σ=0.05。同じレポートの節7 が「刻みが行き先を決める」を
// 出しているのに、看板の結論はその軸の1点でしか測られていない。
//
// σ を下げれば無警戒型が0.79へ動く速度も落ちる。6000歩で崩れなくなるだけなら
// 「遅い排除」（規則7）なので30000歩も要る。**両方測って初めて
// 「刻みの閾値」と「速度が落ちただけ」が分かれる。**
// ---------------------------------------------------------------------------

/** 22 の upkeepMutating() と同じ */
function upkeepMutating(sigma: number, predator = false): () => WorldConfig {
  return () => {
    const cfg = presetByKey('upkeep').build();
    if (!predator) cfg.species[2].initialCount = 0;
    for (const herb of [cfg.species[0], cfg.species[1]]) {
      herb.visionMutation = { sigma, min: 0, max: 5 };
    }
    return cfg;
  };
}

async function sigmaRow(
  sigma: number,
  steps: number,
  tail: number,
  predator = false,
): Promise<void> {
  const t = await trial(upkeepMutating(sigma, predator), { seeds: SEEDS_8, steps, tail });
  const [hi, lo, pred] = t.species;
  // 捕食者を消した行は肉食が絶滅扱いなので生存記号は 0/8 で出る。
  // 草食2種が両方生きているかは個体数で判断すること（22 と同じ）
  console.log(
    `  σ=${sigma.toFixed(2)} ${String(steps).padStart(5)}歩  ${mark(t)}  ` +
      `警戒型 視野 ${visionOf(t, 0).padEnd(20)} ${hi.mean.toFixed(0).padStart(4)}体  ` +
      `無警戒型 視野 ${visionOf(t, 1).padEnd(20)} ${lo.mean.toFixed(0).padStart(4)}体  ` +
      `肉食 ${pred.mean.toFixed(0).padStart(4)}`,
  );
}

header('22 節6 を σ で振る・捕食者なし（8シード）');
for (const sigma of [0.01, 0.05, 0.1, 0.2]) {
  await sigmaRow(sigma, 6000, 3000);
}
for (const sigma of [0.01, 0.05, 0.1, 0.2]) {
  await sigmaRow(sigma, 30000, 5000);
}

header('同じものを捕食者ありで（8シード・30000歩）');
// 節7 は σ=0.10 で8シード全部が高い丘に着くと出している。捕食者ありの節6 は
// 警戒型が2.93のまま勝つ形だったが、σ を変えれば勝者が変わりうる
for (const sigma of [0.01, 0.05, 0.1, 0.2]) {
  await sigmaRow(sigma, 30000, 5000, true);
}

await done(t0);
