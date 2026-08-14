import type { SpeciesDef, WorldConfig } from './types.ts';

/** 種の定義。指定しなかった項目は無難な既定値で埋める */
function animal(
  p: Partial<SpeciesDef> & Pick<SpeciesDef, 'id' | 'name' | 'color'>,
): SpeciesDef {
  return {
    eatsGrass: false,
    preys: [],
    metabolism: 0.6,
    // 既定では行動は無料。コストを入れるのは「燃費」構成だけ
    speedCost: 0,
    visionCost: 0,
    gainFromGrass: 0,
    gainFromPrey: 0,
    captureRate: 1,
    reproduceThreshold: 20,
    reproduceProb: 0.08,
    reproduceCost: 0.5,
    speed: 1,
    visionRange: 0,
    // 既定では空腹にならない。捕食者が見えている限り逃げ続ける
    hungerThreshold: 0,
    maxAge: 0,
    // 既定では死骸は消える。閉じたループにするのは「還元」を測るときだけ
    corpseGrass: 0,
    corpseSpread: 0,
    initialCount: 100,
    initialEnergy: 15,
    ...p,
  };
}

function world(species: SpeciesDef[], overrides: Partial<WorldConfig> = {}): WorldConfig {
  return {
    width: 120,
    height: 90,
    seed: 12345,
    maxAgents: 60000,
    grass: { max: 8, regrow: 0.06, initialRatio: 0.5 },
    species,
    ...overrides,
  };
}

export interface Preset {
  key: string;
  label: string;
  description: string;
  build(): WorldConfig;
}

/**
 * 草食動物の平衡個体数は概ね `草の回復速度 × セル数 ÷ 代謝`。
 * 既定の環境（0.06 × 10800）なら、代謝0.6の草食で約1080。
 * 捕食者は「獲物の密度 × 捕食利得 > 自分の代謝」を満たす必要がある。
 * 以下のパラメータはこの2つの目安から置いて、実際に回して調整したもの。
 */
export const presets: Preset[] = [
  {
    key: 'basic',
    label: '基本（3層）',
    description: '草 → 草食 → 肉食。捕食利得を上げるほど振動が激しくなる。',
    build: () =>
      world([
        animal({
          id: 1,
          name: '草食動物',
          color: '#5ec8f2',
          eatsGrass: true,
          metabolism: 0.6,
          gainFromGrass: 4,
          reproduceThreshold: 20,
          reproduceProb: 0.08,
          initialCount: 400,
        }),
        animal({
          id: 2,
          name: '肉食動物',
          color: '#f2615e',
          preys: [1],
          metabolism: 0.6,
          gainFromPrey: 18,
          reproduceThreshold: 40,
          reproduceProb: 0.06,
          initialCount: 40,
          initialEnergy: 25,
        }),
      ]),
  },

  {
    key: 'keystone',
    label: '競合（キーストーン捕食）',
    description:
      '草食2種が同じ草を奪い合う。肉食は強い方だけを食べる。' +
      '捕食者を消す（初期個体数0でリセット）と草食Bは絶滅し、Aが1300近くまで独占する。' +
      '捕食者がAを抑えている間だけBが生き残れる。',
    build: () =>
      world([
        animal({
          id: 1,
          name: '草食A（強）',
          color: '#5ec8f2',
          eatsGrass: true,
          metabolism: 0.5,
          gainFromGrass: 4,
          reproduceThreshold: 20,
          reproduceProb: 0.09,
          initialCount: 300,
        }),
        animal({
          id: 2,
          name: '草食B（弱）',
          color: '#c9a5f2',
          eatsGrass: true,
          metabolism: 0.62,
          gainFromGrass: 4,
          reproduceThreshold: 20,
          reproduceProb: 0.075,
          initialCount: 300,
        }),
        animal({
          id: 3,
          name: '肉食（Aのみ捕食）',
          color: '#f2615e',
          preys: [1],
          metabolism: 0.6,
          gainFromPrey: 20,
          reproduceThreshold: 40,
          reproduceProb: 0.06,
          initialCount: 40,
          initialEnergy: 25,
        }),
      ]),
  },

  {
    key: 'omnivore',
    label: '雑食',
    description:
      '雑食は草も草食動物も食べる。獲物がいれば捕食し、いなければ草を食べる。' +
      '採食量が自分の代謝(0.7)を超えると草だけで黒字になり、狩る必要がなくなって' +
      '草食動物を競争排除してしまう。0.4に抑えて草を「飢え死に防止」に留めてある。',
    build: () =>
      world([
        animal({
          id: 1,
          name: '草食動物',
          color: '#5ec8f2',
          eatsGrass: true,
          metabolism: 0.6,
          gainFromGrass: 4,
          reproduceThreshold: 20,
          reproduceProb: 0.08,
          initialCount: 400,
        }),
        animal({
          id: 2,
          name: '雑食動物',
          color: '#f2a93f',
          eatsGrass: true,
          preys: [1],
          metabolism: 0.7,
          // 代謝より小さくすること。上回ると草だけで増えられてしまう
          gainFromGrass: 0.4,
          gainFromPrey: 18,
          reproduceThreshold: 40,
          reproduceProb: 0.05,
          initialCount: 60,
          initialEnergy: 25,
        }),
      ]),
  },

  {
    key: 'fourtier',
    label: '4層',
    description:
      '草 → 草食 → 中位捕食者 → 頂点捕食者。おおよそ 760 / 390 / 130 のピラミッドになる。' +
      '頂点は生存の限界付近にいて、代謝を0.65まで上げると絶滅する。',
    build: () =>
      world([
        animal({
          id: 1,
          name: '草食動物',
          color: '#5ec8f2',
          eatsGrass: true,
          metabolism: 0.55,
          gainFromGrass: 4,
          reproduceThreshold: 18,
          reproduceProb: 0.09,
          initialCount: 500,
        }),
        animal({
          id: 2,
          name: '中位捕食者',
          color: '#f2a93f',
          preys: [1],
          metabolism: 0.45,
          gainFromPrey: 16,
          reproduceThreshold: 32,
          reproduceProb: 0.06,
          initialCount: 80,
          initialEnergy: 20,
        }),
        animal({
          id: 3,
          name: '頂点捕食者',
          color: '#f2615e',
          preys: [2],
          // 下げすぎると餌に制約されなくなり、中位捕食者より多い逆ピラミッドになる
          metabolism: 0.55,
          gainFromPrey: 26,
          reproduceThreshold: 45,
          reproduceProb: 0.05,
          initialCount: 25,
          initialEnergy: 30,
        }),
      ]),
  },
];

presets.push({
  key: 'pursuit',
  label: '追跡（視野あり）',
  description:
    '草食は視野2で捕食者を見つけると逃げ、肉食は視野3で獲物を追う。' +
    '肉食は速度2で速いが、襲いかかっても成功するのは25回に1回。' +
    '速度差と捕獲成功率のどちらを外しても成立しない（README参照）。',
  build: () =>
    world([
      animal({
        id: 1,
        name: '草食動物',
        color: '#5ec8f2',
        eatsGrass: true,
        metabolism: 0.6,
        gainFromGrass: 4,
        reproduceThreshold: 20,
        reproduceProb: 0.08,
        speed: 1,
        visionRange: 2,
        initialCount: 400,
      }),
      animal({
        id: 2,
        name: '肉食動物',
        color: '#f2615e',
        preys: [1],
        metabolism: 0.6,
        gainFromPrey: 18,
        // 追跡が決定的なので、確率を入れないと「全く捕れない」か「捕り尽くす」の二択になる
        captureRate: 0.04,
        reproduceThreshold: 40,
        reproduceProb: 0.06,
        speed: 2,
        visionRange: 3,
        initialCount: 40,
        initialEnergy: 25,
      }),
    ]),
});

presets.push({
  key: 'upkeep',
  label: '燃費（行動コストあり）',
  description:
    '草食2種の違いは視野だけ。警戒型は捕食者を見て逃げられるが実効代謝0.475、' +
    '無警戒型は逃げられない代わりに0.40で済む。既定では警戒型がわずかに勝つ（519 対 450）が、' +
    '肉食の初期個体数を0にすると逆転して無警戒型が倍以上に増える（477 対 1056）。' +
    '視野コストを0.03に上げるだけでも逆転する。',
  build: () =>
    world([
      animal({
        id: 1,
        name: '草食・警戒型',
        color: '#5ec8f2',
        eatsGrass: true,
        metabolism: 0.25,
        speedCost: 0.15,
        visionCost: 0.025,
        gainFromGrass: 4,
        reproduceThreshold: 20,
        reproduceProb: 0.08,
        speed: 1,
        visionRange: 3, // 実効代謝 0.25 + 0.15 + 0.075 = 0.475
        initialCount: 300,
      }),
      animal({
        id: 2,
        name: '草食・無警戒型',
        color: '#c9a5f2',
        eatsGrass: true,
        metabolism: 0.25,
        speedCost: 0.15,
        visionCost: 0.025,
        gainFromGrass: 4,
        reproduceThreshold: 20,
        reproduceProb: 0.08,
        speed: 1,
        visionRange: 0, // 実効代謝 0.25 + 0.15 = 0.40
        initialCount: 300,
      }),
      animal({
        id: 3,
        name: '肉食動物',
        color: '#f2615e',
        preys: [1, 2],
        metabolism: 0.2,
        speedCost: 0.15,
        visionCost: 0.025,
        gainFromPrey: 18,
        captureRate: 0.04,
        reproduceThreshold: 40,
        reproduceProb: 0.06,
        speed: 2,
        visionRange: 3, // 実効代謝 0.2 + 0.3 + 0.075 = 0.575
        initialCount: 40,
        initialEnergy: 25,
      }),
    ]),
});

presets.push({
  key: 'evolution',
  label: '進化（速度が遺伝する）',
  description:
    '草食動物の移動速度が個体ごとに違い、子は親の速度をわずかにずらして受け継ぐ。' +
    '速いほど実効代謝が上がるので、速度は釣り合う位置に落ち着く。' +
    '既定では初期速度1から約2.7まで上がるが、肉食の初期個体数を0にしてリセットすると' +
    '逆に約1.1まで下がる。速い足の価値は捕食圧が生んでいる（README参照）。',
  build: () =>
    world([
      animal({
        id: 1,
        name: '草食動物',
        color: '#5ec8f2',
        eatsGrass: true,
        metabolism: 0.25,
        speedCost: 0.15,
        gainFromGrass: 4,
        reproduceThreshold: 20,
        reproduceProb: 0.08,
        // 視野を持たせない。捕食者を見て逃げられると速い足の出番が無くなる
        speed: 1,
        visionRange: 0,
        mutation: { speedSigma: 0.05, speedMin: 0, speedMax: 4 },
        initialCount: 400,
      }),
      animal({
        id: 2,
        name: '肉食動物',
        color: '#f2615e',
        preys: [1],
        metabolism: 0.2,
        speedCost: 0.15,
        visionCost: 0.025,
        gainFromPrey: 18,
        captureRate: 0.04,
        reproduceThreshold: 40,
        reproduceProb: 0.06,
        speed: 2,
        visionRange: 3,
        initialCount: 40,
        initialEnergy: 25,
      }),
    ]),
});

presets.push({
  key: 'hunger',
  label: '空腹（速度差なし）',
  description:
    '追跡構成から速度差を取り、代わりに草食に空腹閾値8を与えたもの。' +
    '腹が減った個体は捕食者が見えていても餌を探しに出るので、等速でも遭遇が起きる。' +
    '空腹閾値を0にすると（速度差が無いので）肉食は必ず餓死する。',
  build: () =>
    world([
      animal({
        id: 1,
        name: '草食動物',
        color: '#5ec8f2',
        eatsGrass: true,
        metabolism: 0.6,
        gainFromGrass: 4,
        reproduceThreshold: 20,
        reproduceProb: 0.08,
        speed: 1,
        visionRange: 2,
        // 繁殖閾値20に対して8。空腹の個体だけが逃走をやめて採餌に出る
        hungerThreshold: 8,
        initialCount: 400,
      }),
      animal({
        id: 2,
        name: '肉食動物',
        color: '#f2615e',
        preys: [1],
        metabolism: 0.6,
        gainFromPrey: 18,
        // 速度差が無いぶん遭遇が減るので、追跡構成の0.04より高くしないと足りない
        captureRate: 0.1,
        reproduceThreshold: 40,
        reproduceProb: 0.06,
        speed: 1,
        visionRange: 3,
        initialCount: 40,
        initialEnergy: 25,
      }),
    ]),
});

presets.push({
  key: 'vision',
  label: '進化（視野が遺伝する）',
  description:
    '「燃費」構成の草食2種を1種に畳んで、視野を個体ごとの遺伝形質にしたもの。' +
    'パラメータは燃費構成の草食とまったく同じなので、視野0の個体は無警戒型（実効代謝0.40）、' +
    '視野3の個体は警戒型（0.475）にぴったり一致する。' +
    '21 が「視野の有無が2本目のニッチ軸を作っている」ところまで出したので、' +
    'その軸が変異から出てくるか——集団が二山に割れるか——を見るための構成。',
  build: () =>
    world([
      animal({
        id: 1,
        name: '草食動物',
        color: '#5ec8f2',
        eatsGrass: true,
        // 以下は upkeep の草食2種と同一。視野だけが個体ごとに動く
        metabolism: 0.25,
        speedCost: 0.15,
        visionCost: 0.025,
        gainFromGrass: 4,
        reproduceThreshold: 20,
        reproduceProb: 0.08,
        // 速度は固定する。軸は1本ずつ足す（速度は 10 で測り終えている）
        speed: 1,
        visionRange: 0,
        // σは 10 の速度と同じ値。上限5は「代償があれば張り付かない」ことを
        // 示せるだけの高さで、これ以上は走査が (2r+1)^2 で重くなるだけ
        visionMutation: { sigma: 0.05, min: 0, max: 5 },
        // upkeep の草食2種の合計に合わせる
        initialCount: 600,
      }),
      // upkeep・evolution とまったく同じ肉食。捕食圧の条件を揃えるため
      animal({
        id: 2,
        name: '肉食動物',
        color: '#f2615e',
        preys: [1],
        metabolism: 0.2,
        speedCost: 0.15,
        visionCost: 0.025,
        gainFromPrey: 18,
        captureRate: 0.04,
        reproduceThreshold: 40,
        reproduceProb: 0.06,
        speed: 2,
        visionRange: 3,
        initialCount: 40,
        initialEnergy: 25,
      }),
    ]),
});

presets.push({
  key: 'tworesource',
  label: '資源2本（ニッチ分割）',
  description:
    '草を2本の資源に分ける（総生産量と総容量は固定）。草食3種は採食の配分だけが違い、' +
    'A専門・汎用・B専門が同じ世界を分け合う。専門型2種だけなら共存し、' +
    '個体数は供給比に従う（A=0.5で808対809）。' +
    'ただし汎用型を30体入れるだけで専門型は両方とも絶滅する。',
  build: () =>
    world(
      [1, 0.5, 0].map((pA, k) =>
        animal({
          id: k + 1,
          name: ['草食・A専門', '草食・汎用', '草食・B専門'][k],
          color: ['#5ec8f2', '#c9a5f2', '#7fd6a0'][k],
          eatsGrass: true,
          resourceA: pA,
          // 視野0・行動コスト0にしてある。軸は採食の配分1本だけ
          metabolism: 0.4,
          gainFromGrass: 4,
          reproduceThreshold: 20,
          reproduceProb: 0.08,
          initialCount: 300,
        }),
      ),
      { grass: { max: 8, regrow: 0.06, initialRatio: 0.5, split: { supplyA: 0.5 } } },
    ),
});

presets.push({
  key: 'coexist',
  label: '共存（捕食者なし）',
  description:
    '「燃費」構成から肉食を抜いただけ。21 が「これは本物の共存だ」と確かめた構成で、' +
    '30000ステップ・8シードで 478 対 1055 に収束し、相互侵入がどちらの向きにも通る。' +
    '軸は視野の有無で、無警戒型は94%の歩で 0.423 ずつ、警戒型は46%の歩で 1.032 ずつ食べる' +
    '——同じ草の違う統計量に制限されている。計器の「採食」欄でその内訳が見える。',
  build: () => {
    const cfg = presetByKey('upkeep').build();
    // 17 と同じく配列ごと外す。0体で残すと絶滅として数えられて、
    // 02 の検証スクリプトが「崩壊した」と読む。
    // **0体で残す場合と結果はビット単位で一致する**——個体が1体もいない種は
    // 乱数を1つも引かず、捕食者を探す走査も空振りするだけなので
    // （26・27 のスクリプトは 0体で残す書き方だが、動くものは同じ）
    cfg.species = cfg.species.filter((s) => s.id !== 3);
    return cfg;
  },
});

presets.push({
  key: 'window',
  label: '共存の窓（視野を手で置く）',
  description:
    '上の共存構成で、草食2種の視野を軸の上の好きな2点に置けるようにしたもの（26・27）。' +
    '既定は 警戒型3.00 / 無警戒型0.25 で、30000ステップ・8シードで 267 対 1284 に落ち着く' +
    '（相互侵入もどちらの向きにも通る）。' +
    '無警戒型の視野を 0.60 まで上げると共存は消え、警戒型を 0.95 まで下げても消える。' +
    '窓は「低い側 ≦ 0.55〜0.60 かつ 高い側 ≧ 0.95〜1.00」。' +
    '1種だけを進化させた着地点 0.80 はその窓の外にあり、両端とも内側へ動く。',
  build: () => {
    const cfg = presetByKey('upkeep').build();
    cfg.species = cfg.species.filter((s) => s.id !== 3); // 上と同じ理由
    // 端数の視野を使うには visionMutation が要る。無いと定義値がそのまま
    // 走査半径の添字に入るので、非整数だと壊れる。σ=0 なので値は動かないが、
    // 子1体につき正規乱数を1つ引く——**両種で同じ**なので比較は公平（26 と同じ扱い）
    for (const herb of [cfg.species[0], cfg.species[1]]) {
      herb.visionMutation = { sigma: 0, min: 0, max: 5 };
    }
    cfg.species[0].visionRange = 3.0; // 警戒型（高い側）
    cfg.species[1].visionRange = 0.25; // 無警戒型（低い側）
    return cfg;
  },
});

presets.push({
  key: 'infection',
  label: '感染症（負の頻度依存）',
  description:
    '競合構成から肉食を抜き、代わりに接触で伝わる病気を入れたもの（17）。' +
    '見ているのは「同じセルに感染個体が何体いるか」だけで、種の個体数はコードに出てこない。' +
    'それでも多いほうだけが病気を抱え込むので共存する（A 701 / B 345）。' +
    '伝染範囲を「全種」にすると同じ機構・同じつまみのまま共存が消える' +
    '——しかもそちらのほうが多く殺している。効いているのは死の量ではなく死の向き。',
  build: () => {
    const cfg = presetByKey('keystone').build();
    // 15・16・17 と同じ扱い。捕食者は配列ごと外す（0体で残すと絶滅として数えられる）
    cfg.species = cfg.species.filter((s) => s.id !== 3);
    for (const s of cfg.species) {
      // 致死性0.02は内点の山。弱いと蔓延しても打撃が足りず、強いと宿主を
      // 殺すのが早すぎて病原体が維持できない（17 節3）
      s.infection = {
        transmit: 0.8,
        lethality: 0.02,
        recover: 0,
        // 病原体が絶えた種への再着火用。密度に依存しない死なので最小限にする
        spontaneous: 0.0002,
        initial: 0.05,
        scope: 'self',
      };
    }
    return cfg;
  },
});

export function presetByKey(key: string): Preset {
  const p = presets.find((x) => x.key === key);
  if (!p) throw new Error(`不明なプリセット: ${key}`);
  return p;
}

export function defaultConfig(): WorldConfig {
  return presets[0].build();
}
