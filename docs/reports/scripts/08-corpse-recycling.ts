import { presetByKey } from '../../../src/core/presets.ts';
import { World } from '../../../src/core/world.ts';
import { step } from '../../../src/core/step.ts';
import type { WorldConfig } from '../../../src/core/types.ts';
import { trial, header, done, type Trial } from './_lib.ts';

/**
 * レポート08: 死骸の還元
 *
 *   node docs/reports/scripts/08-corpse-recycling.ts
 *
 * 死んだ個体の体をその場の草に戻す。草が外から湧くだけの開いた系を、
 * 閉じたループに近づけたら何が変わるか。
 *
 * 要点は対照実験のほう。還元は回復速度とは別口でエネルギーを注ぎ込むので、
 * 何もしないと豊穣化（[06](../06-enrichment.md)）と区別がつかない。
 * 総入力を揃えた比較を必ず並べてある。
 *
 * 所要12分ほど。
 */

const t0 = performance.now();

const SEEDS8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
const STEPS = 6000;
const TAIL = 3000;

/** 04・06・07 と同じ条件で回す。過去の表とそのまま比べられるようにするため */
async function run(build: () => WorldConfig): Promise<Trial> {
  return trial(build, { seeds: SEEDS8, steps: STEPS, tail: TAIL });
}

function show(label: string, t: Trial): void {
  const total = t.grassProduced + t.corpseInput;
  console.log(
    `  ${label.padEnd(22)} ${t.survived}/${t.total}  ` +
      t.species
        .map((s) => `${s.mean.toFixed(0).padStart(4)}(${String(s.min).padStart(4)}-${String(s.max).padStart(4)})`)
        .join(' ') +
      `  草${t.grassProduced.toFixed(0)}+死骸${t.corpseInput.toFixed(0)}=${total.toFixed(0)}`,
  );
}

// ---------------------------------------------------------------------------
header('1. 死因の内訳（1ステップあたり、後半3000ステップ平均、seed1000）');
console.log('  還元が効くのは餓死と寿命死だけ。食べられた個体は体が捕食者に移っている');
for (const key of ['basic', 'fourtier'] as const) {
  const cfg = presetByKey(key).build();
  cfg.seed = 1000;
  const w = new World(cfg);
  const eaten = new Float64Array(w.defs.length);
  const other = new Float64Array(w.defs.length);
  let n = 0;
  for (let s = 0; s < STEPS; s++) {
    step(w);
    if (s < STEPS - TAIL) continue;
    for (let i = 0; i < w.defs.length; i++) {
      eaten[i] += w.deathsEaten[i];
      other[i] += w.deathsOther[i];
    }
    n++;
  }
  console.log(
    `  ${key.padEnd(9)} ` +
      w.defs
        .map((d, i) => {
          const e = eaten[i] / n;
          const o = other[i] / n;
          const pct = e + o > 0 ? (o / (e + o)) * 100 : 0;
          return `${d.name} 捕食${e.toFixed(1)} 餓死等${o.toFixed(1)} → 還元対象${pct.toFixed(0)}%`;
        })
        .join('  '),
  );
}

// ---------------------------------------------------------------------------
header('2. 基本構成: 草食動物だけ還元する');
for (const cg of [0, 4, 16]) {
  show(
    `草食の還元${cg}`,
    await run(() => {
      const c = presetByKey('basic').build();
      c.species[0].corpseGrass = cg;
      return c;
    }),
  );
}

header('3. 基本構成: 肉食動物を還元する（餓死100%なので全部が戻る）');
for (const cg of [0, 10, 20, 40, 80]) {
  show(
    `肉食の還元${cg}`,
    await run(() => {
      const c = presetByKey('basic').build();
      c.species[1].corpseGrass = cg;
      return c;
    }),
  );
}

header('4. 基本構成: 両方還元する');
for (const cg of [10, 20, 40]) {
  show(
    `両方の還元${cg}`,
    await run(() => {
      const c = presetByKey('basic').build();
      c.species.forEach((s) => (s.corpseGrass = cg));
      return c;
    }),
  );
}

// ---------------------------------------------------------------------------
header('5. 対照実験: 同じエネルギーを回復速度で一様に足す（基本構成）');
console.log('  還元を入れずに総入力だけを揃える。差が出れば「入れ方」が効いている');
for (const r of [0.06, 0.09, 0.12, 0.15, 0.18, 0.25]) {
  show(
    `回復速度${r}`,
    await run(() => {
      const c = presetByKey('basic').build();
      c.grass.regrow = r;
      return c;
    }),
  );
}

// ---------------------------------------------------------------------------
header('6. 4層: 還元と豊穣化を総入力で突き合わせる');
console.log('  頂点の代謝0.6と0.65は、既定の回復速度では 0/8（[02] の崖の外側）');
for (const m of [0.6, 0.65]) {
  for (const cg of [0, 20, 40]) {
    show(
      `代謝${m} 還元${cg}`,
      await run(() => {
        const c = presetByKey('fourtier').build();
        c.species[2].metabolism = m;
        c.species.forEach((s) => (s.corpseGrass = cg));
        return c;
      }),
    );
  }
  for (const r of [0.07, 0.08, 0.09]) {
    show(
      `代謝${m} 回復速度${r}`,
      await run(() => {
        const c = presetByKey('fourtier').build();
        c.species[2].metabolism = m;
        c.grass.regrow = r;
        return c;
      }),
    );
  }
}

// ---------------------------------------------------------------------------
header('7. 機構: 死骸はいつ戻ってくるのか');
console.log('  回復速度による供給は毎ステップ一定。死骸は死んだときだけ戻る');
console.log('  条件              死骸の流入 平均/変動係数   草食個体数との相関');

const cases: [string, (c: WorldConfig) => void][] = [
  ['肉食の還元40', (c) => (c.species[1].corpseGrass = 40)],
  ['肉食の還元80', (c) => (c.species[1].corpseGrass = 80)],
  ['両方の還元40', (c) => c.species.forEach((s) => (s.corpseGrass = 40))],
];

for (const [label, apply] of cases) {
  const series: number[] = [];
  const pops: number[] = [];
  for (const seed of SEEDS8.slice(0, 4)) {
    const cfg = presetByKey('basic').build();
    cfg.seed = seed;
    apply(cfg);
    const w = new World(cfg);
    const counts = new Int32Array(w.defs.length);
    for (let s = 0; s < STEPS; s++) {
      step(w);
      if (s < STEPS - TAIL) continue;
      w.countBySpecies(counts);
      series.push(w.grassFromCorpses);
      pops.push(counts[0]);
    }
  }
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const sd = Math.sqrt(series.reduce((a, b) => a + (b - mean) ** 2, 0) / series.length);
  console.log(`  ${label.padEnd(18)} ${mean.toFixed(1).padStart(6)} / ${(sd / mean).toFixed(2)}          ${corr(series, pops).toFixed(2)}`);
}

/**
 * ラグ付き相関。corr(死骸(t), 草食(t+lag))。
 *
 * 「死骸が次の暴走の燃料になっている」なら正のラグで正の相関が立つはず、
 * という確認のために測った。結果は下の表のとおり**ラグとともに符号が反転する**。
 * 両方の系列が同じ周期で振動しているので、相関は周期を写しているだけで、
 * 先行しているかどうかの証拠にはならない。
 */
function corrAt(a: number[], b: number[], lag: number): number {
  const n = Math.min(a.length, b.length) - Math.abs(lag);
  const ai = lag >= 0 ? 0 : -lag;
  const bi = lag >= 0 ? lag : 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[ai + i];
    mb += b[bi + i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[ai + i] - ma;
    const y = b[bi + i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return num / Math.sqrt(da * db);
}

function corr(a: number[], b: number[]): number {
  return corrAt(a, b, 0);
}

console.log('\n  ラグ付き相関 corr(死骸流入(t), 草食個体数(t+lag))');
const LAGS = [-200, -100, -50, 0, 50, 100, 150, 200, 300];
console.log('  条件              ' + LAGS.map((l) => String(l).padStart(6)).join(''));

for (const [label, apply] of cases) {
  const acc = new Float64Array(LAGS.length);
  const seeds = SEEDS8.slice(0, 4);
  let used = 0;
  for (const seed of seeds) {
    const cfg = presetByKey('basic').build();
    cfg.seed = seed;
    apply(cfg);
    const w = new World(cfg);
    const counts = new Int32Array(w.defs.length);
    const corpse: number[] = [];
    const pop: number[] = [];
    for (let s = 0; s < STEPS; s++) {
      step(w);
      if (s < STEPS - TAIL) continue;
      w.countBySpecies(counts);
      corpse.push(w.grassFromCorpses);
      pop.push(counts[0]);
    }
    // 崩壊した試行は系列が定数になり相関が定義できない
    if (pop[pop.length - 1] === 0) continue;
    LAGS.forEach((l, i) => (acc[i] += corrAt(corpse, pop, l)));
    used++;
  }
  console.log(
    `  ${label.padEnd(18)}` + Array.from(acc, (v) => (v / used).toFixed(2).padStart(6)).join(''),
  );
}

await done(t0);
