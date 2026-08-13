/**
 * 17. 接触感染で共存は作れるか（段2）
 *
 * [16](../16-crowding.md) は自種の密度を直接読んで死亡確率に変えていた。
 * あれは共存条件を式で置いただけで、機構ではない。
 *
 * ここでは**同じセルにいる感染個体の数**しか見ない。種の個体数はどこにも出てこない。
 * それでも増えた種ほど同型との遭遇が増えるなら、頻度依存は接触の数え方から
 * 勝手に出るはず。「手で書かなくても出るか」が本題。
 *
 * 対照は 16 と同じ形にしてある。`scope: 'all'` は機構もつまみも同一で、
 * **宿主特異性だけが無い**。誰にでも移る病気はリスクが全体の密度で決まるので、
 * [15](../15-frequency-dependence.md) で潰した「均等な死」に化けるはず。
 *
 * 段1が出した的: 共存する条件では多いほうから **1%/歩** 前後を取り除いていた
 * （16 の rate 0.2 で A 1.23% / B 0.53%）。ここに届くかどうかが第一関門。
 *
 * 予想:
 * 1. transmit を上げれば共存する。ただし届かない可能性がある。
 *    共存点の密度（A 665 なら 0.06個体/セル）では同種との同セル遭遇が
 *    1歩あたり6%程度しかない。lethality を下げて感染期間を延ばさないと、
 *    病原体そのものが維持できない（R0 < 1 で消える）
 * 2. self と all で差が出る。all は 15・16 と同じく 0/8 のはず
 * 3. 自然発生が主な感染経路になっている条件では共存しない。
 *    密度に依存しない感染は均等な死と同じなので
 *
 * 所要: 4スレッドで節1〜4が約3分、節5が約4分
 * 実行: node docs/reports/scripts/17-infection.ts
 */
import type { WorldConfig, InfectionDef } from '../../../src/core/types.ts';
import { presets } from '../../../src/core/presets.ts';
import { banner, done, header, line, trials, mark, fmt, type Trial } from './_lib.ts';

const SEEDS8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
const STEPS = 8000;
const TAIL = 4000;
const LONG = 30000;

const keystone = () => presets.find((p) => p.key === 'keystone')!.build();

/** 15・16 と同じ。個体数0の種は絶滅として数えられるので肉食は配列ごと外す */
function noPredator(): WorldConfig {
  const cfg = keystone();
  cfg.species = cfg.species.filter((s) => s.id !== 3);
  return cfg;
}

/**
 * 既定の病原体。transmit と scope 以外は固定しておく。
 *
 * lethality を 0.02 と低めに置いたのは、感染期間（1/lethality ≒ 50歩）を
 * 長く取らないと R0 が 1 を超えないため。同セル遭遇が1歩あたり数%しか
 * 起きない密度なので、致死性を上げると病原体のほうが先に消える。
 *
 * spontaneous は病原体が絶えたときの再着火用に最小限だけ。
 * これは密度に依存しない感染なので、大きくすると均等な死に化ける。
 * 節4で接触経由との内訳を確かめる。
 */
function pathogen(over: Partial<InfectionDef> = {}): InfectionDef {
  return {
    transmit: 0.5,
    lethality: 0.02,
    recover: 0,
    spontaneous: 0.0002,
    initial: 0.05,
    scope: 'self',
    ...over,
  };
}

function withInfection(over: Partial<InfectionDef> = {}): WorldConfig {
  const cfg = noPredator();
  const inf = pathogen(over);
  cfg.species = cfg.species.map((s) => ({ ...s, infection: { ...inf } }));
  return cfg;
}

function extinctSummary(extinctAt: number[], total: number): string {
  if (extinctAt.length === 0) return '絶滅なし';
  const xs = [...extinctAt].sort((a, b) => a - b);
  return `絶滅 ${extinctAt.length}/${total}  中央 ${xs[Math.floor(xs.length / 2)]}  (${xs[0]}-${xs[xs.length - 1]})`;
}

/**
 * 感染の測定値。**割合/歩** が段1の的（多いほうに1%前後）と比べる量。
 * 接触と自然発生の内訳を必ず並べる。自然発生が主なら密度依存になっていない
 */
function infLine(t: Trial): string {
  return t.species
    .map((s) => {
      const i = s.infection;
      const prev = s.mean > 0 ? ((i.infected / s.mean) * 100).toFixed(0) : '—';
      const rate = s.mean > 0 ? ((i.deaths / s.mean) * 100).toFixed(2) : '—';
      const share = i.contact + i.spontaneous > 0
        ? ((i.contact / (i.contact + i.spontaneous)) * 100).toFixed(0)
        : '—';
      return `${s.name.slice(0, 4)} 感染率${prev}% 死${rate}%/歩 接触${share}%`;
    })
    .join('  ');
}

function report(label: string, t: Trial): void {
  line(label, t);
  console.log(`  ${''.padEnd(26)} ${extinctSummary(t.extinctAt, SEEDS8.length)}`);
  console.log(`  ${''.padEnd(26)} ${infLine(t)}`);
}

async function main(): Promise<void> {
  const t0 = performance.now();
  banner();

  // --- 節1. 回帰 ---
  header('1. 回帰の確認');
  console.log('  infection を書かない構成は乱数を1つも消費しないはず。');
  console.log('  15・16 の節1と同じ数字が出なければ、以降の比較は全部無効。\n');
  console.log('  期待値: 肉食あり OK 8/8 A 574(210-1064) B 505(123-896) 肉食 121(8-346)');
  console.log('          肉食なし -- 0/8 A 1298(1231-1374) B 0  絶滅中央 643\n');

  const [base, noPred] = await trials([keystone, noPredator], {
    seeds: SEEDS8, steps: STEPS, tail: TAIL,
  });
  line('肉食あり（既定）', base);
  line('肉食なし', noPred);
  console.log(`  ${''.padEnd(26)} ${extinctSummary(noPred.extinctAt, SEEDS8.length)}`);

  // --- 節2. self で transmit を振る ---
  header('2. self（宿主特異的）— 伝染確率を振る');
  console.log('  同じセルの感染した同種1体あたりの伝染確率。');
  console.log('  病原体が維持できているか（感染率）と、届いた死亡率を並べて見る。\n');

  const transmits = [0.1, 0.3, 0.5, 0.8, 1.0];
  const selfTrials = await trials(
    transmits.map((tr) => () => withInfection({ transmit: tr, scope: 'self' })),
    { seeds: SEEDS8, steps: STEPS, tail: TAIL },
  );
  transmits.forEach((tr, i) => report(`self transmit=${tr}`, selfTrials[i]));

  // --- 節3. all（対照） ---
  header('3. all（誰にでも移る）— 対照');
  console.log('  機構もつまみも同じで、宿主特異性だけが無い。');
  console.log('  ここで共存したら、効いているのは頻度依存ではない。\n');

  const allTrials = await trials(
    transmits.map((tr) => () => withInfection({ transmit: tr, scope: 'all' })),
    { seeds: SEEDS8, steps: STEPS, tail: TAIL },
  );
  transmits.forEach((tr, i) => report(`all  transmit=${tr}`, allTrials[i]));

  // --- 節4. 致死性と感染期間 ---
  header('4. 致死性を振る（感染期間との釣り合い）');
  console.log('  lethality を上げると1体あたりの打撃は増えるが、感染期間が短くなって');
  console.log('  病原体が維持できなくなる。R0 が 1 を割れば消える。');
  console.log('  transmit=0.8 固定で、どこに山があるかを見る。\n');

  const lethals = [0.005, 0.01, 0.02, 0.05, 0.1];
  const lethalTrials = await trials(
    lethals.map((l) => () => withInfection({ transmit: 0.8, lethality: l, scope: 'self' })),
    { seeds: SEEDS8, steps: STEPS, tail: TAIL },
  );
  lethals.forEach((l, i) => report(`self lethality=${l}`, lethalTrials[i]));

  // --- 節5. 自然発生を切る ---
  header('5. 自然発生を切る（接触だけで回るか）');
  console.log('  自然発生は密度に依存しない感染なので、それ自体は均等な死と同じ。');
  console.log('  切っても共存するなら、効いているのは接触のほうだと言える。');
  console.log('  逆に病原体が絶えてしまうなら、再着火が要るという話になる。\n');

  const noSpont = await trials(
    [0.5, 0.8, 1.0].map((tr) => () => withInfection({ transmit: tr, spontaneous: 0, scope: 'self' })),
    { seeds: SEEDS8, steps: STEPS, tail: TAIL },
  );
  [0.5, 0.8, 1.0].forEach((tr, i) => report(`自然発生なし tr=${tr}`, noSpont[i]));

  // --- 節6. 長い走行 ---
  header(`6. ${LONG}ステップで確かめる`);
  const longConds = [
    { label: '肉食あり（既定）', build: keystone },
    { label: '感染なし', build: noPredator },
    ...[0.5, 0.8, 1.0].map((tr) => ({
      label: `self tr=${tr}`,
      build: () => withInfection({ transmit: tr, scope: 'self' }),
    })),
    ...[0.8, 1.0].map((tr) => ({
      label: `all  tr=${tr}`,
      build: () => withInfection({ transmit: tr, scope: 'all' }),
    })),
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
  console.log('  - 感染率が0%に張り付く条件は、病原体が維持できていない（R0<1）。');
  console.log('    共存しなくて当然なので、強さ不足として読む');
  console.log('  - 接触%が低い条件は、感染の主経路が自然発生。密度依存になっていない');
  console.log('  - self が 8/8 で all が 0/8 なら、宿主特異性が効いている');

  await done(t0);
}

main();
