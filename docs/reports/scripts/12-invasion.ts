import { presetByKey } from '../../../src/core/presets.ts';
import type { WorldConfig } from '../../../src/core/types.ts';
import {
  trials,
  invade,
  invasionLine,
  byResidentBin,
  byBin,
  crossTab,
  followLine,
  followCurve,
  header,
  done,
  banner,
  type Invasion,
} from './_lib.ts';

/**
 * レポート12: 侵入 — 少数の変異体は、いつなら食い込めるか
 *
 *   node docs/reports/scripts/12-invasion.ts
 *
 * DIRECTION.md で置き直した前提「繁栄にはある程度の安定が必須で、その上で
 * 許容できる範囲の揺らぎが必要になる」を直接測る。既存種が谷に落ちた瞬間なら
 * 少数の変異体が食い込めるはず、という筋。
 *
 * 変異システムは使わない。在来の草食動物を複製して代謝だけ変えた種を作り、
 * 平衡に達した世界へ1体ずつ投入して定着率を測る。系統追跡の配列が要らず、
 * 誰が侵入者かが個体数の系列にそのまま出る。
 *
 * 投入単位を1体にしてあるのは、この模型に集中の利点が無いため。無性生殖で
 * つがい探しが無く、草食は視野0で群れの利益も無い。10体を1セルに置くと
 * 互いの草を奪う損だけが出て、「定着しなかった」が「自分たちで餓死した」に化ける。
 * 1体なら配置という軸が最初から立たない。
 */

const t0 = performance.now();
banner();

const SEEDS_8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];

/** 在来の代謝。基本構成の草食動物の既定値 */
const RESIDENT_MET = 0.6;

/**
 * 侵入者を足した基本構成。
 *
 * 在来の草食を複製して代謝だけ変える。**肉食は両方を食べる**（preys: [1, 3]）。
 * 片方だけにすると 02 のキーストーンの機構が混ざって、定着したのが
 * 有利さのせいか捕食を免れたせいか分からなくなる。
 *
 * 種の並びは [在来, 侵入者, 肉食]。侵入者の initialCount が0なので
 * spawnInitial の乱数消費は基本構成と同じ順・同じ回数になる（下の回帰で確認する）。
 */
function cfgOf(invaderMetabolism: number): WorldConfig {
  const cfg = presetByKey('basic').build();
  const resident = cfg.species[0];
  const carnivore = cfg.species[1];
  const invader = {
    ...resident,
    id: 3,
    name: '侵入者',
    color: '#c9a5f2',
    metabolism: invaderMetabolism,
    initialCount: 0,
  };
  carnivore.preys = [1, 3];
  cfg.species = [resident, invader, carnivore];
  return cfg;
}

/** 侵入者を入れない基本構成。回帰の比較対象 */
function cfgBasic(): WorldConfig {
  return presetByKey('basic').build();
}

const INV = 1; // 侵入者の種インデックス

/**
 * 段A の既定。閾値に達したら即除去して、次を投入する。
 *
 * timeout は最初600で試したが、定着した試行に525ステップ掛かる例が出たので上げた。
 * 打ち切りが定着の手前に掛かると、遅い定着が失敗に化ける。
 * 打ち切り回数は毎回表示して、無視できる数であることを確認する。
 *
 * シードを8から16に増やしてある。最初の8シード×120回では、
 * 「揺らぎが選択を薄めるか」（谷と山で不利さの効き方が違うか）の交互作用が
 * 1.0pp ± 3pp で判定できなかった。標本を4倍にすれば ±0.7pp まで下がる。
 */
const SEEDS_16 = [
  1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000, 13000, 14000, 15000,
  16000,
];

const BASE = {
  invaderIdx: INV,
  warmup: 2000,
  attempts: 250,
  propagule: 1,
  clumped: false,
  establishAt: 30,
  timeout: 1500,
  recovery: 300,
  jitter: 300,
  followUp: 0,
  followEvery: 1000,
};

// ---------------------------------------------------------------------------
header('回帰: 侵入者の種を足しても在来の挙動は1個体も変わらないか');

/**
 * 種定義を1つ増やし、肉食の捕食対象も増やしている。個体が0なら何も起きないはずだが、
 * 「動かした覚えのない軸が動いていないか」（CLAUDE.md）を先に潰しておく。
 * ここがずれていたら、以降の定着率は在来の違いを見ているだけになる。
 */
{
  const [a, b] = await trials([cfgBasic, () => cfgOf(RESIDENT_MET)], { seeds: SEEDS_8 });
  // 基本構成の [草食, 肉食] と、侵入者入りの [草食, 侵入者, 肉食] を突き合わせる
  const pairs: [string, number, number][] = [
    ['草食 平均', a.species[0].mean, b.species[0].mean],
    ['草食 最小', a.species[0].min, b.species[0].min],
    ['草食 最大', a.species[0].max, b.species[0].max],
    ['肉食 平均', a.species[1].mean, b.species[2].mean],
    ['肉食 最小', a.species[1].min, b.species[2].min],
    ['肉食 最大', a.species[1].max, b.species[2].max],
    ['草の生産', a.grassProduced, b.grassProduced],
  ];
  let ok = true;
  for (const [name, x, y] of pairs) {
    if (x !== y) {
      ok = false;
      console.log(`  ✗ ${name}: ${x} ≠ ${y}`);
    }
  }
  console.log(
    ok
      ? `  一致（8シード / 草食 ${a.species[0].mean.toFixed(0)} 肉食 ${a.species[1].mean.toFixed(0)}）`
      : '  ずれている。侵入者の種定義が在来に影響している',
  );
  if (!ok) {
    await done(t0);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
header('校正: 中立・有利・不利で定着率が動く範囲に入っているか');

/**
 * 中立（在来と同一の代謝）は「有利さゼロでも何%は定着してしまう」ベースライン。
 * これが0%でも100%でも、以降の操作で何も見えない。
 *
 * 平衡上限は `回復速度 × セル数 ÷ 代謝` = 648 ÷ 代謝 なので、
 * 0.57 は在来に対して +5%、0.63 は -5% にあたる。
 */
const calib: { label: string; met: number }[] = [
  { label: '不利 0.63 (-5%)', met: 0.63 },
  { label: '中立 0.60 (±0)', met: RESIDENT_MET },
  { label: '有利 0.57 (+5%)', met: 0.57 },
  { label: '有利 0.54 (+11%)', met: 0.54 },
];

const results: Invasion[] = [];
for (const c of calib) {
  const v = await invade(() => cfgOf(c.met), { ...BASE, seeds: SEEDS_16 });
  invasionLine(c.label, v);
  results.push(v);
}

const neutral = results[1];
console.log(
  `\n  在来: ${neutral.resident[0].mean.toFixed(0)} ` +
    `(${neutral.resident[0].min}-${neutral.resident[0].max}) ` +
    `変動係数 ${neutral.resident[0].cv.toFixed(3)}`,
);
console.log(`  1走行あたりの投入 ${BASE.attempts}回 × ${neutral.runs}走行`);

// ---------------------------------------------------------------------------
/**
 * 刻みが広いのは在来の振れ幅が大きいから。基本構成は平均679に対して
 * 145〜1790（変動係数0.49）まで振れるので、比は0.2〜2.6の範囲に散る。
 */
const BINS = [0, 0.5, 0.75, 1.0, 1.25, 1.5];

header('谷で入れたほうが通るか（投入時の在来個体数で分ける）');

/**
 * **有利さゼロでも同じ傾きが出るなら、谷の効果は密度依存であって
 * 「既存種の壁に窓が開く」ではない。** 在来が少なければ1個体あたりの草が増えるので、
 * 侵入者でなくても得をする。中立と有利で傾きを比べるのがその切り分け。
 */
for (let i = 0; i < calib.length; i++) {
  console.log(`\n  [${calib[i].label}]`);
  byResidentBin(results[i], BINS);
}

// ---------------------------------------------------------------------------
header('在来個体数は代弁者ではないか（有利 0.57 を別の軸で分ける）');

/**
 * 在来が谷にいる時期は、同時に草が多い時期でもあり、捕食者の位相もずれている。
 * どの軸で束ねても同じ形が出るなら、在来個体数で語るのは「測っていない量を
 * 測った量で代弁させる」ことになる（10 でやった失敗）。
 */
console.log('\n  [草の総量]');
byBin(results[2], '草  ', (a) => a.grassRatio, BINS);

/**
 * 密度依存を疑うなら見るべきはこれ。草の総量ではなく**1個体あたりの草**。
 * 「在来が少ないと得」の中身が「取り合う相手が少ない」なら、
 * 在来個体数よりこの量のほうが定着率を説明するはず。
 * 比の比なので範囲が広く、刻みを別に取る。
 */
console.log('\n  [1個体あたりの草]');
byBin(results[2], '草/頭', (a) => a.grassRatio / a.ratio[0], [0, 0.75, 1.0, 1.5, 2.0, 3.0]);

console.log('\n  [捕食者の個体数]');
byBin(results[2], '捕食', (a) => a.ratio[2], BINS);

// ---------------------------------------------------------------------------
header('在来を固定したとき、草の総量はまだ効くか（有利 0.57）');

/**
 * 在来個体数と1個体あたりの草は、草の総量がほぼ一定なので実質同じ量になっている
 * （草/頭 ≒ 定数 ÷ 在来）。同じ数字を逆さにして2回測っても切り分けにならない。
 *
 * 在来のビンを固定すると、その中でも草の総量は散らばっている。そこで効くなら
 * 餌の量が効いていて、平らなら在来個体数そのもの（＝取り合う相手の数）が効いている。
 */
crossTab(
  results[2],
  '在来＼草',
  (a) => a.ratio[0],
  [0, 0.75, 1.25],
  (a) => a.grassRatio,
  [0, 0.9, 1.1],
);

// ---------------------------------------------------------------------------
header('段B: 30体に達した系統は居座るのか');

/**
 * 閾値到達は「定着」ではなく「30体に達した」でしかない。中立の侵入者が10%も
 * 通っているのは閾値が甘い疑いがある（中立な系統が k 体に達する確率は概ね 1/k
 * なので、680体の系で30体なら3%程度が目安）。
 *
 * 段Aと分けるのは、本当に定着した侵入者は在来を置き換えてしまうため。
 * 置き換わった後の世界へ投入を続けても、測りたかった世界ではない。
 * そこで最初の定着で投入を打ち切り、その系統だけを追う。
 *
 * 走行あたり1系統しか取れないので、シードを増やして数を稼ぐ。定着率が約10%なら
 * 120回の投入でほぼ確実に1回は起きる（起きない確率は 0.9^120 ≈ 3e-6）。
 */
const SEEDS_40 = Array.from({ length: 40 }, (_, i) => 1000 * (i + 1));
/**
 * 刻みを250にしたのは、消えるのが最初の数百ステップに集中しているため。
 * 試しに3走行だけ回したとき、30体に達した3系統のうち2つが131・88ステップで消えた。
 * 1000刻みだとその2つは最初のマークにすら届かず、曲線が出発点から折れて見える。
 */
const FOLLOW = {
  ...BASE,
  attempts: 120,
  followUp: 10000,
  followEvery: 250,
};
const SHOW = [250, 500, 1000, 2000, 5000, 10000];

const followed: Invasion[] = [];
for (const c of calib) {
  const v = await invade(() => cfgOf(c.met), { ...FOLLOW, seeds: SEEDS_40 });
  followLine(c.label, v);
  followed.push(v);
}

console.log('\n  まだ侵入者が生きている系統の割合（置換で終わった系統も生存に数える）');
for (let i = 0; i < calib.length; i++) followCurve(calib[i].label, followed[i], SHOW);

await done(t0);
