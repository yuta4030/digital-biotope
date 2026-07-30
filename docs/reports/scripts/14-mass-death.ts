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
  type Invasion,
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
if (want('6')) header('節6 揺らぎはどこまで大きくできるか（基本構成）');

/**
 * 節2 で取れた揺らぎは変動係数 0.34〜0.50 で、**上端が大量死なし**だった。
 * これでは予想表の「大きすぎると殺しにかかる」側が範囲の外に出てしまう。
 * 除去率 0.1%/歩 を保ったまま塊を大きくして、既定より上に出られるかを見る。
 *
 * 対象を全種にしたままだと出られない。1回の削りを大きくすると**捕食者が先に消える**。
 * 上の層ほど個体数の桁が小さく、偶然だけで消える（[04](../04-metabolism-stability.md)）。
 * 崩壊した走行を混ぜた統計は読めない（[09](../09-detritus-buffer.md) の罠）ので、
 * 草食だけを叩く形に変えて範囲を伸ばす。
 */
if (want('6')) {
  const LUMPS: { label: string; interval: number; fraction: number }[] = [
    { label: '500歩×50%', interval: 500, fraction: 0.5 },
    { label: '800歩×80%', interval: 800, fraction: 0.8 },
    { label: '900歩×90%', interval: 900, fraction: 0.9 },
  ];
  const cases: { label: string; species?: number[] }[] = [
    { label: '全種' },
    { label: '草食のみ', species: [1] },
  ];
  const builds: (() => WorldConfig)[] = [basic];
  const labels = ['大量死なし'];
  for (const c of cases) {
    for (const l of LUMPS) {
      labels.push(`${c.label} ${l.label}`);
      builds.push(() => {
        const cfg = basic();
        cfg.disturbance = { interval: l.interval, fraction: l.fraction, species: c.species };
        return cfg;
      });
    }
  }
  const ts = await trials(builds, { seeds: SEEDS_8, steps: STEPS, tail: TAIL });
  console.log('  [草食動物]');
  labels.forEach((l, i) => regimeLine(l, ts[i], 0));
  console.log('\n  [肉食動物]');
  labels.forEach((l, i) => regimeLine(l, ts[i], 1));
}

// ---------------------------------------------------------------------------
if (want('7')) header('節7 揺らぎの大きさを変えると、侵入者の定着率はどう動くか');

/**
 * DIRECTION.md がずっと掲げてきて 12 でも 13 でも測れなかった予想表
 * （揺らぎ 小=低い / 中=高い / 大=低い）を、初めて世界間で測る。
 *
 * 枠組みは 12 のまま。在来の草食を複製して代謝だけ変えた種を1体ずつ投入し、
 * 30体に達したら定着とみなす。変えるのは大量死の設定だけ。
 *
 * **肉食は対象から外す**（節6）。全種を叩くと大きい塊で捕食者が絶滅し、
 * 崩壊を除いた残りだけで定着率を測ることになる。除去率はどの条件も 0.1%/歩 で、
 * 動くのは1回の削りの大きさだけ。
 *
 * **「在来のみ」の条件が要る。** 草食2種を叩くと、まだ1体しかいない侵入者も
 * 同じ確率で殺される。定着率が下がったとき、それが「窓が開かなかった」のか
 * 「窓は開いたが侵入者が巻き添えで消えた」のか、分けないと言えない。
 * DIRECTION.md の「揺らぎは両刃」を、刃の片方を外して測る形。
 *
 * 節8は同じ走行から出す。投入時の在来個体数でビン分けすれば、条件間の差が
 * 「同じ谷でも通りやすさが違う」のか「谷に当たる頻度が違うだけ」なのかが分かれる。
 */
if (want('7')) {
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
  /** 草食2種（在来 id=1 と侵入者 id=3）を叩く。肉食 id=2 は対象外 */
  const BOTH_GRAZERS = [1, 3];
  /** 在来だけを叩く。1体しかいない侵入者は巻き添えを免れる */
  const RESIDENT_ONLY = [1];

  /** 除去率はどれも 0.1%/歩（割合÷間隔）。動くのは1回の削りの大きさだけ */
  const LUMPS: { label: string; interval: number; fraction: number }[] = [
    { label: '20歩×2%', interval: 20, fraction: 0.02 },
    { label: '100歩×10%', interval: 100, fraction: 0.1 },
    { label: '500歩×50%', interval: 500, fraction: 0.5 },
    { label: '800歩×80%', interval: 800, fraction: 0.8 },
    { label: '900歩×90%', interval: 900, fraction: 0.9 },
  ];

  const conds: { label: string; d?: WorldConfig['disturbance'] }[] = [
    { label: 'なし', },
    ...LUMPS.map((l) => ({
      label: `${l.label} 草食2種`,
      d: { interval: l.interval, fraction: l.fraction, species: BOTH_GRAZERS },
    })),
    ...LUMPS.map((l) => ({
      label: `${l.label} 在来のみ`,
      d: { interval: l.interval, fraction: l.fraction, species: RESIDENT_ONLY },
    })),
  ];

  /**
   * 投入時の在来個体数のビン。走行ごとの平均に対する比なので、
   * 走行間の水準差は落ちている（12 と同じ扱い）。
   */
  const BINS = [0, 0.5, 0.75, 1.0, 1.5];

  /**
   * ビンごとに「そのビンに入った投入の割合」と「そのビンでの定着率」を並べる。
   *
   * **条件間の差がどちらから来ているかを分けるための表。** 同じビンの中で
   * 定着率が揃っているなら、世界間の差は「谷に当たる頻度」だけで説明できる。
   * ビンの中でも差が残るなら、同じ深さの谷でも通りやすさが違うことになる。
   */
  const depthLine = (label: string, v: Invasion): void => {
    const bins = BINS.map(() => ({ n: 0, e: 0 }));
    for (const a of v.all) {
      const x = a.ratio[0];
      let b = 0;
      while (b < BINS.length - 1 && x >= BINS[b + 1]) b++;
      bins[b].n++;
      if (a.established) bins[b].e++;
    }
    const total = v.all.length;
    const cells = bins
      .map((b) =>
        b.n > 0
          ? `${((b.n / total) * 100).toFixed(0)}%→${((b.e / b.n) * 100).toFixed(0)}%`
          : '—',
      )
      .map((s) => s.padStart(10))
      .join('');
    console.log(`  ${label.padEnd(20)}${cells}`);
  };

  // 12 と同じ校正点。中立は「有利さゼロでも通ってしまう率」、
  // 不利は「局所最適から抜けるのに要る、選択に逆らう通過」に対応する
  const CALIB: [string, number][] = [
    ['中立 0.60', 0.6],
    ['不利 0.63', 0.63],
  ];
  const byCalib: Invasion[][] = [];

  for (const [label, met] of CALIB) {
    console.log(`\n  [${label}]`);
    const vs: Invasion[] = [];
    for (const c of conds) {
      const v = await invade(() => cfgOf(met, c.d), { ...BASE, seeds: SEEDS_8 });
      const r = v.resident[0];
      // 最小/平均は谷の深さ。変動係数は谷と山を区別しないので、両方出す
      invasionLine(
        `${c.label} cv${r.cv.toFixed(3)} 在来${r.mean.toFixed(0)} 谷${(r.min / r.mean).toFixed(2)}`,
        v,
      );
      vs.push(v);
    }
    byCalib.push(vs);
  }

  // -------------------------------------------------------------------------
  header('節8 差は「谷の深さ」か「谷に当たる頻度」か');

  /**
   * 節7 の表では、変動係数が同じでも定着率が違う対がありうる。
   * 変動係数は谷と山を区別しないので、揺らぎの代弁者としては粗い。
   *
   * ここでは投入時の在来個体数で分ける。**各ビンの中で定着率が揃っていれば、
   * 世界間の差は「谷に当たる頻度」だけで説明がつく。** 揺らぎの量そのものが
   * 効いているのではなく、谷という同じ機会がどれだけ訪れるかの違いになる。
   */
  console.log(`  ${'条件'.padEnd(18)}${BINS.map((lo, i) =>
    `${lo.toFixed(2)}〜${i < BINS.length - 1 ? BINS[i + 1].toFixed(2) : '∞'}`.padStart(10),
  ).join('')}`);
  console.log('  （各セルは 投入の割合→そのビンでの定着率）');
  CALIB.forEach(([label], k) => {
    console.log(`\n  [${label}]`);
    conds.forEach((c, i) => depthLine(c.label, byCalib[k][i]));
  });
}

await done(t0);
