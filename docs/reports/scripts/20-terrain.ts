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
  /** 地形を草食（id=1）だけに掛ける。捕食者経由の交絡を外すため */
  herbOnly?: boolean;
  /** 肉食の初期個体数を0にする。捕食圧が消えるので速度は約1.11に落ちる */
  predator?: boolean;
  /**
   * 肉食にも速度を遺伝させる。10 は草食だけを進化させたので、これは新しい。
   *
   * 地形の直接効果は弱い（速度差0.04）。コストが速度に線形で、振れ幅が
   * 実効代謝の数%しかないため。だが 10 が出したのは「速い足の価値は捕食圧が
   * 生んでいる」で、捕食者あり2.74 / なし1.11 と**2.5倍振れる**。
   * 捕食圧は丘に対して桁違いに強いレバーになる。
   *
   * 捕食者が進化できるなら、山では速い捕食者が高くつく。捕食者が遅くなるか
   * 減るかして**山が捕食圧の低い場所になる**なら、山では目型・平地では足型という
   * 差が、直接のコスト差ではなく 10 が実証済みの強いレバー経由で出る。
   */
  predatorEvolves?: boolean;
}

function cfgOf(o: Opts): WorldConfig {
  const cfg = presetByKey('evolution').build();
  const [herb, pred] = cfg.species;
  if (o.vision !== undefined) herb.visionRange = o.vision;
  if (o.start !== undefined) herb.speed = o.start;
  if (o.predator === false) pred.initialCount = 0;
  // 草食と同じ刻み。速い足の上限も同じにしておく（別にすると
  // 「どちらが速くなれるか」が設定で決まってしまう）
  if (o.predatorEvolves) pred.mutation = { speedSigma: 0.05, speedMin: 0, speedMax: 4 };
  if (o.contrast > 0) {
    cfg.terrain = {
      scale: SCALE,
      contrast: o.contrast,
      target: o.target ?? 'speed',
      ...(o.herbOnly ? { species: [1] } : {}),
    };
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
    `    ${label.padEnd(20)} ${mark(t)}${t.survived}/${t.total}  ` +
      `速度 ${speedOf(t).padEnd(20)} ばらつき ${herb.speedSd.toFixed(2)}  ` +
      `草食 ${herb.mean.toFixed(0).padStart(4)}(${herb.min}-${herb.max})  ` +
      `肉食 ${pred.mean.toFixed(0).padStart(3)}  ` +
      // 捕食者が進化する構成では、捕食者の速度こそが見たいもの
      (o.predatorEvolves
        ? `肉食速度 ${speedOf(t, 1).padEnd(20)} ばらつき ${pred.speedSd.toFixed(2)}`
        : `振れ幅 ${swing.toFixed(3)}`),
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

// ---------------------------------------------------------------------------
header('節5: 捕食者を地形から外す');

/**
 * 第1回の節2は**交絡していた**。地形を全種に掛けると捕食者の移動コスト
 * （`speedCost 0.15 × speed 2 = 0.3`、実効代謝0.575の52%）も不均質になり、
 * 実現倍率が1を割るぶん捕食者が安くなる。肉食が 341 → 379 に増えていて、
 * 10 が示したとおり**捕食圧が速度の丘を動かす**。
 *
 * つまり「地形が丘を動かした」ではなく「地形が捕食者を増やして丘が動いた」
 * かもしれない。[14](../14-mass-death.md) が大量死でまったく同じ形に躓き、
 * 対象を草食だけに絞って解決している。同じ手を当てる。
 *
 * これで丘が動かなくなるなら、第1回の速度上昇は全部捕食圧の話だった。
 */
console.log('  地形を草食だけに掛ける  8シード / 10000ステップ');
for (const contrast of [0, 0.6, 0.9]) {
  await row(`草食のみ ${contrast}`, { contrast, herbOnly: true });
}
await row(`草食のみ対照 ${matched(0.6).toFixed(2)}`, {
  contrast: matched(0.6),
  target: 'base',
  herbOnly: true,
});
console.log('  地形クラス別');
await sortRow({ contrast: 0.6, herbOnly: true });
await sortRow({ contrast: 0.9, herbOnly: true });

// ---------------------------------------------------------------------------
header('節6: 遅い集団なら分離するか');

/**
 * 予想2の検定。分離が起きるには、系統が同じ地形クラスに居続ける時間が
 * 選択の効く時間を上回る必要がある。速度2.9の個体はランダムウォークで
 * 30セルの起伏を100歩少々で抜けるが、1.1なら700歩かかる。
 *
 * 捕食者を外すと速度は約1.11に落ちる（10）。**混ざりが遅くなるので、
 * 分離が出るとしたらここ。** 出なければ「混ざるから消えた」ではなく
 * 「そもそもこの軸は形質を分けない」ことになる。
 *
 * 捕食者がいないぶん、地形は全種に掛けても交絡しない（草食しかいない）。
 */
console.log('  肉食なし（速度は約1.11に落ちる）  8シード / 10000ステップ');
for (const contrast of [0, 0.6, 0.9]) {
  await row(`肉食なし ${contrast}`, { contrast, predator: false });
}
console.log('  地形クラス別');
await sortRow({ contrast: 0.6, predator: false });
await sortRow({ contrast: 0.9, predator: false });

// ---------------------------------------------------------------------------
header('節7: 捕食者も速度を遺伝させる');

/**
 * ここまでで測っていたのは地形の**直接効果**で、それは弱い。コストが速度に
 * 線形で、振れ幅が実効代謝の数%しかないため（節3で速度差0.04）。
 *
 * だが 10 が出した一番強いレバーは捕食圧だった——捕食者あり2.74 / なし1.11 で
 * **2.5倍振れる**。地形が捕食圧の地図になるなら、直接効果より桁違いに強い。
 *
 * 10 は草食だけを進化させたので、捕食者が進化する構成そのものが新しい。
 * だから contrast 0 の行が要る。**捕食者の速度がどこに落ち着くかを誰も知らない。**
 *
 * 予想:
 * 1. 平坦（contrast 0）でも軍拡が起きて、両方が上限近くまで走るか、
 *    釣り合う内点に落ち着くかのどちらか。10 の速度コストは代償として効いているので
 *    内点のほうだと思うが、追う側と逃げる側で最適が違うので分からない
 * 2. 起伏があると、山では速い捕食者が高くつく。捕食者が山で減るか遅くなるなら、
 *    **山は捕食圧の低い場所になる**。そうなれば山の草食は遅くてよくなる
 * 3. 効くとしたら草食の速度差は節3の0.04より大きくなる。
 *    同じくらいなら、捕食圧という強いレバーを経由しても届かないことになる
 *
 * 注意: これは**軸を2本同時に足している**（地形と捕食者の変異）。
 * contrast 0 の行がその片方だけの対照になる。
 */
console.log('  8シード / 10000ステップ');
for (const contrast of [0, 0.6, 0.9]) {
  await row(`両方進化 ${contrast}`, { contrast, predatorEvolves: true });
}
console.log('  地形クラス別（上段が草食、下段が肉食）');
await sortRow({ contrast: 0.6, predatorEvolves: true });
await sortRow({ contrast: 0.9, predatorEvolves: true });

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
    (o.herbOnly ? ' 草食のみ' : '') +
    (o.predator === false ? ' 肉食なし' : '') +
    (s.fixSpeed !== undefined ? ' 速度固定' : '');

  // [種インデックス][地形クラス]。捕食者も進化する構成では両方見ないと、
  // 「山が捕食圧の低い場所になったか」が分からない
  const pop = [
    [0, 0, 0],
    [0, 0, 0],
  ];
  const spd = [
    [0, 0, 0],
    [0, 0, 0],
  ];
  const spdN = [
    [0, 0, 0],
    [0, 0, 0],
  ];
  /**
   * 地形クラスごとの速度の**分布**。平均だけでは「山に居着いた遅い個体群」が
   * 通過中の速い個体に薄められて見えない。
   *
   * 10 が集団全体で標準偏差を出したのと同じ理由（`world.ts` の speedStats:
   * 平均だけでは1点に集まっているのか二群に割れているのかが区別できない）を、
   * クラス別にも当てる。第1回はここを外していた。
   *
   * 全サンプルを持つと数百万件になるのでヒストグラムに畳む。
   * 幅0.05・上限4.0（mutation の speedMax と同じ）。
   */
  const BIN = 0.05;
  const BINS = Math.round(4 / BIN) + 1;
  const hist = [
    [new Float64Array(BINS), new Float64Array(BINS), new Float64Array(BINS)],
    [new Float64Array(BINS), new Float64Array(BINS), new Float64Array(BINS)],
  ];
  // クラス別の標準偏差用。二群に割れていれば平均が同じでもここが跳ねる
  const spdSq = [
    [0, 0, 0],
    [0, 0, 0],
  ];
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
        const si = w.aSpecies[a];
        if (si > 1) continue;
        const k = klass[w.aY[a] * w.width + w.aX[a]];
        const v = w.aSpeed[a];
        pop[si][k]++;
        spd[si][k] += v;
        spdSq[si][k] += v * v;
        spdN[si][k]++;
        hist[si][k][Math.min(BINS - 1, Math.max(0, Math.round(v / BIN)))]++;
      }
    }
    let alive = 0;
    for (let a = 0; a < w.count; a++) if (w.aSpecies[a] === 0) alive++;
    if (alive > 0) survived++;
  }

  const per = (s: number, k: number) => pop[s][k] / samples;
  const avg = (s: number, k: number) => (spdN[s][k] > 0 ? spd[s][k] / spdN[s][k] : NaN);
  const row3 = (name: string, s: number, f: (s: number, k: number) => number, d: number) =>
    `${name} 平${f(s, 0).toFixed(d)} 中${f(s, 1).toFixed(d)} 険${f(s, 2).toFixed(d)}`;

  console.log(
    `    ${label.padEnd(24)} ${survived}/${SEEDS_4.length}  ` +
      `${row3('草食', 0, per, 0)}  ${row3('速度', 0, avg, 2)}  ` +
      `実現倍率 ${(paid / flat).toFixed(4)}`,
  );
  // 捕食者が進化する構成でだけ、捕食者の側も出す。
  // 山が捕食圧の低い場所になったなら、ここに個体数か速度の差が出る
  if (o.predatorEvolves) {
    console.log(
      `      ${''.padEnd(22)}      ${row3('肉食', 1, per, 1)}  ${row3('速度', 1, avg, 2)}`,
    );
  }

  // 分布。少数派が居着いているなら、平均が同じでも下側の分位と
  // 標準偏差に出る。速度固定の構成では意味がないので飛ばす
  if (s.fixSpeed === undefined) {
    const names = ['平', '中', '険'];
    const cols = [0, 1, 2].map((k) => {
      const n = spdN[0][k];
      const mean = spd[0][k] / n;
      const sd = Math.sqrt(Math.max(0, spdSq[0][k] / n - mean * mean));
      const q = (p: number) => quantile(hist[0][k], n, p, BIN);
      return (
        `${names[k]} sd${sd.toFixed(2)} ` +
        `[${q(0.05).toFixed(2)} ${q(0.25).toFixed(2)} ${q(0.5).toFixed(2)} ${q(0.95).toFixed(2)}]`
      );
    });
    console.log(`      分布(5/25/50/95%)  ${cols.join('  ')}`);
  }
}

/** ヒストグラムから分位点を読む。境界は線形補間せずビンの中心を返す */
function quantile(h: Float64Array, n: number, p: number, bin: number): number {
  const target = n * p;
  let acc = 0;
  for (let i = 0; i < h.length; i++) {
    acc += h[i];
    if (acc >= target) return i * bin;
  }
  return (h.length - 1) * bin;
}
