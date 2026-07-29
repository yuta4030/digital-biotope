import { runMany, closePool, poolSize, type Job } from '../../../src/sweep/pool.ts';
import type { RunResult } from '../../../src/sweep/run.ts';
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
