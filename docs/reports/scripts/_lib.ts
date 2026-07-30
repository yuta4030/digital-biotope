import {
  runMany,
  invadeMany,
  closePool,
  poolSize,
  type Job,
  type InvasionJob,
} from '../../../src/sweep/pool.ts';
import type { RunResult, InvasionOptions, InvasionResult } from '../../../src/sweep/run.ts';
import type { WorldConfig } from '../../../src/core/types.ts';

/** レポートの既定。特に断りがなければこの条件で測っている */
export const SEEDS = [1000, 2000, 3000, 4000, 5000];
export const STEPS = 8000;
export const TAIL = 4000;

export interface Trial {
  survived: number;
  total: number;
  species: {
    name: string;
    mean: number;
    min: number;
    max: number;
    /** 個体数の標準偏差（各試行の値を平均したもの）。揺らぎの大きさを測る側 */
    sd: number;
    /**
     * 速度を測れた試行だけで平均した移動速度。速度が遺伝しない種では定義値。
     * 絶滅した試行は除いてある。混ぜると初期速度に引き寄せられた偽の数字になる
     */
    speed: number;
    /** 集団内のばらつき（各試行の標準偏差を平均したもの） */
    speedSd: number;
    /** 速度を測れた試行の到達速度。収束したのか散らばったのかを見るため */
    speedBySeed: number[];
  }[];
  /** 崩壊した試行の絶滅ステップ */
  extinctAt: number[];
  /** セルあたりの草の平均残量 */
  grassMean: number;
  /** 1ステップに実際に加わった草の量。上限で捨てたぶんは含まれない */
  grassProduced: number;
  /** 1ステップに死骸から草へ戻った量 */
  corpseInput: number;
}

export interface RunOpts {
  seeds?: number[];
  steps?: number;
  tail?: number;
}

/**
 * 同じ条件をシードだけ変えて複数回走らせ、まとめる。
 * まぐれで生き残った条件を弾くため、1回では判断しない。
 *
 * シードごとの run は互いに独立なのでスレッドに分けて回す。
 * 結果は直列で回したときと完全に一致する（乱数はシードから引き直すため）。
 *
 * 条件を何本も並べるなら trials() / group() のほうがスレッドを埋めやすい。
 */
export async function trial(build: () => WorldConfig, opts: RunOpts = {}): Promise<Trial> {
  const seeds = opts.seeds ?? SEEDS;
  const steps = opts.steps ?? STEPS;
  const tail = opts.tail ?? TAIL;

  const rs = await runMany(
    seeds.map((seed) => {
      const cfg = build();
      cfg.seed = seed;
      return { config: cfg, steps, tail };
    }),
  );

  return summarize(seeds.length, rs);
}

function summarize(total: number, rs: RunResult[]): Trial {
  return {
    survived: rs.filter((r) => r.survived).length,
    total,
    extinctAt: rs.filter((r) => !r.survived).map((r) => r.extinctAt),
    grassMean: rs.reduce((a, r) => a + r.grassMean, 0) / total,
    grassProduced: rs.reduce((a, r) => a + r.grassProduced, 0) / total,
    corpseInput: rs.reduce((a, r) => a + r.corpseInput, 0) / total,
    species: rs[0].species.map((s, i) => {
      // 絶滅した試行の速度は測定値ではなく定義値なので、平均から外す
      const measured = rs.map((r) => r.species[i]).filter((x) => x.speedSamples > 0);
      const speeds = measured.map((x) => x.speedMean);
      return {
        name: s.name,
        mean: rs.reduce((a, r) => a + r.species[i].mean, 0) / total,
        min: Math.min(...rs.map((r) => r.species[i].min)),
        max: Math.max(...rs.map((r) => r.species[i].max)),
        sd: rs.reduce((a, r) => a + r.species[i].sd, 0) / total,
        speed: speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : NaN,
        speedSd:
          measured.length > 0
            ? measured.reduce((a, x) => a + x.speedSd, 0) / measured.length
            : NaN,
        speedBySeed: speeds,
      };
    }),
  };
}

/**
 * 進化した速度を「平均 (最小-最大)」で出す。シード間のばらつきを隠さないため。
 * 一度も測れなかった場合は数字を出さない
 */
export function speedOf(t: Trial, speciesIdx = 0): string {
  const s = t.species[speciesIdx];
  if (s.speedBySeed.length === 0) return '— (測定なし)';
  const lo = Math.min(...s.speedBySeed);
  const hi = Math.max(...s.speedBySeed);
  return `${s.speed.toFixed(2)} (${lo.toFixed(2)}-${hi.toFixed(2)})`;
}

/**
 * 複数条件をまとめて並列に回す。
 *
 * 条件×シードの全通りを1つのプールに流すので、条件が2つでもシードが5個でも
 * コアが埋まる。1条件ずつ並列化すると 5シード / 4コア のような端数で待ちが出る。
 *
 * 結果は投入順に返る。中身は trial() を条件ごとに呼んだ場合と完全に一致する。
 */
export async function trials(builds: (() => WorldConfig)[], opts: RunOpts = {}): Promise<Trial[]> {
  const seeds = opts.seeds ?? SEEDS;
  const steps = opts.steps ?? STEPS;
  const tail = opts.tail ?? TAIL;

  const jobs: Job[] = [];
  for (const build of builds) {
    for (const seed of seeds) {
      const cfg = build();
      cfg.seed = seed;
      jobs.push({ config: cfg, steps, tail });
    }
  }

  // 進捗は端末のときだけ。ファイルに落とすと \r が効かず1行ずつ溜まる
  const tty = process.stdout.isTTY;
  const results = await runMany(
    jobs,
    tty ? (d) => process.stdout.write(`\r  ${d}/${jobs.length} ...`) : undefined,
  );
  if (tty) process.stdout.write('\r'.padEnd(20) + '\r');

  return builds.map((_, i) =>
    summarize(seeds.length, results.slice(i * seeds.length, (i + 1) * seeds.length)),
  );
}

/**
 * 条件の並びを並列に回して、返ってきた順に表示する。
 *
 * レポートは「条件を変えながら1行ずつ出す」形ばかりなので、
 * その形のまま並列にできるようにこの形にしてある。表示は逐次ではなく
 * 全部終わってから出るが、順序は items のとおり。
 */
export async function group<T>(
  items: readonly T[],
  build: (item: T) => WorldConfig,
  render: (item: T, t: Trial) => void,
  opts: RunOpts = {},
): Promise<void> {
  const ts = await trials(
    items.map((it) => () => build(it)),
    opts,
  );
  items.forEach((it, i) => render(it, ts[i]));
}

// --- 侵入の実験（レポート12） ---

export interface Invasion {
  /** 崩壊せずに測り切った走行の数と、崩壊した走行の数 */
  runs: number;
  collapsed: number;
  /** 崩壊しなかった走行で試した投入の数と、その結末の内訳 */
  attempts: number;
  established: number;
  lost: number;
  /**
   * 定着も絶滅もしないまま打ち切った回数。
   * これが無視できない数なら閾値か打ち切りが短すぎるので、rate は読めない
   */
  timeout: number;
  /** 定着率。分母に timeout を含めない（判定できなかったものを失敗に化けさせないため） */
  rate: number;
  /** 走行ごとの定着率。平均は割れている集団を1つの数字に潰すので、範囲も出す */
  rateBySeed: number[];
  /** 在来個体数。揺らぎの大きさを測る側 */
  resident: { name: string; mean: number; sd: number; cv: number; min: number; max: number }[];
  /**
   * 崩壊しなかった走行の全投入。ビン分けに使う。
   *
   * 投入時の値は**その走行の平均に対する比**に直してある。走行やシードで平均が
   * 違うので、生の個体数で束ねると平均の違いをビンの違いとして読むことになる。
   */
  all: {
    /** 種インデックス別の個体数の比。侵入者の位置は常に0 */
    ratio: number[];
    /** 草の総量の比 */
    grassRatio: number;
    established: boolean;
  }[];
  /**
   * 段Bの追跡のまとめ。followUp > 0 のときだけ中身が入る。
   *
   * **閾値到達は「定着」ではなく「30体に達した」でしかない。**
   * そこから居座るのか消えるのか、在来を置き換えるのかを分けて数える。
   */
  follow: {
    /** 追跡した系統の数（= 定着に到達した走行の数） */
    n: number;
    survived: number;
    lost: number;
    replaced: number;
    /** 刻みごとに、まだ侵入者が生きている系統の割合 */
    alive: { offset: number; frac: number; n: number }[];
  };
}

/**
 * 侵入の実験を1条件ぶん回してまとめる。
 *
 * **崩壊した走行は丸ごと外す。** 崩壊すると在来の個体数分布そのものが変わるので、
 * その世界の定着率は測りたかったものではない。09 で「崩壊したから変動係数が高い」を
 * 「変動係数が高いから崩壊した」と読んだのと同じ形の罠になる。
 * 崩壊前の投入も一緒に捨てている（何回目で崩壊したかに依存する数を混ぜないため）。
 */
export async function invade(
  build: () => WorldConfig,
  opts: InvasionOptions & { seeds?: number[] },
): Promise<Invasion> {
  const seeds = opts.seeds ?? SEEDS;
  const { followUp, followEvery } = opts;
  const jobs: InvasionJob[] = seeds.map((seed) => {
    const cfg = build();
    cfg.seed = seed;
    return { kind: 'invasion', config: cfg, ...opts };
  });

  const tty = process.stdout.isTTY;
  const rs = await invadeMany(
    jobs,
    tty ? (d) => process.stdout.write(`\r  ${d}/${jobs.length} ...`) : undefined,
  );
  if (tty) process.stdout.write('\r'.padEnd(20) + '\r');

  return summarizeInvasion(rs, followUp, followEvery);
}

function summarizeInvasion(
  rs: InvasionResult[],
  followUp: number,
  followEvery: number,
): Invasion {
  const ok = rs.filter((r) => r.collapsedAt < 0);
  const n = ok.length;

  let attempts = 0;
  let established = 0;
  let lost = 0;
  let timeout = 0;
  const rateBySeed: number[] = [];
  const all: Invasion['all'] = [];

  for (const r of ok) {
    let e = 0;
    let l = 0;
    for (const a of r.attempts) {
      attempts++;
      if (a.outcome === 'established') e++;
      else if (a.outcome === 'lost') l++;
      else {
        timeout++;
        continue;
      }
      all.push({
        ratio: a.resident.map((c, i) => {
          const mean = r.resident[i].mean;
          return mean > 0 ? c / mean : 0;
        }),
        grassRatio: r.grassMean > 0 ? a.grass / r.grassMean : 0,
        established: a.outcome === 'established',
      });
    }
    established += e;
    lost += l;
    if (e + l > 0) rateBySeed.push(e / (e + l));
  }

  return {
    runs: n,
    collapsed: rs.length - n,
    attempts,
    established,
    lost,
    timeout,
    rate: established + lost > 0 ? established / (established + lost) : NaN,
    rateBySeed,
    resident:
      n > 0
        ? ok[0].resident.map((s, i) => {
            const mean = ok.reduce((a, r) => a + r.resident[i].mean, 0) / n;
            const sd = ok.reduce((a, r) => a + r.resident[i].sd, 0) / n;
            return {
              name: s.name,
              mean,
              sd,
              cv: mean > 0 ? sd / mean : 0,
              min: Math.min(...ok.map((r) => r.resident[i].min)),
              max: Math.max(...ok.map((r) => r.resident[i].max)),
            };
          })
        : [],
    all,
    follow: summarizeFollow(ok, followUp, followEvery),
  };
}

/**
 * 段Bの追跡をまとめる。
 *
 * 生存の判定は end と追跡長から出す。マークの有無で数えてはいけない：
 * 置き換え（replaced）で終わった系統はそこで記録が止まるが、**侵入者は生きている**。
 * マークが無いことを消えたことと読むと、いちばん成功した系統を失敗に数える。
 *
 * 刻みは設定から作る。実際に付いたマークから作ると、全系統が最初の刻みより前に
 * 消えた条件で曲線が空になり、「消えた」ではなく「測っていない」に見える。
 */
function summarizeFollow(
  ok: InvasionResult[],
  followUp: number,
  followEvery: number,
): Invasion['follow'] {
  const fs = ok.map((r) => r.follow).filter((f): f is NonNullable<typeof f> => f !== undefined);
  const offsets: number[] = [];
  for (let o = followEvery; o <= followUp; o += followEvery) offsets.push(o);

  return {
    n: fs.length,
    survived: fs.filter((f) => f.end === 'survived').length,
    lost: fs.filter((f) => f.end === 'lost').length,
    replaced: fs.filter((f) => f.end === 'replaced').length,
    alive: offsets.map((offset) => {
      const alive = fs.filter((f) => !(f.end === 'lost' && offset >= f.followed)).length;
      return { offset, frac: fs.length > 0 ? alive / fs.length : 0, n: fs.length };
    }),
  };
}

export function followLine(label: string, v: Invasion): void {
  const f = v.follow;
  if (f.n === 0) {
    console.log(`  ${label.padEnd(22)} 追跡なし`);
    return;
  }
  const pct = (x: number) => `${((x / f.n) * 100).toFixed(0)}%`;
  console.log(
    `  ${label.padEnd(22)} ${String(f.n).padStart(3)}系統  ` +
      `居座り ${pct(f.survived).padStart(4)}  ` +
      `置換 ${pct(f.replaced).padStart(4)}  ` +
      `消滅 ${pct(f.lost).padStart(4)}`,
  );
}

/**
 * 追跡の刻みごとに、まだ生きている系統の割合。
 * 見せる刻みを絞れるようにしてある（消えるのは最初の数百ステップに集中するので、
 * そこだけ細かく、あとは粗く並べたい）
 */
export function followCurve(label: string, v: Invasion, show?: number[]): void {
  const pick = show
    ? show.map((o) => v.follow.alive.find((a) => a.offset === o)).filter((a) => a !== undefined)
    : v.follow.alive;
  const cells = pick
    .map((a) => `+${a!.offset}: ${Math.round(a!.frac * 100).toString().padStart(3)}%`)
    .join('  ');
  console.log(`  ${label.padEnd(22)} ${cells}`);
}

/**
 * 2つの軸でクロス集計する。片方を固定したときにもう片方が効くかを見る。
 *
 * 在来個体数と1個体あたりの草は、草の総量がほぼ一定なので実質同じ量になる
 * （草/頭 ≒ 定数 ÷ 在来）。同じ数字を逆さにして2回測っても切り分けにならないので、
 * 在来のビンを固定した中で草の総量が効くかを見る。
 */
export function crossTab(
  v: Invasion,
  rowLabel: string,
  rowSel: (a: Invasion['all'][number]) => number,
  rowEdges: number[],
  colSel: (a: Invasion['all'][number]) => number,
  colEdges: number[],
): void {
  const idx = (x: number, edges: number[]) => {
    let b = 0;
    while (b < edges.length - 1 && x >= edges[b + 1]) b++;
    return b;
  };
  const grid = rowEdges.map(() => colEdges.map(() => ({ n: 0, e: 0 })));
  for (const a of v.all) {
    const cell = grid[idx(rowSel(a), rowEdges)][idx(colSel(a), colEdges)];
    cell.n++;
    if (a.established) cell.e++;
  }

  const head = colEdges
    .map((lo, j) => `${lo.toFixed(2)}〜${j < colEdges.length - 1 ? colEdges[j + 1].toFixed(2) : '∞'}`)
    .map((s) => s.padStart(12))
    .join('');
  console.log(`  ${rowLabel.padEnd(12)}${head}`);
  grid.forEach((row, i) => {
    const lo = rowEdges[i].toFixed(2);
    const hi = i < rowEdges.length - 1 ? rowEdges[i + 1].toFixed(2) : '∞';
    const cells = row
      .map((c) => (c.n > 0 ? `${((c.e / c.n) * 100).toFixed(0)}% ${c.e}/${c.n}` : '—'))
      .map((s) => s.padStart(12))
      .join('');
    console.log(`  ${`${lo}〜${hi}`.padEnd(12)}${cells}`);
  });
}

/** 定着率を「% (走行ごとの範囲)」で出す。平均だけだと割れている集団を潰す */
export function rateOf(v: Invasion): string {
  if (!Number.isFinite(v.rate)) return '— (判定なし)';
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const lo = Math.min(...v.rateBySeed);
  const hi = Math.max(...v.rateBySeed);
  return `${pct(v.rate).padStart(4)} (${pct(lo)}-${pct(hi)})`;
}

export function invasionLine(label: string, v: Invasion): void {
  const warn = v.timeout > 0 ? ` 打切${v.timeout}` : '';
  const col = v.collapsed > 0 ? ` 崩壊${v.collapsed}` : '';
  console.log(
    `  ${label.padEnd(22)} ${rateOf(v)}  ${String(v.established).padStart(3)}/${String(
      v.established + v.lost,
    ).padEnd(4)}${warn}${col}`,
  );
}

/**
 * 投入時の状態で定着率をビン分けする。selector が比を返す。
 *
 * 「谷に落ちた瞬間なら食い込める」を直接見るための集計。ただし在来が谷にいる時期は
 * 同時に「1個体あたりの草が多い」時期でもあり、捕食者の位相もずれている。
 * どの量で束ねても同じ形が出るなら、在来個体数はただの代弁者ということになる。
 * だから軸を選べる形にしてある。
 */
export function byBin(
  v: Invasion,
  label: string,
  selector: (a: Invasion['all'][number]) => number,
  edges: number[],
): void {
  const bins = edges.map(() => ({ n: 0, e: 0 }));
  for (const a of v.all) {
    const x = selector(a);
    let b = 0;
    while (b < edges.length - 1 && x >= edges[b + 1]) b++;
    bins[b].n++;
    if (a.established) bins[b].e++;
  }
  bins.forEach((b, i) => {
    const hi = i < edges.length - 1 ? edges[i + 1].toFixed(2) : '∞';
    const rate = b.n > 0 ? `${((b.e / b.n) * 100).toFixed(0)}%` : '—';
    console.log(
      `  ${label} ${edges[i].toFixed(2)}〜${hi.padEnd(4)} ${rate.padStart(4)}  ` +
        `${String(b.e).padStart(3)}/${b.n}`,
    );
  });
}

/** 投入時の在来個体数でビン分けする。speciesIdx は在来種の位置 */
export function byResidentBin(v: Invasion, edges: number[], speciesIdx = 0): void {
  byBin(v, '在来', (a) => a.ratio[speciesIdx], edges);
}

/** 生存の記号。全部生き残ったら OK、全滅なら --、まだらなら △ */
export function mark(t: Trial): string {
  if (t.survived === t.total) return 'OK';
  if (t.survived === 0) return '--';
  return ' △';
}

export function fmt(t: Trial, opts: { range?: boolean } = {}): string {
  return t.species
    .map((s) => {
      const head = `${s.name} ${s.mean.toFixed(0).padStart(4)}`;
      return opts.range === false
        ? head
        : `${head}(${String(s.min).padStart(3)}-${String(s.max).padStart(4)})`;
    })
    .join('  ');
}

export function line(label: string, t: Trial, opts: { range?: boolean } = {}): void {
  console.log(
    `  ${label.padEnd(26)} ${mark(t)}${t.survived}/${t.total}  ${fmt(t, opts)}`,
  );
}

export function header(title: string): void {
  console.log(`\n=== ${title} ===`);
}

/** 実行時間を表示して終える。ワーカーを畳まないとプロセスが終了しない */
export async function done(t0: number): Promise<void> {
  await closePool();
  console.log(`\n所要 ${((performance.now() - t0) / 1000).toFixed(0)}秒`);
}

/** 冒頭に出す。何スレッドで回っているか分からないと所要時間を比べられない */
export function banner(): void {
  const n = poolSize();
  console.log(n > 1 ? `${n}スレッドで実行` : '直列で実行');
}
