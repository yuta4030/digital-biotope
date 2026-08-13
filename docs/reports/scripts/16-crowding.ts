/**
 * 16. 頻度依存は共存を作るか（段1・手書きの密度依存）
 *
 * 15 で「均等に減らすだけでは共存しない」ことを潰した。
 * ここは対偶側で、**増えた側ほど叩く**と共存が生まれるのかを見る。
 *
 * 本命は接触で伝わる感染だが、実装してから効かなかったときに
 * 「機構が効かない」のか「実装を間違えた」のかを区別できない。
 * 先に頻度依存を手で書いて、効くかどうかだけ確かめておく。
 * **この軸自体は機構の主張ではない**（答えを直接書いている）。
 *
 * 対照の作り方が肝。`scope: 'all'` は関数形も強さのつまみも self と同一で、
 * **誰の密度を数えるかだけ**が違う。15 の大量死と比べるより厳密な対照になる。
 *
 * 予想: self なら共存する。ただし効き始めが間に合わない可能性がある。
 * 15 で見たとおり排除は600歩前後で終わるが、両種とも300体から始まるので
 * **開始時点では self でも密度が同じ＝差がつかない**。差が出るのはAが増えてから。
 *
 * 所要: 4スレッドで節1〜4が約2分、節5が約4分
 * 実行: node docs/reports/scripts/16-crowding.ts
 */
import type { WorldConfig } from '../../../src/core/types.ts';
import { presets } from '../../../src/core/presets.ts';
import { banner, done, header, line, trials, mark, fmt, type Trial } from './_lib.ts';

const SEEDS8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
const STEPS = 8000;
const TAIL = 4000;
const LONG = 30000;

const keystone = () => presets.find((p) => p.key === 'keystone')!.build();

/** 15 と同じ。個体数0の種は絶滅として数えられるので、肉食は配列ごと外す */
function noPredator(): WorldConfig {
  const cfg = keystone();
  cfg.species = cfg.species.filter((s) => s.id !== 3);
  return cfg;
}

/** 草食2種の両方に同じ密度依存を与える。効き方の差は密度の差だけから出る */
function withCrowding(rate: number, scope: 'self' | 'all'): WorldConfig {
  const cfg = noPredator();
  cfg.species = cfg.species.map((s) => ({ ...s, crowding: { rate, scope } }));
  return cfg;
}

function extinctSummary(extinctAt: number[], total: number): string {
  if (extinctAt.length === 0) return '絶滅なし';
  const xs = [...extinctAt].sort((a, b) => a - b);
  return `絶滅 ${extinctAt.length}/${total}  中央 ${xs[Math.floor(xs.length / 2)]}  (${xs[0]}-${xs[xs.length - 1]})`;
}

/**
 * 1ステップあたり密度依存の死で取り除いた数。self と all でこれが揃っていて
 * 初めて「誰の密度を見るかだけを変えた」と言える。揃っていなければ
 * 15 で潰したはずの「取り除いた量の差」を見ていることになる
 */
function crowdedLine(t: Trial): string {
  const each = t.species.map((s) => `${s.name.slice(0, 4)} ${s.crowded.toFixed(2)}`).join('  ');
  const total = t.species.reduce((a, s) => a + s.crowded, 0);
  return `除去/歩 計 ${total.toFixed(2)}  (${each})`;
}

async function main(): Promise<void> {
  const t0 = performance.now();
  banner();

  // --- 節1. 回帰の確認 ---
  header('1. 回帰の確認（この機構を入れる前と一致するか）');
  console.log('  crowding を書かない構成は乱数を1つも消費しないはず。');
  console.log('  15 の節1と**同じ数字**が出なければ、以降の比較は全部無効。\n');
  console.log('  期待値（15の実測）:');
  console.log('    肉食あり   OK 8/8  A 574(210-1064) B 505(123-896) 肉食 121(8-346)');
  console.log('    肉食なし   -- 0/8  A 1298(1231-1374) B 0(0-0)  絶滅中央 643\n');

  const [base, noPred] = await trials([keystone, noPredator], {
    seeds: SEEDS8, steps: STEPS, tail: TAIL,
  });
  line('肉食あり（既定）', base);
  line('肉食なし', noPred);
  console.log(`  ${''.padEnd(26)} ${extinctSummary(noPred.extinctAt, SEEDS8.length)}`);

  // --- 節2. self（頻度依存） ---
  header('2. self — 自種の密度だけを数える');
  console.log('  A(1298) は B(300) の4倍の密度なので、同じ rate でもAが強く叩かれる。');
  console.log('  これが kill-the-winner の中身。\n');

  const rates = [0.02, 0.05, 0.1, 0.2, 0.5, 1.0];
  const selfTrials = await trials(
    rates.map((r) => () => withCrowding(r, 'self')),
    { seeds: SEEDS8, steps: STEPS, tail: TAIL },
  );
  rates.forEach((r, i) => {
    const t = selfTrials[i];
    line(`self rate=${r}`, t);
    console.log(`  ${''.padEnd(26)} ${extinctSummary(t.extinctAt, SEEDS8.length)}`);
    console.log(`  ${''.padEnd(26)} ${crowdedLine(t)}`);
  });

  // --- 節3. all（対照） ---
  header('3. all — 全種の合計密度を数える（対照）');
  console.log('  関数形も rate も self と同じで、見る密度だけが違う。');
  console.log('  ここで共存したら、効いているのは頻度依存ではなく「数を減らしたこと」。\n');

  const allTrials = await trials(
    rates.map((r) => () => withCrowding(r, 'all')),
    { seeds: SEEDS8, steps: STEPS, tail: TAIL },
  );
  rates.forEach((r, i) => {
    const t = allTrials[i];
    line(`all  rate=${r}`, t);
    console.log(`  ${''.padEnd(26)} ${extinctSummary(t.extinctAt, SEEDS8.length)}`);
    console.log(`  ${''.padEnd(26)} ${crowdedLine(t)}`);
  });

  // --- 節4. 除去量の突き合わせ ---
  header('4. self と all で取り除いた量が揃っているか');
  console.log('  同じ rate でも all のほうが多く取り除く（合計密度で数えるため）。');
  console.log('  self が共存して all が共存しないとき、それが「頻度依存だから」と');
  console.log('  言えるのは、**all のほうが多く取り除いている**場合に限る。');
  console.log('  少なく取り除いて失敗しているなら、ただの強さ不足かもしれない。\n');
  rates.forEach((r, i) => {
    const s = selfTrials[i].species.reduce((a, x) => a + x.crowded, 0);
    const a = allTrials[i].species.reduce((a2, x) => a2 + x.crowded, 0);
    const ratio = s > 0 ? (a / s).toFixed(2) : '—';
    console.log(
      `  rate=${String(r).padEnd(5)} self ${s.toFixed(2).padStart(6)}  ` +
        `all ${a.toFixed(2).padStart(6)}  all/self ${ratio}`,
    );
  });

  // --- 節5. 長い走行 ---
  header(`5. ${LONG}ステップで確かめる`);
  console.log('  8000歩でBが残っていても、排除が遅いだけかもしれない。');
  console.log('  14 の逆向きの罠。長く回さないと「止まった」と「遅い」は分けられない。\n');

  const longConds = [
    { label: '肉食あり（既定）', build: keystone },
    { label: 'crowding なし', build: noPredator },
    ...rates.map((r) => ({ label: `self rate=${r}`, build: () => withCrowding(r, 'self') })),
    ...rates.map((r) => ({ label: `all  rate=${r}`, build: () => withCrowding(r, 'all') })),
  ];
  const longTrials = await trials(
    longConds.map((c) => c.build),
    { seeds: SEEDS8, steps: LONG, tail: TAIL },
  );
  longConds.forEach((c, i) => {
    const t = longTrials[i];
    console.log(`  ${c.label.padEnd(20)} ${mark(t)}${t.survived}/${t.total}  ${fmt(t)}`);
    console.log(`  ${''.padEnd(20)} ${extinctSummary(t.extinctAt, SEEDS8.length)}`);
  });

  console.log('\n  読み方: self だけが 8/8 で生き残り、all が 0/8 なら頻度依存が効いている。');
  console.log('  両方生き残るなら、効いているのは数を減らしたこと（15 と矛盾するので要調査）。');
  console.log('  両方絶滅するなら、rate の範囲が足りないか、効き始めが間に合っていない。');

  await done(t0);
}

main();
