/**
 * 15. 均等な死は共存を作るか
 *
 * kill-the-winner を入れる前の対照。競合構成の共存は「肉食がAだけを叩く」という
 * **非対称な死**で成り立っている（肉食を消すと A 1298 / B 0）。
 * では**均等に減らす**だけでBは生き残るのか。
 *
 * ここが効いてしまうなら、頻度依存を実装しても「数を減らしただけ」と
 * 区別がつかなくなる。先に潰しておく。
 *
 * 予想: 生き残らない。均等な死はAとBの相対的な有利さを変えないので、
 * 排除の速度が落ちるだけで向きは変わらない。
 *
 * ただし 14 で「形質を見ていないのだから丘は動かないはず」を外しているので、
 * 理屈で済ませない。12・13 で見た非選択的な窓（谷では不利な側も通る）が
 * ここでも効くなら、Bが偶然生き延びる回が出る可能性はある。
 *
 * 所要: 4スレッドで節1〜3が約1分、節4が約4分
 * 実行: node docs/reports/scripts/15-frequency-dependence.ts
 */
import type { WorldConfig } from '../../../src/core/types.ts';
import { presets } from '../../../src/core/presets.ts';
import { banner, done, group, header, line, trials, mark, fmt, type Trial } from './_lib.ts';

// 14 と同じ 8シード。8000ステップ / 後半4000ステップも 02・14 に揃える
const SEEDS8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
const STEPS = 8000;
const TAIL = 4000;

/** 排除が「止まった」のか「遅くなっただけ」なのかを分けるための長い走行 */
const LONG = 30000;
const LONG_TAIL = 4000;

const keystone = () => presets.find((p) => p.key === 'keystone')!.build();

/**
 * 肉食を**配列ごと外す**。initialCount を0にする手もあるが、run.ts は
 * 個体数0の種を絶滅として数えるので survived が常に false になり、
 * 「Bが生き残ったか」を読めなくなる。
 *
 * 初期配置は種ごとに initialCount 個ぶんしか乱数を引かないので、
 * 0体の種を配列に残しても外しても乱数列は変わらない。節1で確かめる。
 */
function noPredator(): WorldConfig {
  const cfg = keystone();
  cfg.species = cfg.species.filter((s) => s.id !== 3);
  return cfg;
}

function zeroPredator(): WorldConfig {
  const cfg = keystone();
  cfg.species = cfg.species.map((s) => (s.id === 3 ? { ...s, initialCount: 0 } : s));
  return cfg;
}

/**
 * 均等な大量死を足す。対象を指定しない＝生きている全種を同じ確率で叩く。
 *
 * 比較は `fraction / interval`（1ステップあたりに取り除く割合）を揃えた組の間で行う。
 * 揃えないと平均個体数まで動いて、06 の豊穣化を逆向きにやったのと区別がつかない。
 */
function withDeath(interval: number, fraction: number): WorldConfig {
  const cfg = noPredator();
  cfg.disturbance = { interval, fraction };
  return cfg;
}

/**
 * 1ステップあたり大量死で取り除いた数。設計値どおりに削れているかの確認用。
 *
 * これを出さないと「大量死が効かなかった」と「大量死が起きていなかった」が
 * 区別できない。14 自身が「設計上の割合と実現値がずれていないかを毎回確かめること」と
 * 書いているのに、最初はこれを出し忘れていた。
 *
 * 統計は後半ぶんだけなので、Bが早々に絶滅する条件では **Aを削っている量しか
 * 見えない**。それでも「大量死が起きている」の確認にはなる。
 */
function killedLine(t: Trial): string {
  const each = t.species.map((s) => `${s.name.slice(0, 4)} ${s.killed.toFixed(2)}`).join('  ');
  const total = t.species.reduce((a, s) => a + s.killed, 0);
  return `除去/歩 計 ${total.toFixed(2)}  (${each})`;
}

/** 絶滅の早さ。「共存した」と「排除が遅い」を分けるので中央値まで出す */
function extinctSummary(extinctAt: number[], total: number): string {
  if (extinctAt.length === 0) return '絶滅なし';
  const xs = [...extinctAt].sort((a, b) => a - b);
  const mid = xs[Math.floor(xs.length / 2)];
  return `絶滅 ${extinctAt.length}/${total}  中央 ${mid}  (${xs[0]}-${xs[xs.length - 1]})`;
}

async function main(): Promise<void> {
  const t0 = performance.now();
  banner();

  // --- 節1. 対照の再確認 ---
  header('1. 対照（既知の結果を出し直す）');
  console.log('  肉食ありで共存し、肉食なしでBが絶滅することを 8シードで確認する。');
  console.log('  README の 1298/0 は5シードの数字なので、ここで8シードに揃える。\n');

  const [withPred, noPred, zeroPred] = await trials(
    [keystone, noPredator, zeroPredator],
    { seeds: SEEDS8, steps: STEPS, tail: TAIL },
  );
  line('肉食あり（既定）', withPred);
  line('肉食なし（配列から外す）', noPred);
  line('肉食なし（初期0体）', zeroPred);
  console.log(`\n  ${extinctSummary(noPred.extinctAt, SEEDS8.length)}`);
  console.log('  ↑ 配列から外した場合と初期0体で A・B の数字が一致していること。');
  console.log('    ずれていたら乱数列が変わっているので、以降の比較は成り立たない。');

  // --- 節2. 均等な死・強さを振る ---
  header('2. 均等な大量死（肉食なし）— 強さを振る');
  console.log('  間隔100ステップに固定し、1回に殺す割合を上げていく。');
  console.log('  右端は1ステップあたりの除去率 fraction/interval。\n');

  const strengths = [
    { interval: 100, fraction: 0.05 },
    { interval: 100, fraction: 0.1 },
    { interval: 100, fraction: 0.2 },
    { interval: 100, fraction: 0.4 },
    { interval: 100, fraction: 0.6 },
  ];
  const strengthTrials = await trials(
    strengths.map((s) => () => withDeath(s.interval, s.fraction)),
    { seeds: SEEDS8, steps: STEPS, tail: TAIL },
  );
  strengths.forEach((s, i) => {
    const t = strengthTrials[i];
    const r = (s.fraction / s.interval).toFixed(4);
    line(`${s.interval}歩×${(s.fraction * 100).toFixed(0)}%  r=${r}`, t);
    console.log(`  ${''.padEnd(26)} ${extinctSummary(t.extinctAt, SEEDS8.length)}`);
    console.log(`  ${''.padEnd(26)} ${killedLine(t)}`);
  });

  // --- 節3. 均等な死・塊の大きさを振る ---
  header('3. 均等な大量死 — 除去率を固定して塊だけ変える');
  console.log('  r=0.002 に揃えたまま、小刻みに削るか / たまに大きく削るかを変える。');
  console.log('  14 では塊の大きさが谷の深さを決めていた。深い谷が効くならここに出る。\n');

  const chunks = [
    { interval: 25, fraction: 0.05 },
    { interval: 100, fraction: 0.2 },
    { interval: 250, fraction: 0.5 },
    { interval: 400, fraction: 0.8 },
  ];
  const chunkTrials = await trials(
    chunks.map((c) => () => withDeath(c.interval, c.fraction)),
    { seeds: SEEDS8, steps: STEPS, tail: TAIL },
  );
  chunks.forEach((c, i) => {
    const t = chunkTrials[i];
    line(`${c.interval}歩×${(c.fraction * 100).toFixed(0)}%`, t);
    console.log(`  ${''.padEnd(26)} ${extinctSummary(t.extinctAt, SEEDS8.length)}`);
    console.log(`  ${''.padEnd(26)} ${killedLine(t)}`);
  });

  // --- 節4. 長い走行 ---
  header(`4. ${LONG}ステップで確かめる`);
  console.log('  14 の教訓: 短い走行の生存率で「この条件は安全」と判断しない。');
  console.log('  ここでの罠は逆向きで、8000歩ではまだBが残っているだけかもしれない。');
  console.log('  排除が止まったのか遅くなっただけなのかは、長く回さないと分からない。\n');

  const longConds: { label: string; build: () => WorldConfig }[] = [
    { label: '肉食あり（既定）', build: keystone },
    { label: '大量死なし', build: noPredator },
    { label: '100歩×20%', build: () => withDeath(100, 0.2) },
    { label: '100歩×40%', build: () => withDeath(100, 0.4) },
    { label: '250歩×50%', build: () => withDeath(250, 0.5) },
    { label: '400歩×80%', build: () => withDeath(400, 0.8) },
  ];
  await group(
    longConds,
    (c) => c.build(),
    (c, t) => {
      console.log(
        `  ${c.label.padEnd(20)} ${mark(t)}${t.survived}/${t.total}  ${fmt(t)}`,
      );
      console.log(`  ${''.padEnd(20)} ${extinctSummary(t.extinctAt, SEEDS8.length)}`);
      console.log(`  ${''.padEnd(20)} ${killedLine(t)}`);
    },
    { seeds: SEEDS8, steps: LONG, tail: LONG_TAIL },
  );

  console.log('\n  読み方: 大量死ありの絶滅ステップが「大量死なし」より後ろへ動くだけなら、');
  console.log('  均等な死は排除を遅くしているだけで、共存を作ってはいない。');

  await done(t0);
}

main();
