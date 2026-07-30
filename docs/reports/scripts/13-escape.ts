import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
  /**
   * 捕食者の個体数の推移。
   *
   * 谷は同時に捕食圧が最も高い瞬間でもある（捕食者と被食者は位相がずれる）ので、
   * 「谷で離脱する」だけでは揺らぎの話か強い方向性選択の話か区別がつかない。
   */
  pred: number[];
  /**
   * 捕食圧の代理。草食1個体あたりの捕食者数。
   *
   * **窓で使うときはマークごとの比を平均してはいけない。** pop が谷で小さくなると
   * pred/pop が跳ね上がるので、比の平均は谷の深さに支配される。最初そう実装して、
   * 「草食が低く捕食者が高いのに捕食圧は低い」という辻褄の合わない表が出た。
   * 窓では windowRatio（窓平均どうしの比）を使う。
   */
  pressure: number[];
  /** 崩壊したマークの位置。-1 なら最後まで保った */
  deadAt: number;
  /** 低い丘を離れたマークの位置。-1 なら離れていない */
  departAt: number;
}

/**
 * 平均速度が初めて閾値を超えたマーク。崩壊後は速度が定義値に戻るので崩壊前だけ見る。
 * 閾値を引数にしてあるのは、感度を見るときに同じトレースから測り直すため。
 */
function departureAt(speed: number[], deadAt: number, threshold: number): number {
  const end = deadAt < 0 ? speed.length : deadAt;
  for (let i = 0; i < end; i++) if (speed[i] >= threshold) return i;
  return -1;
}

function analyze(seed: number, gain: number, r: TraceResult): Run {
  const speed = r.marks.map((m) => m.speedMean[0]);
  const pop = r.marks.map((m) => m.population[0]);
  const pred = r.marks.map((m) => m.population[1]);
  const pressure = pop.map((h, i) => (h > 0 ? pred[i] / h : 0));
  const deadAt = r.marks.findIndex((m) => m.population.some((c) => c === 0));

  const departAt = departureAt(speed, deadAt, DEPART);
  return { seed, gain, speed, pop, pred, pressure, deadAt, departAt };
}

const gains = [22, 26];
const seedCount: Record<number, number> = { 22: 24, 26: 48 };

/**
 * トレースをキャッシュする。節3の72本（40000ステップ・視野3）で14分掛かるのに、
 * 節4は同じトレースを集計し直すだけなので、解析を1回直すたびに14分払うのは無駄。
 *
 * BIOTOPE_REFRESH=1 で取り直す。**条件（利得・シード数・ステップ・刻み）を
 * 変えたら必ず取り直すこと。** キャッシュの鍵に条件を入れてあるので、
 * 変えれば自動で取り直しになる。
 */
const CACHE = new URL('./.cache/13-traces.json', import.meta.url);
const cacheKey = JSON.stringify({ LONG, EVERY, gains, seedCount, DEPART });

async function collect(): Promise<Run[]> {
  if (!process.env.BIOTOPE_REFRESH) {
    try {
      const saved = JSON.parse(await readFile(CACHE, 'utf8'));
      if (saved.key === cacheKey) {
        console.log('  （トレースはキャッシュから。取り直すには BIOTOPE_REFRESH=1）');
        return saved.runs as Run[];
      }
      console.log('  （条件が変わっているのでトレースを取り直す）');
    } catch {
      // 無ければ取る
    }
  }
  const out: Run[] = [];
  for (const gain of gains) {
    const seeds = seedsOf(seedCount[gain]);
    const rs = await traceMany(seeds.map((s) => job({ gain }, s, LONG, EVERY)));
    seeds.forEach((s, i) => out.push(analyze(s, gain, rs[i])));
  }
  await mkdir(new URL('./.cache/', import.meta.url), { recursive: true });
  await writeFile(CACHE, JSON.stringify({ key: cacheKey, runs: out }));
  return out;
}

const runs = await collect();

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

/**
 * 窓 [from, to) での「捕食者1体あたり」ではなく「草食1体あたりの捕食者数」。
 * 窓平均どうしの比なので、谷の深さに支配されない。
 */
const windowRatio = (num: number[], den: number[], from: number, to: number): number => {
  const d = windowMean(den, from, to);
  return d > 0 ? windowMean(num, from, to) / d : 0;
};

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * 離脱直前の窓を、同じ走行の対照窓の分布と比べる。
 *
 * `pick` で系列を選ぶ。草食個体数・捕食者数・捕食圧のどれでも同じ形で測れる。
 * `keep` を渡すと対照窓を絞れる（草食の谷だけに限定して捕食圧を比べる用）。
 */
function compare(
  label: string,
  gain: number,
  /** 窓 [from, to) の値。系列の平均でも、窓平均どうしの比でもよい */
  valueOf: (r: Run, from: number, to: number) => number,
  keep?: (r: Run, from: number) => boolean,
): void {
  const before: number[] = [];
  const control: number[] = [];
  let skipped = 0;

  for (const r of runs) {
    if (r.gain !== gain || r.deadAt >= 0 || r.departAt < 0) continue;
    // 離脱の直前に窓ぶんの履歴が無い走行は測れない。黙って落とさず数える
    if (r.departAt < WINDOW * 2) {
      skipped++;
      continue;
    }
    // 離脱までの区間が低い丘にいた期間。ここを基準にして走行間の水準差を消す
    const base = valueOf(r, 0, r.departAt);
    if (base <= 0) continue;
    before.push(valueOf(r, r.departAt - WINDOW, r.departAt) / base);

    // 同じ走行の、離脱前の区間から取った窓すべて。位置による偏りを避けるため全部使う
    for (let i = 0; i + WINDOW <= r.departAt - WINDOW; i++) {
      if (keep && !keep(r, i)) continue;
      control.push(valueOf(r, i, i + WINDOW) / base);
    }
  }

  if (before.length === 0 || control.length === 0) {
    console.log(`  ${label} 利得${gain}  測れる離脱が無い（除外 ${skipped}）`);
    return;
  }
  const pct = before.map((b) => control.filter((c) => c < b).length / control.length);
  const lo = pct.filter((p) => p < 0.25).length;
  const hi = pct.filter((p) => p > 0.75).length;
  console.log(
    `  ${label} 利得${gain}  離脱${String(before.length).padStart(2)}件` +
      `（除外${skipped}）  直前 ${avg(before).toFixed(3)}  対照 ${avg(control).toFixed(3)}` +
      `  位置 平均${(avg(pct) * 100).toFixed(0).padStart(3)}%` +
      `  下位25% ${lo}/${before.length}  上位25% ${hi}/${before.length}`,
  );
}

console.log('\n  [草食の個体数] 谷で離脱するなら 直前 < 対照、位置が50%を下回る');
for (const gain of gains) compare('草食', gain, (r, a, b) => windowMean(r.pop, a, b));

console.log('\n  [捕食者の個体数]');
for (const gain of gains) compare('捕食者', gain, (r, a, b) => windowMean(r.pred, a, b));

console.log('\n  [捕食圧 = 捕食者 / 草食] 仮説Bなら 直前 > 対照、位置が50%を上回る');
for (const gain of gains) {
  compare('捕食圧', gain, (r, a, b) => windowRatio(r.pred, r.pop, a, b));
}

/**
 * 切り分け。**草食が谷にある窓だけを対照にして**、捕食圧を比べる。
 *
 * 谷は同時に捕食圧が高い瞬間なので、上の3つは全部同じ位相を写している可能性がある
 * （12 で在来個体数・草・捕食者のどれで割っても勾配が出たのと同じ形）。
 * 谷を固定してなお捕食圧が高いなら仮説B、平らなら谷そのものが効いている。
 */
/**
 * 谷の絞り込みは**走行ごとの分位点**で取る。最初は固定の 0.85 で切ったが、
 * 利得22 は振れ幅が小さく、その閾値を下回る対照窓が1つも無くて測れなかった。
 * 閾値を世界の側の性質で決めてはいけない。
 */
const troughCut = new Map<number, number>();
for (const r of runs) {
  if (r.deadAt >= 0 || r.departAt < WINDOW * 2) continue;
  const base = windowMean(r.pop, 0, r.departAt);
  const xs: number[] = [];
  for (let i = 0; i + WINDOW <= r.departAt - WINDOW; i++) {
    xs.push(windowMean(r.pop, i, i + WINDOW) / base);
  }
  xs.sort((a, b) => a - b);
  if (xs.length > 0) troughCut.set(r.seed * 100 + r.gain, xs[Math.floor(xs.length / 3)]);
}

/**
 * 逆向きの切り分け。**捕食者の数を揃えた窓だけ**で、草食の谷がまだ効くか。
 *
 * 捕食圧（捕食者/草食）は草食を分母に持つので、草食が谷なら算術的に上がる。
 * 12 で「1個体あたりの草 ≒ 定数 ÷ 在来」だったのと同じ形で、片方を固定しないと
 * どちらが動かしているか言えない。捕食者の頭数は草食と算術的に結びついていないので、
 * これを揃えれば独立な検定になる。
 */
const predCut = new Map<number, number>();
for (const r of runs) {
  if (r.deadAt >= 0 || r.departAt < WINDOW * 2) continue;
  const base = windowMean(r.pred, 0, r.departAt);
  const xs: number[] = [];
  for (let i = 0; i + WINDOW <= r.departAt - WINDOW; i++) {
    xs.push(windowMean(r.pred, i, i + WINDOW) / base);
  }
  xs.sort((a, b) => a - b);
  if (xs.length > 0) predCut.set(r.seed * 100 + r.gain, xs[Math.floor(xs.length / 2)]);
}

console.log('\n  [捕食者が多い窓（その走行の上位50%）だけに限った草食の個体数]');
for (const gain of gains) {
  compare(
    '草食|捕食者多',
    gain,
    (r, a, b) => windowMean(r.pop, a, b),
    (r, from) => {
      const cut = predCut.get(r.seed * 100 + r.gain);
      if (cut === undefined) return false;
      const base = windowMean(r.pred, 0, r.departAt);
      return base > 0 && windowMean(r.pred, from, from + WINDOW) / base >= cut;
    },
  );
}

console.log('\n  [草食が谷（その走行の下位33%）の窓だけに限った捕食圧]');
for (const gain of gains) {
  compare(
    '捕食圧|谷',
    gain,
    (r, a, b) => windowRatio(r.pred, r.pop, a, b),
    (r, from) => {
      const cut = troughCut.get(r.seed * 100 + r.gain);
      if (cut === undefined) return false;
      const base = windowMean(r.pop, 0, r.departAt);
      return base > 0 && windowMean(r.pop, from, from + WINDOW) / base <= cut;
    },
  );
}

// ---------------------------------------------------------------------------
header('節4b: 全ての離脱イベントで測り直す');

/**
 * 節4 は走行ごとの**最初の1回**しか使っていない。節7 で分かったとおり離脱は
 * 頻繁に起きていて（利得22 で1走行3.58回）、最初の1件は全体の2割でしかない。
 * 全イベントで測り直す。
 *
 * さらに、本当に知りたいのは**成功した脱出と失敗した往復で谷の深さが違うか**。
 * 節7 で「離脱は頻繁で、稀なのは居着くほう」と分かったので、
 * 離脱の条件ではなく定着の条件のほうが本題になる。
 */
interface Excursion {
  run: Run;
  /** 上りの瞬間のマーク位置 */
  at: number;
  /** 2.0 に到達したか */
  arrived: boolean;
  /** 低い丘へ戻ったか */
  returned: boolean;
}

const UP = 1.2;
const DOWN = 1.0;
const ARRIVE = 2.0;

/** 低い丘にいる区間だけを対照に使う。離脱中の窓を混ぜると比較にならない */
function lowMask(r: Run): boolean[] {
  const end = r.deadAt < 0 ? r.speed.length : r.deadAt;
  const mask = new Array<boolean>(r.speed.length).fill(false);
  let out = false;
  for (let i = 0; i < end; i++) {
    if (!out && r.speed[i] >= UP) out = true;
    else if (out && r.speed[i] < DOWN) out = false;
    mask[i] = !out;
  }
  return mask;
}

function excursions(r: Run): Excursion[] {
  const end = r.deadAt < 0 ? r.speed.length : r.deadAt;
  const out: Excursion[] = [];
  let cur: Excursion | null = null;
  for (let i = 0; i < end; i++) {
    if (cur === null && r.speed[i] >= UP) {
      cur = { run: r, at: i, arrived: false, returned: false };
      out.push(cur);
    } else if (cur !== null) {
      if (r.speed[i] >= ARRIVE) cur.arrived = true;
      if (r.speed[i] < DOWN) {
        cur.returned = true;
        cur = null;
      }
    }
  }
  return out;
}

{
  console.log('  対照は「低い丘にいる区間の窓」だけ。離脱中の窓を混ぜないため\n');
  console.log('  利得  対象            件数  直前   対照   位置  下位25%  上位25%');

  for (const gain of gains) {
    const ok = runs.filter((r) => r.gain === gain && r.deadAt < 0);
    const all: Excursion[] = [];
    for (const r of ok) all.push(...excursions(r));

    /** 定着した離脱 = 2.0 に届いて、そのまま低い丘へ戻らなかったもの */
    const groups: [string, Excursion[]][] = [
      ['全イベント', all],
      ['戻った往復', all.filter((e) => e.returned)],
      ['定着した脱出', all.filter((e) => e.arrived && !e.returned)],
    ];

    for (const [label, es] of groups) {
      const before: number[] = [];
      const control: number[] = [];
      let skipped = 0;

      for (const r of ok) {
        const mask = lowMask(r);
        // 基準はこの走行が低い丘にいた区間の平均。離脱中を混ぜると水準がずれる
        const lows: number[] = [];
        for (let i = 0; i < mask.length; i++) if (mask[i]) lows.push(r.pop[i]);
        if (lows.length === 0) continue;
        const base = lows.reduce((a, b) => a + b, 0) / lows.length;
        if (base <= 0) continue;

        // 対照: 窓が丸ごと低い丘の区間に入っているものだけ
        for (let i = 0; i + WINDOW <= mask.length; i++) {
          let allLow = true;
          for (let k = i; k < i + WINDOW; k++) if (!mask[k]) { allLow = false; break; }
          if (allLow) control.push(windowMean(r.pop, i, i + WINDOW) / base);
        }

        for (const e of es) {
          if (e.run !== r) continue;
          if (e.at < WINDOW) { skipped++; continue; }
          before.push(windowMean(r.pop, e.at - WINDOW, e.at) / base);
        }
      }

      if (before.length === 0 || control.length === 0) {
        console.log(`  ${gain}    ${label.padEnd(14)} 測れる件が無い（除外${skipped}）`);
        continue;
      }
      const pct = before.map((b) => control.filter((c) => c < b).length / control.length);
      const lo = pct.filter((x) => x < 0.25).length;
      const hi = pct.filter((x) => x > 0.75).length;
      console.log(
        `  ${gain}    ${label.padEnd(14)}${String(before.length).padStart(4)}  ` +
          `${avg(before).toFixed(3)}  ${avg(control).toFixed(3)}  ` +
          `${(avg(pct) * 100).toFixed(0).padStart(3)}%  ` +
          `${`${lo}/${before.length}`.padStart(7)}  ${`${hi}/${before.length}`.padStart(7)}`,
      );
    }
    console.log('');
  }
  console.log('  ※ 定着した脱出だけ谷が深いなら、揺らぎは離脱ではなく定着のほうを助けている');
}

// ---------------------------------------------------------------------------
header('節5: 二つの丘は集団のサイズが違うか');

/**
 * どちらの丘も局所最適なので、**個体にとっては優劣がつかない**。
 * だが集団のサイズは別で、10 の「進化は集団を小さくする」がここでも出るはず。
 * 足に頼る型は実効代謝が 0.25+0.15×2.45 = 0.618、目に頼る型は 0.367 なので、
 * 同じ草で養える頭数は速いほうが少ないと予想される。
 *
 * 終着の判定と同じ区間（最後の5000ステップ）で測る。
 */
{
  const TAILMARKS = 50; // 50マーク = 5000ステップ
  console.log('  利得  丘      走行  草食   肉食   速度');
  for (const gain of gains) {
    const ok = runs.filter((r) => r.gain === gain && r.deadAt < 0);
    const groups: [string, Run[]][] = [
      ['目型', ok.filter((r) => r.speed[r.speed.length - 1] < 1.2)],
      ['足型', ok.filter((r) => r.speed[r.speed.length - 1] >= 2.0)],
    ];
    for (const [name, g] of groups) {
      if (g.length === 0) {
        console.log(`  ${gain}    ${name}    0走行`);
        continue;
      }
      const at = (pick: (r: Run) => number[]) =>
        avg(g.map((r) => windowMean(pick(r), r.speed.length - TAILMARKS, r.speed.length)));
      console.log(
        `  ${gain}    ${name}  ${String(g.length).padStart(3)}走行  ` +
          `${at((r) => r.pop).toFixed(0).padStart(4)}  ${at((r) => r.pred).toFixed(0).padStart(4)}  ` +
          `${at((r) => r.speed).toFixed(2)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
header('節6: 離脱の閾値を振ると件数はどう変わるか');

/**
 * 1.2 は「低い丘（0.76-0.83、集団内のばらつき0.13-0.19）の帯の外側」という理由で
 * 置いた値で、それ以上の根拠は無い。結論が閾値の取り方に乗っていないかを見る。
 */
{
  console.log('  利得  閾値1.0   閾値1.2   閾値1.5   閾値2.0');
  for (const gain of gains) {
    const ok = runs.filter((r) => r.gain === gain && r.deadAt < 0);
    const counts = [1.0, 1.2, 1.5, 2.0].map(
      (th) => ok.filter((r) => departureAt(r.speed, r.deadAt, th) >= 0).length,
    );
    console.log(
      `  ${gain}    ` +
        counts.map((c) => `${String(c).padStart(2)}/${ok.length}`.padEnd(10)).join(''),
    );
  }
  console.log('  ※ 閾値2.0は「高い丘に着いた」に近いので、終着の高と一致するはず');
}

// ---------------------------------------------------------------------------
header('節7: 離脱をイベント単位で数える（往復しているか）');

/**
 * これまでの「離脱N件」は**走行あたり最初の1回**しか数えていない。
 * 10 の seed 8000 が 0.83 → 1.57 → 2.40 → 1.85 と往復したような動きは1件に潰れる。
 *
 * 上りと下りで別の閾値を使う（ヒステリシス）。同じ閾値だと境界での小さな揺れを
 * 何度も数えてしまう。
 */
{
  const UP = 1.2;
  const DOWN = 1.0;
  const ARRIVE = 2.0;

  console.log('  利得  走行  離脱イベント  うち2.0到達  戻った  走行あたり');
  for (const gain of gains) {
    const ok = runs.filter((r) => r.gain === gain && r.deadAt < 0);
    let events = 0;
    let arrived = 0;
    let returned = 0;

    for (const r of ok) {
      const end = r.deadAt < 0 ? r.speed.length : r.deadAt;
      let out = false; // いま低い丘を離れている最中か
      let hitHigh = false;
      for (let i = 0; i < end; i++) {
        if (!out && r.speed[i] >= UP) {
          out = true;
          hitHigh = false;
          events++;
        } else if (out) {
          if (r.speed[i] >= ARRIVE && !hitHigh) {
            hitHigh = true;
            arrived++;
          }
          if (r.speed[i] < DOWN) {
            out = false;
            returned++;
          }
        }
      }
    }
    console.log(
      `  ${gain}   ${String(ok.length).padStart(3)}  ${String(events).padStart(8)}  ` +
        `${String(arrived).padStart(11)}  ${String(returned).padStart(6)}  ` +
        `${(events / ok.length).toFixed(2).padStart(8)}`,
    );
  }
  console.log('  ※ 戻った回数が多いなら、離脱は脱出ではなく往復の一部でしかない');
}

await done(t0);
