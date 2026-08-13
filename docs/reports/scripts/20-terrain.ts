/**
 * 20. 地形（移動の代償の不均質）は形質を分けるか
 *
 * [07](../07-grass-patches.md) が入れた不均質は**資源の分布**で、共存はむしろ壊れた。
 * 原因は「不均質さは軸を作ったが、全員が同じ規則で良い場所へ寄るので重複が増えた」。
 * 環境が軸になるのは**誰がどこを得意とするかが違う**ときだけで、07にはその差が無い。
 *
 * ここで入れるのは**形質を使う代償の分布**：
 *
 *   実効代謝 = metabolism + speedCost × speed × w(cell) + visionCost × vision
 *
 * 速度の限界代償 `∂/∂speed = speedCost × w` がセルで違うので、
 * 得意な場所の違いは種ごとに書かなくても形質から出る。
 * [10](../10-speed-evolution.md) の目型（0.78）と足型（2.45）を分ける軸になりうる。
 *
 * **対照は `target: 'base'`。** 同じ生成器・同じ場・同じコストのばらつきで、
 * 倍率が `metabolism` に掛かるだけ。`∂/∂speed` が `speedCost` で一定になるので
 * **形質との結合だけが消える**。16・17 の `scope: 'all'` と同じ形。
 *
 * 予想（外れたらレポートに残すこと）:
 *
 * 1. **一番ありそうな失敗は07と同じ形——地形はあるが誰も読まない。**
 *    ここで「読む」のは選択なので、個体が混ざる速さが地形の粗さを上回れば
 *    全員が平均を経験して消える。速度2.74なら30セルの起伏を100歩少々で抜ける。
 *    だから共存を問う前に**地形クラス別の速度が割れるか**を先に測る。割れなければ終わり
 * 2. 割れるとしたら遅い側から。速度0.78の個体は同じ30セルを抜けるのに1400歩かかるので、
 *    山に居着ける。速い個体は全域をならす
 * 3. 実現された平均倍率は1を下回る。個体は険しいセルで多く死ぬので、
 *    生きている個体の分布は平らな側に偏る。**この偏りは「起伏を入れた」と同時に
 *    「実質的にコストを下げた」ことになる**ので、必ず数字で見る（08で踏んだ形）
 *
 * 節5（二つの丘）はここでは流さない。節3で分離が出てからでないと、
 * 40000ステップを回しても解釈できない。
 *
 * 実行: node docs/reports/scripts/20-terrain.ts
 */
import { World } from '../../../src/core/world.ts';
import { step } from '../../../src/core/step.ts';
import { presetByKey } from '../../../src/core/presets.ts';
import type { WorldConfig } from '../../../src/core/types.ts';
import { trial, header, done, mark, speedOf, banner } from './_lib.ts';

const t0 = performance.now();
banner();

const SEEDS_8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
const SEEDS_4 = [1000, 2000, 3000, 4000];
/** 10 の SHORT と同じ。視野0の構成は収束が速い */
const STEPS = 10000;
const TAIL = 2000;
/** 起伏の粗さ。120×90 を割り切る最大値。細かくすると個体が1歩でまたいでしまう */
const SCALE = 30;

/**
 * 対照の contrast を決めるための基準速度。10 の収束先（捕食者あり 2.74）。
 *
 * `target: 'speed'` が振る量は `speedCost × speed × contrast = 0.15 × 2.74 × c`、
 * `base` は `metabolism × contrast = 0.25 × c`。同じ c では振れ幅が違うので、
 * 対照では c を `0.15 × 2.74 / 0.25 = 1.644` 倍して実効代謝の振れ幅を揃える。
 *
 * **速度そのものが条件で動くので、これは近似でしかない。** 節2で実際の
 * 振れ幅（`speedCost × 実測速度 × contrast`）を出して、揃っているか確かめる。
 */
const REF_SPEED = 2.74;
const SPEED_COST = 0.15;
const BASE_METABOLISM = 0.25;
const MATCH = (SPEED_COST * REF_SPEED) / BASE_METABOLISM;

interface Opts {
  contrast: number;
  target?: 'speed' | 'base';
  /** 視野3にすると 10 の分岐（目型・足型）の構成になる */
  vision?: number;
  start?: number;
}

function cfgOf(o: Opts): WorldConfig {
  const cfg = presetByKey('evolution').build();
  const [herb] = cfg.species;
  if (o.vision !== undefined) herb.visionRange = o.vision;
  if (o.start !== undefined) herb.speed = o.start;
  if (o.contrast > 0) {
    cfg.terrain = { scale: SCALE, contrast: o.contrast, target: o.target ?? 'speed' };
  }
  return cfg;
}

const build = (o: Opts) => () => cfgOf(o);

/** 対照の contrast。実効代謝の振れ幅を 'speed' 側に合わせる */
const matched = (c: number) => Math.min(1, c * MATCH);

// ---------------------------------------------------------------------------
header('節1: 場が設計どおりか');

/**
 * 平均がちょうど1になっていないと、起伏を入れたのかコストを上下させたのかが
 * 分けられない。07 のパッチと同じ要件で、同じ生成器を使っている。
 */
console.log('  倍率の分布（設計上 平均はちょうど1）');
for (const contrast of [0.3, 0.6, 0.9]) {
  const w = new World(cfgOf({ contrast }));
  const s = w.terrainWeightStats();
  console.log(
    `    強さ${contrast}  最小 ${s.min.toFixed(3)}  最大 ${s.max.toFixed(3)}  ` +
      `平均 ${s.mean.toFixed(6)}`,
  );
}

/**
 * 回帰の約束。contrast=0 は倍率が全て1なので、地形を入れる前と
 * **完全に一致**しなければならない。差分を足す形で実装してあるので、
 * 一致しないなら実装が壊れている（03 で3回踏んだ「実装の都合が
 * 生態系の挙動に見える」を先に潰す）。
 */
{
  const runs = SEEDS_4.map((seed) => {
    const flat = cfgOf({ contrast: 0 });
    flat.seed = seed;
    const zero = cfgOf({ contrast: 0 });
    zero.terrain = { scale: SCALE, contrast: 0, target: 'speed' };
    zero.seed = seed;
    return [popAfter(flat, 3000), popAfter(zero, 3000)] as const;
  });
  const same = runs.every(([a, b]) => a === b);
  console.log(
    `  地形なし と 強さ0 が一致: ${same ? 'OK' : '不一致'}  ` +
      runs.map(([a, b]) => `${a}/${b}`).join(' '),
  );
}

// ---------------------------------------------------------------------------
header('節2: 収束先と個体数は動くか');

console.log('  視野0（既定の進化構成）  8シード / 10000ステップ');
for (const contrast of [0, 0.3, 0.6, 0.9]) {
  await row(`起伏 ${contrast}`, { contrast });
}
console.log('  対照（倍率を基礎代謝に掛ける。実効代謝の振れ幅を揃えてある）');
for (const contrast of [0.3, 0.6]) {
  await row(`対照 ${contrast}→${matched(contrast).toFixed(2)}`, {
    contrast: matched(contrast),
    target: 'base',
  });
}

async function row(label: string, o: Opts): Promise<void> {
  const t = await trial(build(o), { seeds: SEEDS_8, steps: STEPS, tail: TAIL });
  const [herb, pred] = t.species;
  const swing = SPEED_COST * herb.speed * (o.target === 'base' ? 0 : o.contrast);
  console.log(
    `    ${label.padEnd(18)} ${mark(t)}${t.survived}/${t.total}  ` +
      `速度 ${speedOf(t).padEnd(20)} ばらつき ${herb.speedSd.toFixed(2)}  ` +
      `草食 ${herb.mean.toFixed(0).padStart(4)}(${herb.min}-${herb.max})  ` +
      `肉食 ${pred.mean.toFixed(0).padStart(3)}  ` +
      `振れ幅 ${swing.toFixed(3)}`,
  );
}

// ---------------------------------------------------------------------------
header('節3: 個体は地形で分かれるか');

/**
 * **本題の前提。** 分かれなければ、この軸から共存は出ない。
 *
 * 倍率で3分位に切り、クラスごとに個体数と平均速度を出す。
 * 速度が同じなら、地形はあっても誰も読んでいない（07 と同じ形）。
 *
 * 実現された平均倍率も一緒に出す。1を割っていれば、起伏を入れたと同時に
 * 実質的なコストを下げたことになるので、節2の個体数の差はそちらで説明がつく。
 */
console.log('  4シード / 10000ステップ / 後半2000ステップで集計');
console.log('  クラスは倍率の3分位（平/中/険）');
const sortConditions: Opts[] = [
  { contrast: 0.6 },
  { contrast: 0.9 },
  { contrast: matched(0.6), target: 'base' },
];
for (const o of sortConditions) {
  await sortRow(o);
}

// ---------------------------------------------------------------------------
header('節4: 速度を固定したら分離は消えるか');

/**
 * 節3で分離が出た場合の裏取り。速度が遺伝しない（全個体が同じ速度の）構成では
 * 「速い個体が平地に、遅い個体が山に」は原理的に起きない。
 * それでも個体数の偏りだけは残るはずで、**その偏りぶんを差し引いた残りが
 * 形質の分離**にあたる。分離が個体数の偏りと同じ大きさなら、
 * 見ているのは形質ではなく単に密度の偏り。
 */
console.log('  速度を 2.74 に固定（変異なし）');
await sortRow({ contrast: 0.6 }, { fixSpeed: REF_SPEED });

await done(t0);

// ---------------------------------------------------------------------------
// 以下は測定の道具

/** 3000ステップ走らせて草食の個体数を返す。回帰の一致確認用 */
function popAfter(cfg: WorldConfig, steps: number): number {
  const w = new World(cfg);
  for (let i = 0; i < steps; i++) step(w);
  let n = 0;
  for (let i = 0; i < w.count; i++) if (w.aSpecies[i] === 0) n++;
  return n;
}

interface SortOpts {
  /** 速度を種の定数に固定する（変異を外す）。節4で使う */
  fixSpeed?: number;
}

/**
 * 地形クラス別の個体数と平均速度。
 *
 * プール経由の RunResult は空間の内訳を持たないので、ここだけ直列で回す。
 * 4シード×10000ステップで40秒ほど。
 */
async function sortRow(o: Opts, s: SortOpts = {}): Promise<void> {
  const label =
    (o.target === 'base' ? `対照 強さ${o.contrast.toFixed(2)}` : `強さ${o.contrast}`) +
    (s.fixSpeed !== undefined ? ' 速度固定' : '');

  const pop = [0, 0, 0];
  const spd = [0, 0, 0];
  const spdN = [0, 0, 0];
  let paid = 0;
  let flat = 0;
  let samples = 0;
  let survived = 0;

  for (const seed of SEEDS_4) {
    const cfg = cfgOf(o);
    cfg.seed = seed;
    if (s.fixSpeed !== undefined) {
      const herb = cfg.species[0];
      herb.speed = s.fixSpeed;
      delete herb.mutation;
    }
    const w = new World(cfg);

    // 倍率の3分位の境目。世界ごとに場が違うので毎回引き直す
    const sorted = Float64Array.from(w.terrainWeight).sort();
    const lo = sorted[Math.floor(w.cells / 3)];
    const hi = sorted[Math.floor((2 * w.cells) / 3)];
    const klass = new Uint8Array(w.cells);
    for (let c = 0; c < w.cells; c++) {
      klass[c] = w.terrainWeight[c] < lo ? 0 : w.terrainWeight[c] < hi ? 1 : 2;
    }

    for (let i = 0; i < STEPS; i++) {
      step(w);
      if (i < STEPS - TAIL) continue;
      samples++;
      paid += w.terrainCostPaid;
      flat += w.terrainCostFlat;
      for (let a = 0; a < w.count; a++) {
        if (w.aSpecies[a] !== 0) continue;
        const k = klass[w.aY[a] * w.width + w.aX[a]];
        pop[k]++;
        spd[k] += w.aSpeed[a];
        spdN[k]++;
      }
    }
    let alive = 0;
    for (let a = 0; a < w.count; a++) if (w.aSpecies[a] === 0) alive++;
    if (alive > 0) survived++;
  }

  const per = (k: number) => pop[k] / samples;
  const avg = (k: number) => (spdN[k] > 0 ? spd[k] / spdN[k] : NaN);
  console.log(
    `    ${label.padEnd(20)} ${survived}/${SEEDS_4.length}  ` +
      `個体数 平${per(0).toFixed(0).padStart(4)} 中${per(1).toFixed(0).padStart(4)} ` +
      `険${per(2).toFixed(0).padStart(4)}  ` +
      `速度 平${avg(0).toFixed(2)} 中${avg(1).toFixed(2)} 険${avg(2).toFixed(2)}  ` +
      `実現倍率 ${(paid / flat).toFixed(4)}`,
  );
}
