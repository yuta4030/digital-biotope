import { presetByKey } from '../../../src/core/presets.ts';
import { traceMany, type TraceJob } from '../../../src/sweep/pool.ts';
import type { TraceResult } from '../../../src/sweep/run.ts';
import { trials, header, done, banner } from './_lib.ts';
import type { WorldConfig } from '../../../src/core/types.ts';

/**
 * レポート13: 局所最適からの脱出
 *
 *   node docs/reports/scripts/13-escape.ts
 *
 * 12 で「揺らぎは不利な系統の通過率を4倍にする」と分かったが、通した先に
 * 行き場が無かった。代謝という軸は単調で、渡るべき谷の向こう側が存在しない。
 *
 * 10 の速度の分岐（目に頼る型 約0.78 / 足に頼る型 約2.45）は二つの最適が
 * 実在する landscape なので、そこで「揺らぎが局所最適から抜ける機会を作るか」を測る。
 *
 * 揺らぎのつまみを作って世界どうしを比べる設計は捨てた（節2にその記録）。
 * 代わりに 12 と同じ手を使う。**世界の中で自然に起きている揺らぎを使い、
 * 遷移が起きた時刻の前後で個体数がどうだったかを見る。**
 * 世界間の比較が要らないので、平均を固定するという要件そのものが消える。
 */

const t0 = performance.now();
banner();

const SEEDS_8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
const seedsOf = (n: number) => Array.from({ length: n }, (_, i) => 1000 * (i + 1));

/** 低い丘（目に頼る型）。10 では 0.76-0.83 に収まっていた */
const LOW = 0.78;
/**
 * ここを超えたら低い丘を離れたとみなす。低い丘のばらつき（10 で標準偏差0.13-0.19）
 * の外側に置く。2.45 まで待つと「離れた時刻」ではなく「着いた時刻」を測ることになる
 */
const DEPART = 1.2;

interface Opts {
  gain: number;
  contrast?: number;
  start?: number;
}

/** 10 の視野3の構成。草食に目を持たせると足に頼る必要が薄れ、分岐が現れる */
function cfgOf(o: Opts): WorldConfig {
  const cfg = presetByKey('evolution').build();
  const [herb, pred] = cfg.species;
  herb.visionRange = 3;
  herb.speed = o.start ?? LOW;
  pred.gainFromPrey = o.gain;
  if (o.contrast) cfg.grass.patch = { scale: 30, contrast: o.contrast };
  return cfg;
}

function job(o: Opts, seed: number, steps: number, every: number): TraceJob {
  const config = cfgOf(o);
  config.seed = seed;
  return { kind: 'trace', config, steps, every };
}

// ---------------------------------------------------------------------------
header('回帰: 個体数の標準偏差を足しても基本構成は変わらないか');

/**
 * 集計を1つ増やしただけで乱数は消費していないが、02 の数字と一致することを
 * 確かめておく。ここがずれていたら以降は全部読めない。
 */
{
  const [t] = await trials([() => presetByKey('basic').build()], { seeds: SEEDS_8 });
  const ok = t.species[0].mean.toFixed(0) === '684' && t.species[1].mean.toFixed(0) === '396';
  console.log(
    `  草食 ${t.species[0].mean.toFixed(0)} 肉食 ${t.species[1].mean.toFixed(0)}` +
      `  ${ok ? '（12と一致）' : '★ずれている'}`,
  );
}

// ---------------------------------------------------------------------------
header('節2: パッチは揺らぎのつまみにならない');

/**
 * 当初は「平均を揃えて揺らぎだけ違う世界」を作って比べる設計だった。
 * パッチは重みの平均が1に正規化されているので名目の生産量を変えない（07）。
 *
 * だが 07 が記録したとおり、豊かなセルが上限に張り付いて回復ぶんを捨てるので、
 * **実際に草へ入る量は下がる**。それが許容範囲かをここで測る。
 * 揺らぎ（変動係数）が動くかどうかも一緒に見る。
 */
{
  const STEPS = 20000;
  const contrasts = [0, 0.2, 0.4, 0.8];

  /**
   * 4条件を**1回の trials にまとめて渡す**。条件ごとに trials を呼んで
   * Promise.all で束ねてはいけない。ワーカーを使い回しているので dispatch を
   * 並行させると結果が取り違えられる（pool.ts の running を参照）。
   * 最初にその書き方をして、4条件が1ビットも違わない値になった。
   *
   * まとめて渡すほうが速くもある。条件×シードの全通りが1つのプールに流れるので、
   * 8シード / 4スレッドのような端数で待ちが出ない。
   */
  const ts = await trials(
    contrasts.map((contrast) => () => cfgOf({ gain: 26, contrast })),
    { seeds: SEEDS_8, steps: STEPS, tail: 8000 },
  );
  const rows = contrasts.map((contrast, i) => ({ contrast, t: ts[i] }));

  console.log('  contrast  草食 平均(sd) 変動係数   草の実生産   到達速度');
  for (const { contrast, t } of rows) {
    const h = t.species[0];
    const cv = h.mean > 0 ? h.sd / h.mean : 0;
    console.log(
      `    ${contrast.toFixed(1)}     ${h.mean.toFixed(0).padStart(4)}(${h.sd.toFixed(0).padStart(4)})  ` +
        `${cv.toFixed(3)}     ${t.grassProduced.toFixed(1).padStart(6)}     ` +
        `${h.speed.toFixed(2)}  ${t.survived}/${t.total}`,
    );
  }
  console.log('  ※ 草の実生産が下がるなら平均を固定できていない（07の既知の効果）');
}

// ---------------------------------------------------------------------------
header('節3: 二つの丘を多シードで測り直す');

/**
 * 10 は8シードで「利得26 で 4/8 が高いほうへ行く」と出した。7/8 と 8/8 の差が
 * 偶然の範囲であるのと同じ理由で、4/8 も幅が広い。遷移率を扱うので、
 * まずここをシードを増やして測り直す。
 *
 * 全て低い丘（0.78）から出発させる。高いところから出発すると降りる途中を
 * 見ることになり、10 で2回読み違えた形になる。
 */
const LONG = 40000;
const EVERY = 100;

interface Run {
  seed: number;
  gain: number;
  /** 種インデックス0（草食）の平均速度の推移 */
  speed: number[];
  /** 草食の個体数の推移 */
  pop: number[];
  /** 崩壊したマークの位置。-1 なら最後まで保った */
  deadAt: number;
  /** 低い丘を離れたマークの位置。-1 なら離れていない */
  departAt: number;
}

function analyze(seed: number, gain: number, r: TraceResult): Run {
  const speed = r.marks.map((m) => m.speedMean[0]);
  const pop = r.marks.map((m) => m.population[0]);
  const deadAt = r.marks.findIndex((m) => m.population.some((c) => c === 0));

  // 崩壊後は速度が定義値に戻るので、遷移の判定は崩壊前だけで行う
  const end = deadAt < 0 ? speed.length : deadAt;
  let departAt = -1;
  for (let i = 0; i < end; i++) {
    if (speed[i] >= DEPART) {
      departAt = i;
      break;
    }
  }
  return { seed, gain, speed, pop, deadAt, departAt };
}

const gains = [22, 26];
const seedCount: Record<number, number> = { 22: 24, 26: 48 };

const runs: Run[] = [];
for (const gain of gains) {
  const seeds = seedsOf(seedCount[gain]);
  const rs = await traceMany(seeds.map((s) => job({ gain }, s, LONG, EVERY)));
  seeds.forEach((s, i) => runs.push(analyze(s, gain, rs[i])));
}

for (const gain of gains) {
  const g = runs.filter((r) => r.gain === gain);
  const dead = g.filter((r) => r.deadAt >= 0);
  const ok = g.filter((r) => r.deadAt < 0);
  const left = ok.filter((r) => r.departAt >= 0);
  const finals = ok.map((r) => r.speed[r.speed.length - 1]);
  const high = finals.filter((v) => v >= 2.0).length;
  const low = finals.filter((v) => v < 1.2).length;

  console.log(
    `  利得${gain}  ${g.length}シード  崩壊 ${dead.length}  ` +
      `離脱 ${left.length}/${ok.length}  ` +
      `終着: 低 ${low} / 中 ${ok.length - low - high} / 高 ${high}`,
  );
}

// ---------------------------------------------------------------------------
header('節4: 遷移は谷で起きるか');

/**
 * 12 と同じ形の集計。ただし世界どうしを比べるのではなく、**同じ走行の中で**
 * 「離脱の直前の窓」と「無作為に取った窓」を比べる。
 *
 * 走行間の平均の違いが完全に落ちるのが利点。12 では走行平均で割って比を作ったが、
 * ここは同じ走行の中の対照なので、その正規化すら要らない。
 */
const WINDOW = 20; // 20マーク = 2000ステップ

/** 窓 [from, to) の平均個体数 */
const windowMean = (pop: number[], from: number, to: number): number => {
  let s = 0;
  for (let i = from; i < to; i++) s += pop[i];
  return s / (to - from);
};

{
  const rows: { gain: number; before: number[]; control: number[] }[] = [];

  for (const gain of gains) {
    const before: number[] = [];
    const control: number[] = [];

    for (const r of runs) {
      if (r.gain !== gain || r.deadAt >= 0 || r.departAt < WINDOW) continue;

      // 離脱までの区間が低い丘にいた期間。ここを基準にする
      const base = windowMean(r.pop, 0, r.departAt);
      before.push(windowMean(r.pop, r.departAt - WINDOW, r.departAt) / base);

      // 同じ走行の、離脱前の区間から取った窓すべて。位置による偏りを避けるため全部使う
      for (let i = 0; i + WINDOW <= r.departAt - WINDOW; i++) {
        control.push(windowMean(r.pop, i, i + WINDOW) / base);
      }
    }
    rows.push({ gain, before, control });
  }

  for (const { gain, before, control } of rows) {
    if (before.length === 0) {
      console.log(`  利得${gain}  離脱が無いか窓が足りない`);
      continue;
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // 離脱直前の窓が、対照の分布のどこに来るか。低いほど「谷で離脱した」
    const pct = before.map(
      (b) => control.filter((c) => c < b).length / control.length,
    );
    console.log(
      `  利得${gain}  離脱 ${before.length}件  ` +
        `直前の窓 ${avg(before).toFixed(3)}  対照 ${avg(control).toFixed(3)}  ` +
        `（対照分布での位置 平均${(avg(pct) * 100).toFixed(0)}%）`,
    );
    const lo = before.filter((_, i) => pct[i] < 0.25).length;
    const hi = before.filter((_, i) => pct[i] > 0.75).length;
    console.log(
      `           下位25%に入った離脱 ${lo}/${before.length}  ` +
        `上位25%に入った離脱 ${hi}/${before.length}`,
    );
  }
  console.log('  ※ 谷で起きるなら「直前の窓」が対照より小さく、位置が50%を大きく下回る');
}

await done(t0);
