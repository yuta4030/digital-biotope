/**
 * 18. 伝染の閾値は密度で決まるのか
 *
 * [17](../17-infection.md) は共存を作れたが、伝染確率 0.8〜1.0 を要求した。
 * 「同じセルの感染者に接触したら8割移る」は病気として強すぎる。
 *
 * 見立ては**遭遇が足りない**こと。密度 0.12個体/セルでは同種との同セル遭遇が
 * 1歩あたり数%しかないので、1回あたりの確実さで埋めるしかない。
 * [09](../09-detritus-buffer.md) の「手が届く範囲」と同じ形なら、
 * 密度を上げれば弱い病原体で足りるはず。
 *
 * 平衡個体数が `回復速度 × セル数 ÷ 実効代謝` なので、密度は
 *
 *     密度 = 回復速度 ÷ 実効代謝
 *
 * になる。**セル数が消える**ので、盤面の広さでは密度は動かない。
 *
 * 動かすのは**回復速度のほう**。代謝は A(0.5) と B(0.62) の差がそのまま
 * A が勝つ理由なので、下げると密度と競争の非対称性が同時に動く。
 * 09 の在庫（放出率）でやった失敗と同じ形になる。
 *
 * 予想: 遭遇率は密度に比例するので **閾値 × 密度 ≒ 一定**。
 * 密度を4倍にすれば閾値は 0.8 → 0.2 あたりまで落ちる。
 *
 * 潰す対照: 回復速度を上げただけで共存してしまわないか。餌が増えれば競争が
 * 緩んで B が助かるという筋がありうる。ニッチ軸が1本なので理屈では助からないが、
 * 06 で豊穣化を読み違えているので各密度で**感染なし**の行を並べる。
 *
 * 所要: 4スレッドで10分前後（密度を上げると個体数が増えて重くなる）
 * 実行: node docs/reports/scripts/18-density-threshold.ts
 */
import type { WorldConfig, InfectionDef } from '../../../src/core/types.ts';
import { presets } from '../../../src/core/presets.ts';
import { banner, done, header, line, trials, mark, fmt, type Trial } from './_lib.ts';

const SEEDS8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
const STEPS = 8000;
const TAIL = 4000;
const LONG = 30000;

const keystone = () => presets.find((p) => p.key === 'keystone')!.build();

/** 密度 = 回復速度 ÷ 実効代謝。A の代謝 0.5 を基準に出す */
function densityOf(regrow: number): number {
  return regrow / 0.5;
}

/** 15〜17 と同じ。個体数0の種は絶滅として数えられるので肉食は配列ごと外す */
function noPredator(regrow: number): WorldConfig {
  const cfg = keystone();
  cfg.species = cfg.species.filter((s) => s.id !== 3);
  cfg.grass = { ...cfg.grass, regrow };
  return cfg;
}

/** 17 の既定の病原体。transmit 以外は 17 と同じ値に固定する */
function pathogen(transmit: number): InfectionDef {
  return {
    transmit,
    lethality: 0.02,
    recover: 0,
    spontaneous: 0.0002,
    initial: 0.05,
    scope: 'self',
  };
}

function withInfection(regrow: number, transmit: number): WorldConfig {
  const cfg = noPredator(regrow);
  cfg.species = cfg.species.map((s) => ({ ...s, infection: pathogen(transmit) }));
  return cfg;
}

function extinctSummary(extinctAt: number[], total: number): string {
  if (extinctAt.length === 0) return '絶滅なし';
  const xs = [...extinctAt].sort((a, b) => a - b);
  return `絶滅 ${extinctAt.length}/${total}  中央 ${xs[Math.floor(xs.length / 2)]}  (${xs[0]}-${xs[xs.length - 1]})`;
}

function infLine(t: Trial): string {
  return t.species
    .map((s) => {
      const i = s.infection;
      const prev = s.mean > 0 ? ((i.infected / s.mean) * 100).toFixed(0) : '—';
      const rate = s.mean > 0 ? ((i.deaths / s.mean) * 100).toFixed(2) : '—';
      return `${s.name.slice(0, 4)} 感染率${prev}% 死${rate}%/歩`;
    })
    .join('  ');
}

function report(label: string, t: Trial): void {
  line(label, t);
  console.log(`  ${''.padEnd(26)} ${extinctSummary(t.extinctAt, SEEDS8.length)}`);
  console.log(`  ${''.padEnd(26)} ${infLine(t)}`);
}

/** 回復速度ごとに、どこまで伝染確率を下げても共存するかを見る */
const LEVELS = [
  { regrow: 0.06, transmits: [0.4, 0.6, 0.8] },
  { regrow: 0.12, transmits: [0.1, 0.2, 0.3, 0.4, 0.6] },
  { regrow: 0.24, transmits: [0.05, 0.1, 0.15, 0.2, 0.3] },
];

async function main(): Promise<void> {
  const t0 = performance.now();
  banner();

  // --- 節1. 対照 ---
  header('1. 対照 — 回復速度を上げただけで共存しないか');
  console.log('  ニッチ軸が1本なので理屈では助からないが、06 で豊穣化を読み違えている。');
  console.log('  ここでBが生き残ってしまったら、以降の共存は感染のおかげとは言えない。\n');

  const controls = await trials(
    LEVELS.map((l) => () => noPredator(l.regrow)),
    { seeds: SEEDS8, steps: STEPS, tail: TAIL },
  );
  LEVELS.forEach((l, i) => {
    const t = controls[i];
    line(`回復${l.regrow} 密度${densityOf(l.regrow).toFixed(2)} 感染なし`, t);
    console.log(`  ${''.padEnd(26)} ${extinctSummary(t.extinctAt, SEEDS8.length)}`);
  });
  console.log('\n  回復0.06 は 15〜17 の節1と同じ条件。A 1298(1231-1374) B 0 絶滅中央643 のはず。');

  // --- 節2〜4. 密度ごとの閾値 ---
  for (const level of LEVELS) {
    const d = densityOf(level.regrow);
    header(`回復速度 ${level.regrow}（密度 ${d.toFixed(2)}個体/セル）`);
    console.log(`  予想される閾値: ${(0.8 * 0.12 / d).toFixed(2)} 前後`);
    console.log('  （閾値 × 密度 ≒ 一定。基準は 17 の 密度0.12 で閾値0.8）\n');

    const ts = await trials(
      level.transmits.map((tr) => () => withInfection(level.regrow, tr)),
      { seeds: SEEDS8, steps: STEPS, tail: TAIL },
    );
    level.transmits.forEach((tr, i) => report(`transmit=${tr}`, ts[i]));
  }

  // --- 節5. 長い走行 ---
  header(`${LONG}ステップで確かめる`);
  console.log('  17 の tr=0.5 は閾値の直下で、絶滅の上端が 18319歩まで延びた。');
  console.log('  閾値ぎりぎりの条件を短い走行で「共存した」と読むと間違える。\n');

  const longConds = [
    { label: '回復0.12 感染なし', build: () => noPredator(0.12) },
    { label: '回復0.24 感染なし', build: () => noPredator(0.24) },
    { label: '回復0.12 tr=0.3', build: () => withInfection(0.12, 0.3) },
    { label: '回復0.12 tr=0.4', build: () => withInfection(0.12, 0.4) },
    { label: '回復0.24 tr=0.15', build: () => withInfection(0.24, 0.15) },
    { label: '回復0.24 tr=0.2', build: () => withInfection(0.24, 0.2) },
  ];
  const longTrials = await trials(longConds.map((c) => c.build), {
    seeds: SEEDS8, steps: LONG, tail: TAIL,
  });
  longConds.forEach((c, i) => {
    const t = longTrials[i];
    console.log(`  ${c.label.padEnd(20)} ${mark(t)}${t.survived}/${t.total}  ${fmt(t)}`);
    console.log(`  ${''.padEnd(20)} ${extinctSummary(t.extinctAt, SEEDS8.length)}`);
    console.log(`  ${''.padEnd(20)} ${infLine(t)}`);
  });

  console.log('\n  読み方:');
  console.log('  - 閾値 × 密度 が3つの密度で揃うなら、8割が要ったのは遭遇不足のせい');
  console.log('  - 揃わないなら、密度以外のものが効いている');
  console.log('  - Aの振れ幅にも注意。04・06 のとおり回復速度を上げると振動が激しくなる');

  await done(t0);
}

main();
