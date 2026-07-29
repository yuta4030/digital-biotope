import { presetByKey } from '../../../src/core/presets.ts';
import { World } from '../../../src/core/world.ts';
import { step } from '../../../src/core/step.ts';
import type { WorldConfig } from '../../../src/core/types.ts';
import { trial, header, done, type Trial } from './_lib.ts';

/**
 * レポート07: 草地のパッチ（空間的不均質）
 *
 *   node docs/reports/scripts/07-grass-patches.ts
 *
 * 草の回復速度をセルごとに変える。重みの平均は1に正規化してあるので
 * 世界全体の生産量は変わらず、分布だけが変わる。
 * 「不均質にした効果」と「豊穣化（06）」を混ぜないための作りにしてある。
 *
 * 所要10分ほど。最後の「燃費」の節が視野を使うので大半を占める。
 */

const t0 = performance.now();

/** 8シード。04 で「3シードでは偶然と本物が区別できない」と分かったため */
const SEEDS8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
const STEPS = 6000;
const TAIL = 3000;

/** 04・06 と同じ条件で回す。過去の表とそのまま比べられるようにするため */
async function run(build: () => WorldConfig): Promise<Trial> {
  return trial(build, { seeds: SEEDS8, steps: STEPS, tail: TAIL });
}

function show(label: string, t: Trial): void {
  const sp = t.species
    .map(
      (s) =>
        `${s.name} ${s.mean.toFixed(0).padStart(4)}` +
        `(${String(s.min).padStart(4)}-${String(s.max).padStart(4)})`,
    )
    .join('  ');
  console.log(`  ${label.padEnd(22)} ${t.survived}/${t.total}  ${sp}  生産${t.grassProduced.toFixed(0)}`);
}

/** パッチ条件の表示名 */
function tag(scale: number, contrast: number): string {
  return contrast === 0 ? '一様' : `大きさ${scale}/強さ${contrast}`;
}

// ---------------------------------------------------------------------------
header('1. パッチ場の実現値');
console.log('  重みの平均が1でなければ、不均質ではなく豊穣化／貧困化を測ってしまう');
for (const scale of [6, 15, 30]) {
  for (const contrast of [0.6, 0.9]) {
    const cfg = presetByKey('basic').build();
    cfg.grass.patch = { scale, contrast };
    cfg.species.forEach((s) => (s.initialCount = 0));
    const s = new World(cfg).grassWeightStats();
    console.log(
      `  大きさ${String(scale).padStart(2)} 強さ${contrast}  ` +
        `重み ${s.min.toFixed(3)} - ${s.max.toFixed(3)}  平均 ${s.mean.toFixed(4)}`,
    );
  }
}

// ---------------------------------------------------------------------------
header('2. 基本構成（既定の回復速度0.06）');
show('一様', await run(() => presetByKey('basic').build()));
for (const scale of [6, 15, 30]) {
  show(
    tag(scale, 0.9),
    await run(() => {
      const c = presetByKey('basic').build();
      c.grass.patch = { scale, contrast: 0.9 };
      return c;
    }),
  );
}

// ---------------------------------------------------------------------------
header('3. 豊穣化した基本構成（回復速度0.25）。06 では一様で 5/8 に崩壊した');
for (const [scale, contrast] of [[0, 0], [6, 0.9], [15, 0.6], [15, 0.9], [30, 0.9]] as const) {
  show(
    tag(scale, contrast),
    await run(() => {
      const c = presetByKey('basic').build();
      c.grass.regrow = 0.25;
      if (contrast > 0) c.grass.patch = { scale, contrast };
      return c;
    }),
  );
}

// ---------------------------------------------------------------------------
header('4. 4層・頂点捕食者の代謝の窓。02 では 0.55 で生存、0.65 で全滅だった');
for (const m of [0.45, 0.55, 0.6, 0.65]) {
  for (const [scale, contrast] of [[0, 0], [15, 0.9], [30, 0.9]] as const) {
    show(
      `代謝${m} ${tag(scale, contrast)}`,
      await run(() => {
        const c = presetByKey('fourtier').build();
        c.species[2].metabolism = m;
        if (contrast > 0) c.grass.patch = { scale, contrast };
        return c;
      }),
    );
  }
}

// ---------------------------------------------------------------------------
header('5. 機構の切り分け');

/**
 * 平均混み合い度 = Σ n(c)² / Σ n(c)
 * 「ある個体が自分のいるセルで見つける同種の数」。
 * 一様ランダムなら 1 + N/セル数 で、塊になるほど大きくなる。
 *
 * 捕食者と獲物の同セル密度を直接測ってはいけない。捕食は同じセルで起きるので、
 * ステップ後の状態には「その捕食者がたった今食べて空にしたセル」が写り、
 * 一様分布よりはるかに低い値が出る。
 */
function crowding(cfg: WorldConfig, steps: number, tail: number) {
  const w = new World(cfg);
  const n = w.defs.length;
  const cnt = new Int32Array(w.cells);
  const crowd = new Float64Array(n);
  const expect = new Float64Array(n);
  const seen = new Int32Array(n);

  for (let s = 0; s < steps; s++) {
    step(w);
    if (s < steps - tail || s % 10 !== 0) continue;
    for (let sp = 0; sp < n; sp++) {
      cnt.fill(0);
      let total = 0;
      for (let i = 0; i < w.count; i++) {
        if (w.aSpecies[i] !== sp) continue;
        cnt[w.aY[i] * w.width + w.aX[i]]++;
        total++;
      }
      if (total === 0) continue;
      let sq = 0;
      for (let c = 0; c < w.cells; c++) sq += cnt[c] * cnt[c];
      crowd[sp] += sq / total;
      expect[sp] += 1 + total / w.cells;
      seen[sp]++;
    }
  }
  return w.defs.map((d, i) => ({
    name: d.name,
    ratio: seen[i] ? crowd[i] / expect[i] : 0,
  }));
}

console.log('\n  集中度（一様ランダムなら1.00）。代謝0.45で全種が生き残る条件で比べる');
for (const [scale, contrast] of [[0, 0], [15, 0.9], [30, 0.9]] as const) {
  const acc: { name: string; ratio: number }[] = [];
  for (const seed of SEEDS8.slice(0, 4)) {
    const c = presetByKey('fourtier').build();
    c.seed = seed;
    c.species[2].metabolism = 0.45;
    if (contrast > 0) c.grass.patch = { scale, contrast };
    crowding(c, 3000, 1500).forEach((r, i) => {
      if (!acc[i]) acc[i] = { name: r.name, ratio: 0 };
      acc[i].ratio += r.ratio / 4;
    });
  }
  console.log(
    `  ${tag(scale, contrast).padEnd(16)} ` + acc.map((a) => `${a.name} ${a.ratio.toFixed(2)}`).join('  '),
  );
}

// 04 いわく崩壊は最初の1000ステップ台で決まる。そこの山と谷を見る
console.log('\n  序盤1500ステップの山と谷（代謝0.6、8シードの平均）');
console.log('  条件              草食の山  草食の谷  頂点の谷  草/セル');
for (const [scale, contrast] of [[0, 0], [15, 0.6], [15, 0.9], [30, 0.9]] as const) {
  const acc = { peak: 0, trough: 0, apex: 0, grass: 0 };
  for (const seed of SEEDS8) {
    const cfg = presetByKey('fourtier').build();
    cfg.seed = seed;
    cfg.species[2].metabolism = 0.6;
    if (contrast > 0) cfg.grass.patch = { scale, contrast };

    const w = new World(cfg);
    const counts = new Int32Array(3);
    let peak = 0;
    let trough = Infinity;
    let apex = Infinity;
    let grassSum = 0;
    let grassN = 0;

    for (let s = 0; s < 1500; s++) {
      step(w);
      w.countBySpecies(counts);
      if (counts[0] > peak) peak = counts[0];
      if (counts[0] < trough) trough = counts[0];
      if (counts[2] < apex) apex = counts[2];
      if (s % 25 === 0) {
        let g = 0;
        for (let c = 0; c < w.cells; c++) g += w.grass[c];
        grassSum += g / w.cells;
        grassN++;
      }
    }
    acc.peak += peak / SEEDS8.length;
    acc.trough += trough / SEEDS8.length;
    acc.apex += apex / SEEDS8.length;
    acc.grass += grassSum / grassN / SEEDS8.length;
  }
  console.log(
    `  ${tag(scale, contrast).padEnd(16)}  ${acc.peak.toFixed(0).padStart(6)}  ` +
      `${acc.trough.toFixed(0).padStart(8)}  ${acc.apex.toFixed(1).padStart(8)}  ${acc.grass.toFixed(2).padStart(6)}`,
  );
}

// ---------------------------------------------------------------------------
header('6. 燃費構成: 不均質は目の価値を上げるか');
console.log('  草食2種の違いは視野だけ。警戒型は草の多い方へ寄り、無警戒型はランダムに歩く');

function upkeep(visionCost: number, contrast: number, withPredator: boolean) {
  return () => {
    const c = presetByKey('upkeep').build();
    c.species.forEach((s) => (s.visionCost = visionCost));
    if (contrast > 0) c.grass.patch = { scale: 15, contrast };
    if (!withPredator) c.species[2].initialCount = 0;
    return c;
  };
}

console.log('\n  捕食者なし・視野コスト0（05 では 657 対 966 で、目は純粋な足枷だった）');
for (const contrast of [0, 0.3, 0.6, 0.9]) {
  show(tag(15, contrast), await run(upkeep(0, contrast, false)));
}

console.log('\n  捕食者あり。05 の交差点は視野コスト 0.025〜0.030 の間にあった');
for (const vc of [0.025, 0.045]) {
  for (const contrast of [0, 0.6, 0.9]) {
    show(`コスト${vc} ${tag(15, contrast)}`, await run(upkeep(vc, contrast, true)));
  }
}

// ---------------------------------------------------------------------------
header('7. なぜ採餌者が負けるのか: 単独で走らせて刈り残しを見る');
console.log('  競争相手を消して1種だけ住まわせる。草の残量が多いほど採り残している');

/**
 * 片方の草食動物だけを住まわせ、平衡状態での個体数と草の残量を測る。
 * 豊かなセル（重み1.2超）と痩せたセル（重み0.8未満）に分けて見る。
 */
function solo(kind: 'warier' | 'oblivious', contrast: number) {
  const acc = { all: 0, rich: 0, poor: 0, inRich: 0, pop: 0, n: 0 };
  const seeds = SEEDS8.slice(0, 4);

  for (const seed of seeds) {
    const cfg = presetByKey('upkeep').build();
    cfg.seed = seed;
    cfg.species.forEach((s) => (s.visionCost = 0)); // コスト差を消して行動だけを比べる
    cfg.species[2].initialCount = 0; // 捕食者なし
    cfg.species[kind === 'warier' ? 1 : 0].initialCount = 0;
    cfg.species[kind === 'warier' ? 0 : 1].initialCount = 600;
    if (contrast > 0) cfg.grass.patch = { scale: 15, contrast };

    const w = new World(cfg);
    const rich: number[] = [];
    const poor: number[] = [];
    for (let c = 0; c < w.cells; c++) {
      if (w.grassWeight[c] > 1.2) rich.push(c);
      else if (w.grassWeight[c] < 0.8) poor.push(c);
    }

    for (let s = 0; s < 4000; s++) {
      step(w);
      if (s < 2000 || s % 25 !== 0) continue;

      let g = 0;
      for (let c = 0; c < w.cells; c++) g += w.grass[c];
      acc.all += g / w.cells;
      if (rich.length) {
        let gr = 0;
        for (const c of rich) gr += w.grass[c];
        acc.rich += gr / rich.length;
      }
      if (poor.length) {
        let gp = 0;
        for (const c of poor) gp += w.grass[c];
        acc.poor += gp / poor.length;
      }

      let inRich = 0;
      for (let i = 0; i < w.count; i++) {
        if (w.grassWeight[w.aY[i] * w.width + w.aX[i]] > 1.2) inRich++;
      }
      acc.inRich += w.count ? inRich / w.count : 0;
      acc.pop += w.count;
      acc.n++;
    }
  }
  return {
    pop: acc.pop / acc.n,
    all: acc.all / acc.n,
    rich: acc.rich / acc.n,
    poor: acc.poor / acc.n,
    inRich: acc.inRich / acc.n,
  };
}

console.log('  条件                     個体数  草の残量(全体/豊か/痩せ)  豊かなセルにいる割合');
for (const contrast of [0, 0.9]) {
  for (const kind of ['warier', 'oblivious'] as const) {
    const r = solo(kind, contrast);
    const label = `${contrast === 0 ? '一様   ' : '強さ0.9'} ${kind === 'warier' ? '警戒型(視野3)' : '無警戒型(視野0)'}`;
    const split = contrast === 0 ? '   -      -  ' : `${r.rich.toFixed(2).padStart(5)}  ${r.poor.toFixed(2).padStart(5)}`;
    console.log(
      `  ${label.padEnd(24)} ${r.pop.toFixed(0).padStart(5)}   ${r.all.toFixed(2).padStart(5)}  ${split}` +
        `      ${contrast === 0 ? '-' : `${(r.inRich * 100).toFixed(1)}%`}`,
    );
  }
}
// 「豊かなセル」がどれだけの面積を占めるか。刈り残しの比較の下敷きになる
{
  const cfg = presetByKey('upkeep').build();
  cfg.grass.patch = { scale: 15, contrast: 0.9 };
  cfg.species.forEach((s) => (s.initialCount = 0));
  const w = new World(cfg);
  let n = 0;
  for (let c = 0; c < w.cells; c++) if (w.grassWeight[c] > 1.2) n++;
  console.log(`  （豊かなセルは世界の ${((n / w.cells) * 100).toFixed(1)}% を占める）`);
}

await done(t0);
