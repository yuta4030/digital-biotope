import { presetByKey } from '../../../src/core/presets.ts';
import type { WorldConfig } from '../../../src/core/types.ts';
import {
  trials,
  invade,
  invasionLine,
  speedOf,
  mark,
  header,
  done,
  banner,
  type Trial,
} from './_lib.ts';

/**
 * レポート14: 大量死 — 揺らぎのつまみは作れるか
 *
 *   node docs/reports/scripts/14-mass-death.ts
 *
 * [13](../13-escape.md) が「揺らぎの大きさが違う世界どうしを比べられなかった」で
 * 終わっている。捕食が丘（速度の最適）と揺らぎの両方を作るので、捕食に関わる
 * つまみはどれも両方を動かしてしまうため。13 の最後に候補として挙げたのが
 * **無作為な大量死**で、形質を一切見ないので速度の得失に触れずに谷だけ作れる、
 * という筋だった。それを実装して、本当に「揺らぎだけ」が動くかを測る。
 *
 * 比較は `割合 ÷ 平均間隔`（1ステップあたりに取り除く割合）を揃えた組で行う。
 * 揃えないと平均個体数まで動いて、06 の豊穣化を逆向きにやったのと区別がつかない。
 * 揃えたうえで動くのは**まとめ方**だけ——小刻みに削るか、たまに大きく削るか。
 *
 * 節1で回帰、節2でつまみが何を動かすか、節3で丘の位置が動いていないかを見る。
 * **節3が本題**。ここで速度の収束先が動いていたら、このつまみは失敗になる。
 */

const t0 = performance.now();
banner();

/**
 * 節を絞って走らせる（`node docs/reports/scripts/14-mass-death.ts 6`）。
 * 節6（侵入）だけが桁違いに重いので、他を測り直さずに回せるようにしてある。
 */
const ONLY = process.argv[2];
const want = (n: string): boolean => ONLY === undefined || ONLY === n;

const SEEDS_8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
const STEPS = 8000;
const TAIL = 4000;

interface Regime {
  label: string;
  /** undefined なら大量死なし */
  interval?: number;
  fraction?: number;
}

/**
 * 除去率を揃えた3段。割合÷平均間隔はどれも 0.001（0.1%/ステップ）で、
 * 間隔と割合を5倍ずつ動かすので比は一定に保たれる。
 * 0.1% にしたのは、大きすぎると系が痩せるほうが主効果になり、
 * 小さすぎると谷が作れないため。
 *
 * 「大」は500ステップに1回、その場にいる個体の半分が消える。8000ステップの走行で
 * 平均16回しか起きないので、シードごとの実現回数は幾何分布ぶん散らばる。
 * それを平均で潰さないよう、以降の表は必ず最小-最大を併記する。
 */
const REGIMES: Regime[] = [
  { label: '大量死なし' },
  { label: `小刻み  20歩×2%`, interval: 20, fraction: 0.02 },
  { label: `中      100歩×10%`, interval: 100, fraction: 0.1 },
  { label: `大      500歩×50%`, interval: 500, fraction: 0.5 },
];

/** 平均除去率そのものを動かす段。平均個体数が一緒に動くことの確認用 */
const LEVELS: Regime[] = [
  { label: '除去率 0.00%/歩', },
  { label: '除去率 0.05%/歩', interval: 100, fraction: 0.05 },
  { label: '除去率 0.10%/歩', interval: 100, fraction: 0.1 },
  { label: '除去率 0.20%/歩', interval: 100, fraction: 0.2 },
];

function withRegime(build: () => WorldConfig, r: Regime): () => WorldConfig {
  return () => {
    const cfg = build();
    if (r.interval !== undefined && r.fraction !== undefined) {
      cfg.disturbance = { interval: r.interval, fraction: r.fraction };
    }
    return cfg;
  };
}

const basic = () => presetByKey('basic').build();
const evolution = () => presetByKey('evolution').build();

/**
 * 揺らぎの大きさは変動係数で見る。標準偏差そのままだと平均が動いたぶんが混ざる。
 *
 * 除去率は「実際に取り除いた数 ÷ 平均個体数」。設計値と合っていなければ、
 * 揃えたつもりの軸が揃っていない。
 */
function regimeLine(label: string, t: Trial, idx = 0): void {
  const s = t.species[idx];
  const cv = s.mean > 0 ? s.sd / s.mean : 0;
  const removed = s.mean > 0 ? (s.killed / s.mean) * 100 : 0;
  console.log(
    `  ${label.padEnd(20)} ${mark(t)}${t.survived}/${t.total}  ` +
      `${s.mean.toFixed(0).padStart(4)}(${String(s.min).padStart(3)}-${String(s.max).padStart(4)})  ` +
      `sd ${s.sd.toFixed(0).padStart(3)}  変動係数 ${cv.toFixed(3)}  ` +
      `除去 ${removed.toFixed(3)}%/歩`,
  );
}

// ---------------------------------------------------------------------------
if (want('1')) header('節1 回帰: 割合0の大量死を入れても1個体も変わらないか');

/**
 * 大量死は世界本体とは別の乱数ストリームから引き、間隔か割合が0なら1つも引かない。
 * 「入れたが起こしていない」構成が既存と完全一致することを先に確かめる。
 * ここがずれていたら、以降の差は大量死の効果ではなく乱数列のずれになる。
 */
if (want('1')) {
  const off = () => {
    const cfg = basic();
    cfg.disturbance = { interval: 100, fraction: 0 };
    return cfg;
  };
  const [a, b] = await trials([basic, off], { seeds: SEEDS_8, steps: STEPS, tail: TAIL });
  const pairs: [string, number, number][] = [
    ['草食 平均', a.species[0].mean, b.species[0].mean],
    ['草食 最小', a.species[0].min, b.species[0].min],
    ['草食 最大', a.species[0].max, b.species[0].max],
    ['草食 標準偏差', a.species[0].sd, b.species[0].sd],
    ['肉食 平均', a.species[1].mean, b.species[1].mean],
    ['肉食 最小', a.species[1].min, b.species[1].min],
    ['肉食 最大', a.species[1].max, b.species[1].max],
    ['草の生産', a.grassProduced, b.grassProduced],
  ];
  let ok = true;
  for (const [name, x, y] of pairs) {
    if (x !== y) {
      ok = false;
      console.log(`  ✗ ${name}: ${x} ≠ ${y}`);
    }
  }
  console.log(
    ok
      ? `  一致（8シード / 草食 ${a.species[0].mean.toFixed(0)} 肉食 ${a.species[1].mean.toFixed(0)}）`
      : '  ずれている。大量死が無効のときに乱数を消費している',
  );
  if (!ok) {
    await done(t0);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
if (want('2')) header('節2 除去率を揃えて、まとめ方だけを変える（基本構成）');

/**
 * 揃えたのは除去率だけ。平均個体数まで揃う保証は無いので、揃っているかどうかは
 * ここで測る。**平均が動いていたら、変動係数の差は揺らぎの差ではない。**
 */
if (want('2')) {
  const ts = await trials(REGIMES.map((r) => withRegime(basic, r)), {
    seeds: SEEDS_8,
    steps: STEPS,
    tail: TAIL,
  });
  console.log('  [草食動物]');
  REGIMES.forEach((r, i) => regimeLine(r.label, ts[i], 0));
  console.log('\n  [肉食動物]');
  REGIMES.forEach((r, i) => regimeLine(r.label, ts[i], 1));
  console.log(
    '\n  草の生産  ' +
      REGIMES.map((r, i) => `${r.label.split(' ')[0]} ${ts[i].grassProduced.toFixed(1)}`).join('  '),
  );
}

// ---------------------------------------------------------------------------
if (want('3')) header('節3 丘の位置は動いていないか（進化構成）');

/**
 * **本題。** 大量死が形質を見ていないなら、速度の収束先は動かないはず。
 * 10 では捕食者ありで約2.74に収束している。
 *
 * ただし無作為な死でも間接的には効きうる。個体数が減れば1個体あたりの草が増え、
 * 代償の高い形質が一時的に安くなる（13 の解釈がこれ）。**その経路で丘が動くなら、
 * このつまみも「揺らぎだけ」ではない。** 動いたかどうかをここで数字にする。
 */
if (want('3')) {
  const ts = await trials(REGIMES.map((r) => withRegime(evolution, r)), {
    seeds: SEEDS_8,
    steps: STEPS,
    tail: TAIL,
  });
  console.log('  [草食動物]');
  REGIMES.forEach((r, i) => regimeLine(r.label, ts[i], 0));
  console.log('\n  [肉食動物]');
  REGIMES.forEach((r, i) => regimeLine(r.label, ts[i], 1));
  console.log('\n  到達速度  平均(最小-最大)  集団内ばらつき');
  REGIMES.forEach((r, i) => {
    console.log(
      `  ${r.label.padEnd(20)} ${speedOf(ts[i]).padEnd(22)} ${ts[i].species[0].speedSd.toFixed(3)}`,
    );
  });
}

// ---------------------------------------------------------------------------
if (want('4')) header('節4 除去率そのものを動かすと何が起きるか（基本構成）');

/**
 * 節2で揃えた軸を、わざと動かす段。平均個体数が下がるはずで、下がるなら
 * 「除去率を揃える」という手続きが必要だったことの裏づけになる。
 * 下がらなければ、節2の揃えは無意味だったということ。
 */
if (want('4')) {
  const ts = await trials(LEVELS.map((r) => withRegime(basic, r)), {
    seeds: SEEDS_8,
    steps: STEPS,
    tail: TAIL,
  });
  console.log('  [草食動物]');
  LEVELS.forEach((r, i) => regimeLine(r.label, ts[i], 0));
  console.log('\n  [肉食動物]');
  LEVELS.forEach((r, i) => regimeLine(r.label, ts[i], 1));
}

// ---------------------------------------------------------------------------
if (want('5')) header('節5 丘が動いたのは誰を叩いたせいか（進化構成）');

/**
 * 節3で速度の収束先が下がった。無作為な死は形質を見ていないので、
 * 直接の選択ではありえない。**間接の経路を疑う。**
 *
 * 10 が示したとおり、速い足の価値は捕食圧が生んでいる（捕食者を消すと2.7→1.1）。
 * 大量死は捕食者も叩くので、捕食圧が下がって丘が低いほうへ寄った、という筋が立つ。
 * だとすれば、**捕食者を対象から外せば速度は戻るはず**。
 *
 * 「草食のみ」と「両方」は草食への圧力が同じで、捕食者を叩くかどうかだけが違う。
 * 13 で捕食圧と谷を切り分けたときと同じ形の対照になる。
 */
if (want('5')) {
  const targets: { label: string; species?: number[] }[] = [
    { label: '両方' },
    { label: '草食のみ', species: [1] },
    { label: '肉食のみ', species: [2] },
  ];
  const cases: { label: string; build: () => WorldConfig }[] = [
    { label: '大量死なし', build: evolution },
  ];
  for (const r of REGIMES.slice(2)) {
    for (const tg of targets) {
      cases.push({
        label: `${r.label.split(' ')[0].padEnd(4)} ${tg.label}`,
        build: () => {
          const cfg = evolution();
          cfg.disturbance = { interval: r.interval!, fraction: r.fraction!, species: tg.species };
          return cfg;
        },
      });
    }
  }

  const ts = await trials(
    cases.map((c) => c.build),
    { seeds: SEEDS_8, steps: STEPS, tail: TAIL },
  );
  console.log('  条件              到達速度 平均(最小-最大)  草食 平均(最小-最大) 変動係数  肉食');
  cases.forEach((c, i) => {
    const g = ts[i].species[0];
    const p = ts[i].species[1];
    console.log(
      `  ${c.label.padEnd(16)} ${speedOf(ts[i]).padEnd(20)} ` +
        `${g.mean.toFixed(0).padStart(4)}(${String(g.min).padStart(3)}-${String(g.max).padStart(4)})  ` +
        `${(g.sd / g.mean).toFixed(3)}  ` +
        `${p.mean.toFixed(0).padStart(4)}`,
    );
  });
}

// ---------------------------------------------------------------------------
if (want('6')) header('節6 揺らぎの大きさを変えると、侵入者の定着率はどう動くか');

/**
 * DIRECTION.md がずっと掲げてきて 12 でも 13 でも測れなかった予想表
 * （揺らぎ 小=低い / 中=高い / 大=低い）を、初めて世界間で測る。
 *
 * 枠組みは 12 のまま。在来の草食を複製して代謝だけ変えた種を1体ずつ投入し、
 * 30体に達したら定着とみなす。変えるのは大量死の設定だけ。
 *
 * 基本構成では大量死は揺らぎを**減らす**方向に働く（節2）。つまみの向きが
 * 進化構成と逆だが、変動係数 0.34〜0.50 の4段が取れるので軸としては使える。
 *
 * **「在来のみ」の条件が要る。** 全種を叩くと、まだ1体しかいない侵入者も
 * 同じ確率で殺される。定着率が下がったとき、それが「窓が開かなかった」のか
 * 「窓は開いたが侵入者が巻き添えで消えた」のか、分けないと言えない。
 * DIRECTION.md の「揺らぎは両刃」を、刃の片方を外して測る形。
 *
 * **測れるのは予想表の片側だけ。** 基本構成でこのつまみが動かせる範囲は
 * 変動係数 0.34〜0.50 で、大量死なしが上端になる（節2）。
 * 揺らぎを既定より大きくする条件が作れないので、「大きすぎると殺しにかかる」側は
 * ここでは検定できない。測れるのは「減らすと定着率はどう動くか」まで。
 */
if (want('6')) {
  /** 12 と同じ構成。在来 id=1 / 侵入者 id=3 / 肉食 id=2（肉食は両方を食べる） */
  const cfgOf = (invaderMetabolism: number, d?: WorldConfig['disturbance']): WorldConfig => {
    const cfg = presetByKey('basic').build();
    const resident = cfg.species[0];
    const carnivore = cfg.species[1];
    const invader = {
      ...resident,
      id: 3,
      name: '侵入者',
      color: '#c9a5f2',
      metabolism: invaderMetabolism,
      initialCount: 0,
    };
    carnivore.preys = [1, 3];
    cfg.species = [resident, invader, carnivore];
    if (d !== undefined) cfg.disturbance = d;
    return cfg;
  };

  const BASE = {
    invaderIdx: 1,
    warmup: 2000,
    attempts: 250,
    propagule: 1,
    clumped: false,
    establishAt: 30,
    timeout: 1500,
    recovery: 300,
    jitter: 300,
    followUp: 0,
    followEvery: 1000,
  };
  /** 在来（id 1）と肉食（id 2）だけを叩く。侵入者（id 3）は巻き添えを免れる */
  const RESIDENT_ONLY = [1, 2];

  const conds: { label: string; d?: WorldConfig['disturbance'] }[] = [
    { label: 'なし' },
    { label: '小刻み 全種', d: { interval: 20, fraction: 0.02 } },
    { label: '中     全種', d: { interval: 100, fraction: 0.1 } },
    { label: '大     全種', d: { interval: 500, fraction: 0.5 } },
    { label: '小刻み 在来のみ', d: { interval: 20, fraction: 0.02, species: RESIDENT_ONLY } },
    { label: '中     在来のみ', d: { interval: 100, fraction: 0.1, species: RESIDENT_ONLY } },
    { label: '大     在来のみ', d: { interval: 500, fraction: 0.5, species: RESIDENT_ONLY } },
  ];

  // 12 と同じ校正点。中立は「有利さゼロでも通ってしまう率」、
  // 不利は「局所最適から抜けるのに要る、選択に逆らう通過」に対応する
  for (const [label, met] of [
    ['中立 0.60', 0.6],
    ['不利 0.63', 0.63],
  ] as [string, number][]) {
    console.log(`\n  [${label}]`);
    for (const c of conds) {
      const v = await invade(() => cfgOf(met, c.d), { ...BASE, seeds: SEEDS_8 });
      const r = v.resident[0];
      invasionLine(
        `${c.label} cv${r.cv.toFixed(3)} 在来${r.mean.toFixed(0)}`,
        v,
      );
    }
  }
}

await done(t0);
