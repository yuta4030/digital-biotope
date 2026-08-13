/**
 * 21. R* — 1本の資源軸で勝敗を決めているものは何か
 *
 * [20](../20-terrain.md) が塞いだのは「空間の不均質さ」の道だった。残るのは
 * **ニッチ軸そのものを増やすこと**で、その設計に入る前に測っておく道具がこれ。
 *
 * R* は「その種が単独で資源をどこまで引き下げられるか」。1本の資源をめぐる競争では、
 * **R* の低いほうが勝つ**——相手がもう減り始める水準でまだ増えられるので。
 * 資源を2本にして共存させたいなら、**種ごとに R* の低い資源が違う**必要がある。
 *
 * だから先に確かめる。**いまの1資源の模型で、R* が実際に勝敗を予測するのか。**
 * 予測しないなら、2本にしたところで設計の根拠が無い。
 *
 * この模型の採食は `eaten = min(セルの草, gainFromGrass)` で、`gainFromGrass` は4、
 * 標準現存量は約1。**個体はセルの草を丸ごと食べていて、食べる能力は効いていない。**
 * だとすると摂取を決めるのは遭遇だけなので、平衡では
 *
 *     標準現存量 ≒ 回復速度 ÷ 密度 、 密度 ≒ 回復速度 ÷ 実効代謝
 *     → **R\* ≒ 実効代謝**
 *
 * になるはず。予想はこれ。当たっていれば「1資源の勝敗は実効代謝だけで決まる」
 * ことになり、**資源を2本にしても `gainFromGrass` を変えるだけでは
 * トレードオフにならない**（能力が効いていないので）。設計が変わる。
 *
 * 予想:
 * 1. R* ≒ 実効代謝。代謝を振ると比例して動く
 * 2. 競合ペアでは R* の低いほうが勝つ。
 *    keystone は A(0.5) が B(0.62) に勝つ（02 の A 1298 / B 0）、
 *    upkeep は無警戒型(0.40) が警戒型(0.475) に勝つ（05 の 477 対 1056）
 * 3. 視野コストを振ると実効代謝の大小が入れ替わり、勝敗も同じ点で反転する
 *
 * 実行: node docs/reports/scripts/21-r-star.ts
 */
import { presetByKey } from '../../../src/core/presets.ts';
import type { WorldConfig, SpeciesDef } from '../../../src/core/types.ts';
import { trial, header, done, banner, mark } from './_lib.ts';

const t0 = performance.now();
banner();

const SEEDS = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
const STEPS = 6000;
const TAIL = 3000;

/** 実効代謝 = 基礎代謝 + 速度コスト × 速度 + 視野コスト × 視野 */
function effOf(s: SpeciesDef): number {
  return s.metabolism + s.speedCost * s.speed + s.visionCost * s.visionRange;
}

/**
 * 指定した id の種だけを残す。**捕食者も競争相手も消す**ので、
 * 残った草の量はその種が単独で引き下げられる水準そのものになる。
 */
function only(key: string, id: number, edit?: (s: SpeciesDef) => void): () => WorldConfig {
  return () => {
    const cfg = presetByKey(key).build();
    cfg.species = cfg.species.filter((s) => s.id === id);
    if (edit) edit(cfg.species[0]);
    return cfg;
  };
}

/** 草食2種だけを残す。捕食者を消すのは、捕食が共存を作る側だから（キーストーン捕食） */
function pair(key: string, ids: number[], edit?: (s: SpeciesDef) => void): () => WorldConfig {
  return () => {
    const cfg = presetByKey(key).build();
    cfg.species = cfg.species.filter((s) => ids.includes(s.id));
    if (edit) cfg.species.forEach(edit);
    return cfg;
  };
}

// ---------------------------------------------------------------------------
header('節1: R* は実効代謝と一致するか');

/**
 * 単独で走らせて、平衡での草の残量を測る。これが R*。
 *
 * 代謝を振って、R* が実効代謝についてくるかを見る。ついてくるなら
 * 「1資源の勝敗は実効代謝だけで決まる」ことになる。
 */
console.log('  keystone の草食A を単独で。基礎代謝を振る  8シード / 6000ステップ');
for (const m of [0.4, 0.5, 0.62, 0.8]) {
  const build = only('keystone', 1, (s) => (s.metabolism = m));
  const eff = effOf(build().species[0]);
  const t = await trial(build, { seeds: SEEDS, steps: STEPS, tail: TAIL });
  console.log(
    `    代謝${m.toFixed(2)}  実効代謝 ${eff.toFixed(3)}  ` +
      `${mark(t)}${t.survived}/${t.total}  ` +
      `R* ${t.grassMean.toFixed(3)}  R*/実効代謝 ${(t.grassMean / eff).toFixed(3)}  ` +
      `個体数 ${t.species[0].mean.toFixed(0)}`,
  );
}

console.log('  upkeep の2種を単独で（違いは視野だけ）');
for (const [key, id] of [['upkeep', 1], ['upkeep', 2]] as const) {
  const build = only(key, id);
  const s0 = build().species[0];
  const t = await trial(build, { seeds: SEEDS, steps: STEPS, tail: TAIL });
  console.log(
    `    ${s0.name.padEnd(12)} 実効代謝 ${effOf(s0).toFixed(3)}  ` +
      `${mark(t)}${t.survived}/${t.total}  ` +
      `R* ${t.grassMean.toFixed(3)}  R*/実効代謝 ${(t.grassMean / effOf(s0)).toFixed(3)}  ` +
      `個体数 ${t.species[0].mean.toFixed(0)}`,
  );
}

// ---------------------------------------------------------------------------
header('節2: R* の低いほうが勝つか');

/**
 * 単独で測った R* が、実際に一緒に走らせたときの勝敗を予測するか。
 * 予測しないなら、資源を2本にしても設計の根拠が無い。
 *
 * 既知の答えと突き合わせる。keystone は 02 で A 1298 / B 0、
 * upkeep は 05 で 477 対 1056（どちらも捕食者なし）。
 */
for (const [key, ids, label] of [
  ['keystone', [1, 2], 'keystone 草食A vs 草食B'],
  ['upkeep', [1, 2], 'upkeep 警戒型 vs 無警戒型'],
] as const) {
  const cfg = pair(key, [...ids])();
  const effs = cfg.species.map(effOf);
  const t = await trial(pair(key, [...ids]), { seeds: SEEDS, steps: STEPS, tail: TAIL });
  console.log(`  ${label}`);
  console.log(
    `    実効代謝 ${cfg.species.map((s, i) => `${s.name} ${effs[i].toFixed(3)}`).join(' / ')}`,
  );
  console.log(
    `    同居させると  ${t.species
      .map((s) => `${s.name} ${s.mean.toFixed(0)}(${s.min}-${s.max})`)
      .join('  ')}`,
  );
}

// ---------------------------------------------------------------------------
header('節3: 実効代謝が入れ替わる点で勝敗も反転するか');

/**
 * upkeep の警戒型は視野3なので、視野コストを振ると実効代謝だけが動く。
 * 無警戒型は視野0なので**視野コストの影響を受けない**——片方だけを動かせる。
 *
 * 警戒型の実効代謝 = 0.40 + 視野コスト × 3。無警戒型は 0.40 で固定。
 * つまり視野コスト > 0 なら常に警戒型のほうが高い。**負の視野コストは無いので、
 * この軸では入れ替わらない**——予想3はそもそも成り立たない可能性がある。
 *
 * 代わりに無警戒型の基礎代謝を上げて入れ替える。視野コスト0.025のとき
 * 警戒型 0.475 なので、無警戒型の基礎代謝を 0.25 → 0.325 に上げると並ぶ。
 * **R* が勝敗を決めているなら、反転はちょうどそこで起きる。**
 */
console.log('  無警戒型の基礎代謝を上げて実効代謝を追い越させる（警戒型は0.475で固定）');
for (const m of [0.25, 0.3, 0.325, 0.35, 0.4]) {
  const build = pair('upkeep', [1, 2], (s) => {
    if (s.id === 2) s.metabolism = m;
  });
  const cfg = build();
  const effs = cfg.species.map(effOf);
  const t = await trial(build, { seeds: SEEDS, steps: STEPS, tail: TAIL });
  const [alert, plain] = t.species;
  console.log(
    `    無警戒の代謝${m.toFixed(3)}  実効代謝 警戒${effs[0].toFixed(3)} / 無警戒${effs[1].toFixed(3)}  ` +
      `→  警戒 ${alert.mean.toFixed(0).padStart(4)}(${alert.min}-${alert.max})  ` +
      `無警戒 ${plain.mean.toFixed(0).padStart(4)}(${plain.min}-${plain.max})`,
  );
}

await done(t0);
