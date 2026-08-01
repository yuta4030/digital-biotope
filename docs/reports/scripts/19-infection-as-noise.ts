/**
 * 19. 病原体は揺らぎのつまみになるか
 *
 * [17](../17-infection.md) を入れたもう一つの理由。[14](../14-mass-death.md) は
 * 揺らぎのつまみを作れたが、全種を叩くと速度の丘が 2.70 → 2.25 へ動いた
 * （捕食者も減って捕食圧が下がるため）。対象を草食だけに絞れば成立したが、
 * 塊を大きくすると同じ交絡が別経路で戻ってきた。
 *
 * 宿主特異的な病原体は叩く相手を選べる。そのうえ**密度依存なので自己制限的**で、
 * 宿主が減れば流行も収まる。深い谷を作らずに揺らぎだけ足せる可能性がある。
 *
 * 逆の可能性もある。密度依存の死は負のフィードバックなので**揺らぎを減らす**かも
 * しれないし、流行と回復の遅れが**独自の周期**を作るかもしれない。
 * どちらに転ぶか分からないので測る。
 *
 * 14 が固定を要求する組をそのまま測る:
 *   速度の収束先（丘）／捕食者の頭数／平均個体数 は動かさず、
 *   変動係数と**谷の深さ（最小÷平均）**だけを動かせるか。
 *   14 で谷の深さのほうが本命だと分かっている（変動係数は代弁者として不十分）。
 *
 * 対照は 14 の大量死（草食のみ）。**節2で実際に取り除かれた割合に合わせて**
 * 強さを決める。同じ量を取り除く無作為な死と比べて初めて、
 * 「密度依存だから」「流行の周期だから」と言える。
 *
 * 進化構成の密度は 728/10800 = 0.067個体/セルで、17 の 0.12 より低い。
 * [18](../18-density-threshold.md) の 閾値×密度 ≒ 0.06 からすると、
 * 共存を作るには伝染確率が1を超える必要がある。ただしここで要るのは共存ではなく
 * **病原体が持続してそれなりに叩くこと**なので、17 の tr=0.5（感染率46%）に
 * 相当する強さがあればいい。密度が半分なので tr=1.0 前後がそれにあたる。
 *
 * 所要: 4スレッドで10分前後（視野3の捕食者がいるので重い）
 * 実行: node docs/reports/scripts/19-infection-as-noise.ts
 */
import type { WorldConfig, InfectionDef } from '../../../src/core/types.ts';
import { presets } from '../../../src/core/presets.ts';
import { banner, done, header, trials, speedOf, mark, fmt, type Trial } from './_lib.ts';

const SEEDS8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
/** 10 のとおり、遺伝する形質は世代を通してしか動かない。後半平均が過渡状態にならない長さ */
const STEPS = 20000;
const TAIL = 4000;

const HERBIVORE = 0;
const PREDATOR = 1;

const evolution = () => presets.find((p) => p.key === 'evolution')!.build();

/** 草食にだけ病原体を入れる。捕食者は infection を持たないので感染しない */
function withInfection(transmit: number): WorldConfig {
  const cfg = evolution();
  const inf: InfectionDef = {
    transmit,
    lethality: 0.02,
    recover: 0,
    spontaneous: 0.0002,
    initial: 0.05,
    scope: 'self',
  };
  cfg.species = cfg.species.map((s, i) => (i === HERBIVORE ? { ...s, infection: inf } : s));
  return cfg;
}

/** 対照。14 の大量死を草食だけに当てる */
function withDeath(interval: number, fraction: number): WorldConfig {
  const cfg = evolution();
  cfg.disturbance = { interval, fraction, species: [cfg.species[HERBIVORE].id] };
  return cfg;
}

/** 変動係数と谷の深さ。14 で後者のほうが本命だと分かっている */
function noise(t: Trial, idx: number): string {
  const s = t.species[idx];
  const cv = s.mean > 0 ? s.sd / s.mean : 0;
  const depth = s.mean > 0 ? s.min / s.mean : 0;
  return `変動係数 ${cv.toFixed(3)}  谷の深さ ${depth.toFixed(3)}`;
}

/** 1ステップあたり草食から取り除かれた割合。対照の強さを合わせるのに使う */
function removalRate(t: Trial): number {
  const s = t.species[HERBIVORE];
  if (s.mean <= 0) return 0;
  return (s.infection.deaths + s.killed) / s.mean;
}

function report(label: string, t: Trial): void {
  const h = t.species[HERBIVORE];
  const p = t.species[PREDATOR];
  console.log(`  ${label.padEnd(20)} ${mark(t)}${t.survived}/${t.total}  ${fmt(t)}`);
  console.log(`  ${''.padEnd(20)} 速度 ${speedOf(t, HERBIVORE)}   捕食者 ${p.mean.toFixed(0)}`);
  console.log(`  ${''.padEnd(20)} ${noise(t, HERBIVORE)}`);
  const inf = h.infection;
  const prev = h.mean > 0 ? ((inf.infected / h.mean) * 100).toFixed(0) : '0';
  console.log(
    `  ${''.padEnd(20)} 感染率 ${prev}%  除去 ${(removalRate(t) * 100).toFixed(2)}%/歩` +
      `（感染 ${inf.deaths.toFixed(2)} 大量死 ${h.killed.toFixed(2)} 体/歩）`,
  );
}

async function main(): Promise<void> {
  const t0 = performance.now();
  banner();
  console.log(`条件: ${STEPS}ステップ / 後半${TAIL}ステップで統計 / ${SEEDS8.length}シード`);

  // --- 節1. 回帰 ---
  header('1. 回帰の確認');
  console.log('  infection も disturbance も書かない構成は乱数を消費しない。');
  console.log('  10・14 の進化構成（速度 約2.7 / 草食 約728 / 肉食 約337）と揃うはず。\n');

  const [base] = await trials([evolution], { seeds: SEEDS8, steps: STEPS, tail: TAIL });
  report('既定（病原体なし）', base);

  // --- 節2. 病原体 ---
  header('2. 草食だけに病原体を入れる');
  console.log('  14 が固定を要求する組を全部並べる。速度・捕食者・平均が動かず、');
  console.log('  谷の深さだけが動くなら、つまみとして使える。\n');

  const transmits = [0.4, 0.6, 0.8, 1.0];
  const infTrials = await trials(
    transmits.map((tr) => () => withInfection(tr)),
    { seeds: SEEDS8, steps: STEPS, tail: TAIL },
  );
  transmits.forEach((tr, i) => report(`transmit=${tr}`, infTrials[i]));

  // --- 節3. 対照 ---
  header('3. 対照 — 同じ量を無作為に取り除く');
  console.log('  節2で実際に取り除かれた割合に合わせて、14 の大量死（草食のみ）を当てる。');
  console.log();
  console.log('  **間隔1歩で当てる。** 病原体は毎ステップ少しずつ殺すので、');
  console.log('  100歩に1回まとめて叩く形と比べると、変わったのが「密度依存かどうか」');
  console.log('  ではなく「塊の大きさ」になる。14 は塊が谷の深さを決めると言っている。');
  console.log('  塊の効果そのものを見るために、100歩版も並べる。\n');

  const rates = [removalRate(infTrials[1]), removalRate(infTrials[3])];
  const controls = [
    { label: '対照1a 毎歩', tr: 0.6, r: rates[0], interval: 1 },
    { label: '対照2a 毎歩', tr: 1.0, r: rates[1], interval: 1 },
    { label: '対照1b 100歩', tr: 0.6, r: rates[0], interval: 100 },
  ];
  controls.forEach((c) => {
    const f = c.r * c.interval;
    console.log(
      `  ${c.label}: 節2 transmit=${c.tr} の実現除去率 ${(c.r * 100).toFixed(2)}%/歩` +
        ` → ${c.interval}歩×${(f * 100).toFixed(2)}%`,
    );
  });
  console.log();

  const ctrlTrials = await trials(
    controls.map((c) => () => withDeath(c.interval, c.r * c.interval)),
    { seeds: SEEDS8, steps: STEPS, tail: TAIL },
  );
  ctrlTrials.forEach((t, i) => report(controls[i].label, t));

  // --- 節4. 突き合わせ ---
  header('4. 突き合わせ');
  console.log('  同じ除去率・同じ削り方で、病原体と無作為な死のどちらが深い谷を作るか。\n');
  const pairs: [string, Trial, string, Trial][] = [
    ['感染 tr=0.6', infTrials[1], controls[0].label, ctrlTrials[0]],
    ['感染 tr=1.0', infTrials[3], controls[1].label, ctrlTrials[1]],
    ['感染 tr=0.6', infTrials[1], controls[2].label, ctrlTrials[2]],
  ];
  for (const [la, ta, lb, tb] of pairs) {
    console.log(`  ${la.padEnd(14)} 除去 ${(removalRate(ta) * 100).toFixed(2)}%/歩  ${noise(ta, HERBIVORE)}  速度 ${speedOf(ta, HERBIVORE)}`);
    console.log(`  ${lb.padEnd(14)} 除去 ${(removalRate(tb) * 100).toFixed(2)}%/歩  ${noise(tb, HERBIVORE)}  速度 ${speedOf(tb, HERBIVORE)}`);
    console.log();
  }

  console.log('  読み方:');
  console.log('  - 速度の収束先が既定（約2.7）から動いたら、丘が動いている＝つまみとして失格');
  console.log('  - 捕食者の頭数が減っていたら、14 と同じ経路で丘が動く');
  console.log('  - 谷の深さが対照と変わらないなら、病原体である必要がない');

  await done(t0);
}

main();
