import { presetByKey } from '../../../src/core/presets.ts';
import type { WorldConfig } from '../../../src/core/types.ts';
import { trials, speedOf, mark, header, done, banner, type Trial } from './_lib.ts';

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
header('節1 回帰: 割合0の大量死を入れても1個体も変わらないか');

/**
 * 大量死は世界本体とは別の乱数ストリームから引き、間隔か割合が0なら1つも引かない。
 * 「入れたが起こしていない」構成が既存と完全一致することを先に確かめる。
 * ここがずれていたら、以降の差は大量死の効果ではなく乱数列のずれになる。
 */
{
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
header('節2 除去率を揃えて、まとめ方だけを変える（基本構成）');

/**
 * 揃えたのは除去率だけ。平均個体数まで揃う保証は無いので、揃っているかどうかは
 * ここで測る。**平均が動いていたら、変動係数の差は揺らぎの差ではない。**
 */
{
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
header('節3 丘の位置は動いていないか（進化構成）');

/**
 * **本題。** 大量死が形質を見ていないなら、速度の収束先は動かないはず。
 * 10 では捕食者ありで約2.74に収束している。
 *
 * ただし無作為な死でも間接的には効きうる。個体数が減れば1個体あたりの草が増え、
 * 代償の高い形質が一時的に安くなる（13 の解釈がこれ）。**その経路で丘が動くなら、
 * このつまみも「揺らぎだけ」ではない。** 動いたかどうかをここで数字にする。
 */
{
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
header('節4 除去率そのものを動かすと何が起きるか（基本構成）');

/**
 * 節2で揃えた軸を、わざと動かす段。平均個体数が下がるはずで、下がるなら
 * 「除去率を揃える」という手続きが必要だったことの裏づけになる。
 * 下がらなければ、節2の揃えは無意味だったということ。
 */
{
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
header('節5 丘が動いたのは誰を叩いたせいか（進化構成）');

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
{
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

await done(t0);
