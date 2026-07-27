import { World } from './world.ts';

/**
 * 1ステップ進める。
 *
 * 順序に意味がある：
 *   草回復 → 移動 → 空間インデックス構築 → 捕食/採食 → 代謝と寿命 → 死亡個体を除去 → 繁殖
 *
 * 移動してからインデックスを作るので、捕食判定は「移動後に同じセルにいるか」になる。
 */
export function step(w: World): void {
  regrowGrass(w);
  moveAgents(w);
  w.buildSpatialIndex();
  feed(w);
  metabolize(w);
  w.compact();
  reproduce(w);
  w.stepCount++;
}

/**
 * 草は各セルで一定量ずつ回復し、上限で頭打ちになる。
 *
 * パッチがある場合はセルごとの倍率を掛ける。倍率の平均は1なので名目の生産量は
 * 変わらないが、豊かなセルほど上限に張り付いて回復ぶんを捨てるため、
 * **実際に入るエネルギーは一様な場合より少なくなる**。
 * その差を w.grassAdded に記録しておく。
 */
function regrowGrass(w: World): void {
  w.syncGrassWeight();

  const grass = w.grass;
  const max = w.config.grass.max;
  const rate = w.config.grass.regrow;
  let added = 0;

  if (!w.grassPatched) {
    for (let c = 0; c < w.cells; c++) {
      const before = grass[c];
      const g = before + rate;
      if (g > max) {
        added += max - before;
        grass[c] = max;
      } else {
        added += rate;
        grass[c] = g;
      }
    }
  } else {
    const weight = w.grassWeight;
    for (let c = 0; c < w.cells; c++) {
      const before = grass[c];
      const g = before + rate * weight[c];
      if (g > max) {
        added += max - before;
        grass[c] = max;
      } else {
        added += g - before;
        grass[c] = g;
      }
    }
  }

  w.grassAdded = added;
}

/** 端は反対側につながる（トーラス）。壁にすると端に個体が溜まって分布が歪む */
function wrap(v: number, n: number): number {
  const m = v % n;
  return m < 0 ? m + n : m;
}

// 視界スキャンの結果を返すための置き場。毎ステップ数千回呼ぶのでオブジェクトは作らない
let scanDx = 0;
let scanDy = 0;

/**
 * 視界内で bits に含まれる種がいる最も近いセルを探す。
 * 見つかれば true を返し、scanDx/scanDy に相対位置が入る。
 */
function findNearest(w: World, x: number, y: number, bits: number, r: number): boolean {
  let bestD2 = Infinity;
  let ties = 0;

  for (let oy = -r; oy <= r; oy++) {
    const row = wrap(y + oy, w.height) * w.width;
    for (let ox = -r; ox <= r; ox++) {
      if (ox === 0 && oy === 0) continue;
      if ((w.cellSpecies[row + wrap(x + ox, w.width)] & bits) === 0) continue;

      const d2 = ox * ox + oy * oy;
      if (d2 < bestD2) {
        bestD2 = d2;
        ties = 1;
        scanDx = ox;
        scanDy = oy;
      } else if (d2 === bestD2) {
        // 同距離の候補から等確率で選ぶ。走査順で決めると方向が偏る
        ties++;
        if (w.rng.next() * ties < 1) {
          scanDx = ox;
          scanDy = oy;
        }
      }
    }
  }
  return ties > 0;
}

/**
 * 視界内で今いるセルより草が多いセルのうち、最も近いものを探す。
 *
 * 「最も草が多いセル」を選ばせると、視界を共有する個体が同じ1マスに殺到して
 * 着いた瞬間に食い尽くす群れができ、他の場所の草が手つかずのまま個体数が落ちる。
 * 近くの十分な草で満足させることで群れが散る。
 *
 * 同点はランダムに選ぶ。未採食のセルは軒並み上限値で並ぶため、走査順で決めると
 * 群れ全体が同じ方向へ流れる波になってしまう。
 */
function findGrass(w: World, x: number, y: number, r: number, current: number): boolean {
  let bestD2 = Infinity;
  let bestG = 0;
  let ties = 0;

  for (let oy = -r; oy <= r; oy++) {
    const row = wrap(y + oy, w.height) * w.width;
    for (let ox = -r; ox <= r; ox++) {
      if (ox === 0 && oy === 0) continue;
      const g = w.grass[row + wrap(x + ox, w.width)];
      if (g <= current) continue;

      const d2 = ox * ox + oy * oy;
      if (d2 < bestD2 || (d2 === bestD2 && g > bestG)) {
        bestD2 = d2;
        bestG = g;
        ties = 1;
        scanDx = ox;
        scanDy = oy;
      } else if (d2 === bestD2 && g === bestG) {
        ties++;
        if (w.rng.next() * ties < 1) {
          scanDx = ox;
          scanDy = oy;
        }
      }
    }
  }
  return ties > 0;
}

/** d の方向へ最大 speed セル進む */
function toward(d: number, speed: number): number {
  if (d > 0) return d < speed ? d : speed;
  if (d < 0) return -d < speed ? d : -speed;
  return 0;
}

/**
 * 移動。
 *
 * 視界を持つ種がいる場合は種インデックス順（下位の獲物 → 上位の捕食者）に動かし、
 * 視界を使う種の手番の前に空間インデックスを作り直す。
 * こうしないと捕食者が「獲物が去った後のセル」を狙い続けることになり、
 * 追跡がランダムウォークより当たらなくなる。
 */
function moveAgents(w: World): void {
  if (!w.anyVision) {
    for (let i = 0; i < w.count; i++) moveOne(w, i);
    return;
  }

  for (let s = 0; s < w.defs.length; s++) {
    if (w.defs[s].visionRange > 0) w.buildSpatialIndex();
    for (let i = 0; i < w.count; i++) {
      if (w.aSpecies[i] === s) moveOne(w, i);
    }
  }
}

/**
 * 1個体の移動先を決める。視界を持つなら
 *   捕食者から逃げる → 獲物を追う → 草の多い方へ → ランダム
 * の優先順。
 */
function moveOne(w: World, i: number): void {
  const si = w.aSpecies[i];
  const def = w.defs[si];
  const speed = def.speed;
  if (speed === 0) return;

  const x = w.aX[i];
  const y = w.aY[i];
  const r = def.visionRange;
  let dx = 0;
  let dy = 0;
  let decided = false;

  if (r > 0) {
    // 逃走が最優先。捕食者が見えている間は餌を探さない
    if (w.predatorBits[si] !== 0 && findNearest(w, x, y, w.predatorBits[si], r)) {
      dx = toward(-scanDx, speed);
      dy = toward(-scanDy, speed);
      decided = true;
    } else if (w.preyBits[si] !== 0 && findNearest(w, x, y, w.preyBits[si], r)) {
      dx = toward(scanDx, speed);
      dy = toward(scanDy, speed);
      decided = true;
    } else if (def.eatsGrass && findGrass(w, x, y, r, w.grass[y * w.width + x])) {
      dx = toward(scanDx, speed);
      dy = toward(scanDy, speed);
      decided = true;
    }
  }

  if (!decided) {
    dx = w.rng.intRange(-speed, speed);
    dy = w.rng.intRange(-speed, speed);
  }

  w.aX[i] = wrap(x + dx, w.width);
  w.aY[i] = wrap(y + dy, w.height);
}

/**
 * 同じセルにいる相手を捕食し、捕食しなかった草食動物はそのセルの草を食べる。
 *
 * 処理順は毎ステップシャッフルする。配列順のまま回すと、
 * 添字の若い個体が always 先に餌を取る偏りが出るため。
 */
function feed(w: World): void {
  const nSpecies = w.defs.length;
  const order = w.order;
  const count = w.count;

  for (let i = 0; i < count; i++) order[i] = i;
  w.rng.shuffle(order, count);

  for (let k = 0; k < count; k++) {
    const i = order[k];
    if (w.aAlive[i] === 0) continue;

    const si = w.aSpecies[i];
    const def = w.defs[si];
    const c = w.aY[i] * w.width + w.aX[i];
    let ate = false;

    if (w.isPredator[si] === 1) {
      const end = w.cellStart[c + 1];
      for (let p = w.cellStart[c]; p < end; p++) {
        const j = w.cellAgents[p];
        if (j === i || w.aAlive[j] === 0) continue;
        if (w.preyMask[si * nSpecies + w.aSpecies[j]] === 0) continue;

        // captureRate が 1 のときは乱数を消費しない（既存の構成の結果を変えないため）
        if (def.captureRate >= 1 || w.rng.chance(def.captureRate)) {
          w.aAlive[j] = 0;
          w.aEnergy[i] += def.gainFromPrey;
          ate = true;
        }
        break; // 成否によらず、1ステップの狩りは1回
      }
    }

    // 獲物を捕らえた個体はその上さらに草を食べない
    if (!ate && def.eatsGrass) {
      const avail = w.grass[c];
      if (avail > 0) {
        const eaten = avail < def.gainFromGrass ? avail : def.gainFromGrass;
        w.grass[c] = avail - eaten;
        w.aEnergy[i] += eaten;
      }
    }
  }
}

function metabolize(w: World): void {
  // 行動コストを含めた実効値を種ごとに1回だけ求める。
  // スライダーで即時に変わるので毎ステップ引き直すが、種数ぶんなので安い
  const cost = w.effMetabolism;
  for (let s = 0; s < w.defs.length; s++) cost[s] = w.effectiveMetabolism(s);

  for (let i = 0; i < w.count; i++) {
    if (w.aAlive[i] === 0) continue;
    const si = w.aSpecies[i];
    const def = w.defs[si];

    w.aEnergy[i] -= cost[si];
    if (w.aEnergy[i] <= 0) {
      w.aAlive[i] = 0;
      continue;
    }

    const age = w.aAge[i] + 1;
    w.aAge[i] = age;
    if (def.maxAge > 0 && age >= def.maxAge) w.aAlive[i] = 0;
  }
}

function reproduce(w: World): void {
  // 生まれた子をその場で走査対象にしないよう、開始時点の個体数で止める
  const n = w.count;
  for (let i = 0; i < n; i++) {
    const si = w.aSpecies[i];
    const def = w.defs[si];
    if (w.aEnergy[i] < def.reproduceThreshold) continue;
    if (!w.rng.chance(def.reproduceProb)) continue;

    const childEnergy = w.aEnergy[i] * def.reproduceCost;
    if (w.spawn(si, w.aX[i], w.aY[i], childEnergy)) {
      w.aEnergy[i] -= childEnergy;
    }
  }
}
