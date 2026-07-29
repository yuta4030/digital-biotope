import { runOne, type RunResult } from '../../../src/sweep/sweep.ts';
import { runJobs, type Job } from '../../../src/sweep/pool.ts';
import type { WorldConfig } from '../../../src/core/types.ts';

/** レポートの既定。特に断りがなければこの条件で測っている */
export const SEEDS = [1000, 2000, 3000, 4000, 5000];
export const STEPS = 8000;
export const TAIL = 4000;

export interface Trial {
  survived: number;
  total: number;
  species: { name: string; mean: number; min: number; max: number }[];
  /** 崩壊した試行の絶滅ステップ */
  extinctAt: number[];
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
 * 直列で回すので、視野を使う実験では group()（並列）の方を使う。
 */
export function trial(build: () => WorldConfig, opts: RunOpts = {}): Trial {
  const seeds = opts.seeds ?? SEEDS;
  const steps = opts.steps ?? STEPS;
  const tail = opts.tail ?? TAIL;

  const rs = seeds.map((seed) => {
    const cfg = build();
    cfg.seed = seed;
    return runOne(cfg, steps, tail);
  });

  return summarize(seeds.length, rs);
}

function summarize(total: number, rs: RunResult[]): Trial {
  return {
    survived: rs.filter((r) => r.survived).length,
    total,
    extinctAt: rs.filter((r) => !r.survived).map((r) => r.extinctAt),
    species: rs[0].species.map((s, i) => ({
      name: s.name,
      mean: rs.reduce((a, r) => a + r.species[i].mean, 0) / total,
      min: Math.min(...rs.map((r) => r.species[i].min)),
      max: Math.max(...rs.map((r) => r.species[i].max)),
    })),
  };
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
  const results = await runJobs(jobs, {
    onProgress: tty
      ? (d, t) => process.stdout.write(`\r  ${d}/${t} ...`)
      : undefined,
  });
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

/** 実行時間を表示して終える */
export function done(t0: number): void {
  console.log(`\n所要 ${((performance.now() - t0) / 1000).toFixed(0)}秒`);
}
