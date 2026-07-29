import { presetByKey } from '../../../src/core/presets.ts';
import { group, line, header, done, SEEDS } from './_lib.ts';

/**
 * レポート07: 空腹度と、速度差に頼らない追跡
 *
 *   node docs/reports/scripts/07-hunger.ts
 *
 * 03で「追跡には速度差と捕獲成功率の両方が要る」と結論した。速度差が要るのは、
 * 逃走が最優先で捕食者が見えている限り餌を探さないため、等速だと遭遇が
 * 一度も起きないから。空腹時に採餌を優先させると、この前提が外れる。
 *
 * 視野ありで重いので並列に回す（worker 数は SWEEP_WORKERS で変えられる）。
 */

const t0 = performance.now();
const SEEDS_8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];

/** 追跡構成をいじる。cSpeed 既定1 = 速度差なし */
function cfgOf(o: { hunger?: number; cap?: number; cSpeed?: number }) {
  const cfg = presetByKey('pursuit').build();
  cfg.species[0].hungerThreshold = o.hunger ?? 0;
  cfg.species[1].speed = o.cSpeed ?? 1;
  cfg.species[1].captureRate = o.cap ?? 0.1;
  return cfg;
}

header('対照: 速度差なし・空腹なしでは成功率をいくら上げても餓死する');
await group(
  [0.04, 0.2, 0.5, 1.0],
  (cap) => cfgOf({ cap }),
  (cap, t) => line(`成功率${cap}`, t, { range: false }),
  { seeds: SEEDS },
);

header(`空腹閾値を振る（速度差なし・成功率0.1 / ${SEEDS.length}シード）`);
await group(
  [0, 2, 3, 4, 6, 8, 10, 12, 15, 20],
  (h) => cfgOf({ hunger: h }),
  (h, t) => line(`空腹閾値${h}`, t),
  { seeds: SEEDS },
);

header('空腹閾値と捕獲成功率の効き方は対称ではない（速度差なし）');
await group(
  [
    [4, 0.05],
    [4, 0.1],
    [4, 0.2],
    [4, 0.4],
    [8, 0.05],
    [8, 0.1],
    [8, 0.2],
    [8, 0.4],
    [12, 0.05],
    [12, 0.1],
    [12, 0.2],
    [12, 0.4],
  ] as const,
  ([h, cap]) => cfgOf({ hunger: h, cap }),
  ([h, cap], t) => line(`閾値${String(h).padStart(2)} 成功率${cap}`, t, { range: false }),
  { seeds: SEEDS },
);

header('対照: 速度差がある既定の追跡構成では空腹の効果は小さい');
await group(
  [0, 4, 8, 12],
  (h) => cfgOf({ hunger: h, cap: 0.04, cSpeed: 2 }),
  (h, t) => line(`空腹閾値${h}（速度2・成功率0.04）`, t, { range: false }),
  { seeds: SEEDS },
);

header(`採用値の確認（${SEEDS_8.length}シード）`);
await group(
  [
    [6, 0.1],
    [8, 0.1],
    [10, 0.1],
  ] as const,
  ([h, cap]) => cfgOf({ hunger: h, cap }),
  ([h, cap], t) => line(`閾値${h} 成功率${cap}`, t),
  { seeds: SEEDS_8 },
);

done(t0);
