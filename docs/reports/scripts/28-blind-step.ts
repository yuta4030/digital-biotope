import { presetByKey } from '../../../src/core/presets.ts';
import { trial, header, done, banner, mark } from './_lib.ts';
import { World } from '../../../src/core/world.ts';
import { step } from '../../../src/core/step.ts';
import type { WorldConfig, SpeciesDef } from '../../../src/core/types.ts';

/**
 * レポート28: 1.00 の段差 — 1%の盲目の歩が何をしているのか
 *
 *   node docs/reports/scripts/28-blind-step.ts
 *
 * [27](../27-who-moves.md) 節2 が測り残した穴。低い側を視野0に固定して
 * 高い側を下げると、個体数は 1.10/1.05/1.00 で 585/588/593 と平らなのに、
 * **0.99 で 994 に跳ぶ**（相手は 992 → 568）。幅0.01 で多数派が入れ替わる。
 *
 * `quantize` は `frac > 0 && rng.chance(frac)` なので、**1.00 は盲目の歩が
 * 1歩も無い最後の値**で、0.99 は1%の歩だけ走査半径が0になる。
 * だが「1%の歩が盲目になると多数派が入れ替わる」は機構の説明になっていない。
 *
 * 27 は「armchair では出せない」と書いて次に回した。ここで測る。
 *
 * ## 先に計器を足した
 *
 * 種別の `grazeAmount` / `grazeCount`（21）では足りない。同じ個体の盲目の歩と
 * 有視界の歩が合算されるので、1%の歩だけを取り出せない。
 * `aMoveKind` を足して、歩を3つに分けた。
 *
 *   0 = 盲目（走査半径が0）        行き先は乱数
 *   1 = 見たが行き先が無かった      行き先は乱数
 *   2 = 見えた方へ向かった
 *
 * **1 を分けたのが肝。** 半径1でも「今より濃いセルが周りに無い」歩は
 * `findGrass` が false を返して乱数で動く。動き方としては盲目と同じなので、
 * 分けないと「盲目の歩が増えた」と「乱数で動く歩が増えた」を混同する。
 * 記録するだけで乱数は1つも引かない（回帰の約束）。
 *
 * ## 予測（測る前に書く）
 *
 * 1. **段差は盲目の歩の割合に比例して連続に動く。** 0.999（0.1%）は 1.00 と
 *    ほぼ同じ、0.99（1%）で 994。個体の平均寿命は60歩前後（20 節5）なので、
 *    0.999 では一生に一度も盲目にならない個体が94%いる。
 *    **もし 0.999 で既に跳ぶなら、機構は個体の採食効率ではない。**
 * 2. **1.01（1%が半径2）は 1.00 側に留まる。** 跳ねたら原因は盲目ではなく
 *    「量子化の経路を通ること」＝乱数ストリームで、24 と同じ格子の話になる
 * 3. **段差は単独では出ない。** 高い側だけを走らせた平衡個体数と R* は
 *    1.05 → 0.95 で滑らかに動くはず。段差が競争下だけに出るなら、これは
 *    「個体としての強さ」ではなく**相手とどの規則を共有しているか**の話で、
 *    26 の「決めているのはどちらの規則に属しているか」の続きになる。
 *    逆に単独でも段差が出るなら、盲目の歩そのものが採食を良くしている
 * 4. **1%の歩の直接の寄与は1%程度**にしかならない。0.99 の高い側の盲目の歩は、
 *    低い側（視野0）と同じ形（頻度94%前後・1回0.42前後）になるはず。
 *    有視界の歩は 1.00 のときと変わらない。**説明できないことが確認できれば、
 *    機構は歩の中ではなく、空間分布か競争にある**
 *
 * 8シードの静的な行が中心。4スレッドで約15分。
 */

const t0 = performance.now();
banner();

const SEEDS_8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
const SEEDS_4 = [1000, 2000, 3000, 4000];
const CELLS = 120 * 90;
const perCell = (total: number) => total / CELLS;

/** 実効代謝 = 基礎代謝 + 速度コスト × 速度 + 視野コスト × 視野 */
function effOf(s: SpeciesDef): number {
  return s.metabolism + s.speedCost * s.speed + s.visionCost * s.visionRange;
}

/**
 * 端数のある視野には `visionMutation` が要る（無いと定義値がそのまま走査半径に入り、
 * 非整数だと走査の範囲が壊れる）。σ=0 なら値は動かない。26・27 と同じ扱い。
 *
 * `force` は節2 の対照用。整数でも量子化の経路を通す
 * （frac=0 なので乱数は引かない。通すこと自体が悪さをしていないかの確認）。
 */
function arm(s: SpeciesDef, v: number, force = false): void {
  if (force || !Number.isInteger(v)) s.visionMutation = { sigma: 0, min: 0, max: 5 };
}

/** 21 の共存構成（`upkeep` から捕食者を消したもの）。低い側は視野0固定 */
function pair(vHi: number, force = false): () => WorldConfig {
  return () => {
    const cfg = presetByKey('upkeep').build();
    cfg.species[2].initialCount = 0; // 21 の共存は捕食者なしで測られている
    cfg.species[0].visionRange = vHi;
    cfg.species[1].visionRange = 0;
    arm(cfg.species[0], vHi, force);
    return cfg;
  };
}

/** 高い側だけを残す。相手も捕食者もいないので、草の残量はその種の R* そのもの */
function alone(v: number): () => WorldConfig {
  return () => {
    const cfg = presetByKey('upkeep').build();
    cfg.species = cfg.species.filter((s) => s.id === 1);
    cfg.species[0].visionRange = v;
    arm(cfg.species[0], v);
    return cfg;
  };
}

async function row(label: string, build: () => WorldConfig, steps = 30000): Promise<void> {
  const t = await trial(build, { seeds: SEEDS_8, steps, tail: 5000 });
  const [hi, lo] = t.species;
  const share = hi.mean + lo.mean > 0 ? (hi.mean / (hi.mean + lo.mean)) * 100 : 0;
  console.log(
    `  ${label.padEnd(22)}` +
      `高い側 ${hi.mean.toFixed(0).padStart(4)}(${String(hi.min).padStart(4)}-${String(hi.max).padStart(4)})  ` +
      `低い側 ${lo.mean.toFixed(0).padStart(4)}(${String(lo.min).padStart(4)}-${String(lo.max).padStart(4)})  ` +
      `高い側の取り分 ${share.toFixed(0).padStart(3)}%`,
  );
}

// ---------------------------------------------------------------------------
// 節1: 段差の解像度を上げる
//
// 27 は 1.00 と 0.99 しか踏んでいない。間に何もないのか、それとも
// 盲目の歩の割合について連続なのか。予測1 の検定。
// ---------------------------------------------------------------------------
header('節1: 段差の解像度（低い側は視野0固定・変異なし・8シード・30000歩）');
for (const vHi of [1.01, 1.0, 0.999, 0.995, 0.99, 0.98, 0.95]) {
  const blind = vHi < 1 ? (1 - vHi) * 100 : 0;
  await row(`高${vHi.toFixed(3)}（盲目${blind.toFixed(1)}%）`, pair(vHi));
}

// ---------------------------------------------------------------------------
// 節2: 実装を疑う（規則11）
//
// 27 の build は「端数があるときだけ visionMutation を付ける」ので、
// 1.00 と 0.99 では**量子化を通るかどうかも同時に変わっている**。
// 通ること自体が悪さをしていないかを、1.00 に σ=0 を付けて確かめる。
// frac=0 なので乱数は引かず、結果は上の 1.00 と完全に一致するはず。
// ---------------------------------------------------------------------------
header('節2: 量子化の経路を通ること自体が効いていないか（8シード・30000歩）');
await row('高1.00（σ=0 を付与）', pair(1.0, true));

// ---------------------------------------------------------------------------
// 節3: 単独で走らせる（予測3・本命の切り分け）
//
// 競争を外して、高い側だけの平衡個体数と R* を測る。
// 段差が単独では出ないなら、盲目の歩は「個体を強くする」のではなく
// 「相手との関係を変えている」ことになる。
// ---------------------------------------------------------------------------
header('節3: 高い側を単独で（相手も捕食者もなし・8シード・6000歩）');
for (const v of [3, 1.05, 1.0, 0.999, 0.99, 0.95, 0.9, 0]) {
  const build = alone(v);
  const s0 = build().species[0];
  const eff = effOf(s0);
  const t = await trial(build, { seeds: SEEDS_8, steps: 6000, tail: 3000 });
  console.log(
    `  視野${v.toFixed(3).padStart(5)}  実効代謝 ${eff.toFixed(4)}  ${mark(t)}${t.survived}/${t.total}  ` +
      `個体数 ${t.species[0].mean.toFixed(0).padStart(4)}(${t.species[0].min}-${t.species[0].max})  ` +
      `R* ${perCell(t.grassMean).toFixed(4)}  R*/実効代謝 ${(perCell(t.grassMean) / eff).toFixed(2)}`,
  );
}

// ---------------------------------------------------------------------------
// 節4: 歩の種類別の採食（新しい計器）
//
// 1%の盲目の歩が実際に何を取っているか。予測4 の検定。
// pool を通さず World を直接回す（計器は RunResult に載せていない）。
// ---------------------------------------------------------------------------
const KINDS = ['盲目', '見たが無し', '向かった'];

/**
 * 歩の種類別に、歩数・採食量・採食回数を集める。
 * 集計は後半だけ。立ち上がりの過渡状態を混ぜない。
 */
function measure(build: () => WorldConfig, steps: number, tail: number, nSpecies: number) {
  const stepsK = Array.from({ length: nSpecies }, () => [0, 0, 0, 0]);
  const amountK = Array.from({ length: nSpecies }, () => [0, 0, 0, 0]);
  const countK = Array.from({ length: nSpecies }, () => [0, 0, 0, 0]);
  let grass = 0;
  let samples = 0;

  for (const seed of SEEDS_4) {
    const cfg = build();
    cfg.seed = seed;
    const w = new World(cfg);
    for (let i = 0; i < steps; i++) {
      step(w);
      if (i < steps - tail) continue;
      samples++;
      let g = 0;
      for (let c = 0; c < w.cells; c++) g += w.grass[c];
      grass += g / w.cells;
      for (let si = 0; si < nSpecies; si++) {
        for (let k = 0; k < 4; k++) {
          stepsK[si][k] += w.moveKindSteps[si * 4 + k];
          amountK[si][k] += w.grazeKindAmount[si * 4 + k];
          countK[si][k] += w.grazeKindCount[si * 4 + k];
        }
      }
    }
  }
  return { stepsK, amountK, countK, grass: grass / samples };
}

/** 1種ぶんを、歩の種類ごとに1行ずつ出す */
function report(name: string, eff: number, steps: number[], amount: number[], count: number[]): void {
  const total = steps[0] + steps[1] + steps[2] + steps[3];
  if (total === 0) {
    console.log(`    ${name.padEnd(12)} 絶滅`);
    return;
  }
  const intake = (amount[0] + amount[1] + amount[2]) / total;
  console.log(
    `    ${name.padEnd(12)} 歩あたりの摂取 ${intake.toFixed(3)}（実効代謝 ${eff.toFixed(3)}・比 ${(intake / eff).toFixed(2)}）`,
  );
  for (let k = 0; k < 3; k++) {
    if (steps[k] === 0) continue;
    const freq = (count[k] / steps[k]) * 100;
    const per = count[k] > 0 ? amount[k] / count[k] : 0;
    // 摂取全体のうち、この種類の歩が運んでいる割合。段差を説明できる大きさか
    const contrib = (amount[k] / (amount[0] + amount[1] + amount[2])) * 100;
    console.log(
      `      ${KINDS[k].padEnd(10)} 歩の${((steps[k] / total) * 100).toFixed(2).padStart(6)}%  ` +
        `採食頻度 ${freq.toFixed(0).padStart(3)}%  1回 ${per.toFixed(3)}  ` +
        `摂取の${contrib.toFixed(2).padStart(6)}%`,
    );
  }
}

header('節4: 1%の盲目の歩が何を取っているか（競争下・4シード・12000歩・後半2000で集計）');
for (const vHi of [1.05, 1.0, 0.99, 0.95]) {
  const build = pair(vHi);
  const cfg = build();
  console.log(`  高い側 視野${vHi.toFixed(2)}`);
  const m = measure(build, 12000, 2000, 2);
  console.log(`    セルあたりの草 ${m.grass.toFixed(3)}`);
  for (const si of [0, 1]) {
    report(cfg.species[si].name, effOf(cfg.species[si]), m.stepsK[si], m.amountK[si], m.countK[si]);
  }
}

// 単独でも同じ計器を当てる。競争相手がいないときの1%の歩がどう働くかが分かれば、
// 節3 の個体数と突き合わせて「歩の得」と「競争の得」を分けられる
header('節5: 同じ計器を単独で（相手なし・4シード・8000歩・後半2000で集計）');
for (const v of [1.0, 0.99, 0.95]) {
  const build = alone(v);
  const cfg = build();
  const m = measure(build, 8000, 2000, 1);
  console.log(`  単独 視野${v.toFixed(2)}  セルあたりの草 ${m.grass.toFixed(3)}`);
  report(cfg.species[0].name, effOf(cfg.species[0]), m.stepsK[0], m.amountK[0], m.countK[0]);
}

await done(t0);
