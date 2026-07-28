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
    maxAge: 0,
    // 既定では死骸は消える。閉じたループにするのは「還元」を測るときだけ
    corpseGrass: 0,
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

export function presetByKey(key: string): Preset {
  const p = presets.find((x) => x.key === key);
  if (!p) throw new Error(`不明なプリセット: ${key}`);
  return p;
}

export function defaultConfig(): WorldConfig {
  return presets[0].build();
}
