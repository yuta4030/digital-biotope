import { World } from './world.ts';
import type { SpeciesDef } from './types.ts';

/**
 * 1ステップ進める。
 *
 * 順序に意味がある：
 *   草回復 → 移動 → 空間インデックス構築 → 捕食/採食 → 代謝と寿命 → 大量死
 *   → 死亡個体を除去 → 繁殖
 *
 * 移動してからインデックスを作るので、捕食判定は「移動後に同じセルにいるか」になる。
 * 大量死を代謝の後・除去の前に置いたのは、その手番で死ぬ個体が採食と代謝を
 * 済ませた後に消えるようにするため。繁殖より前なので、死んだ個体は子を残さない。
 */
export function step(w: World): void {
  releaseDetritus(w);
  regrowGrass(w);
  moveAgents(w);
  w.buildSpatialIndex();
  feed(w);
  metabolize(w);
  infection(w);
  crowdingDeath(w);
  massDeath(w);
  w.compact();
  reproduce(w);
  w.stepCount++;
}

/**
 * 接触で伝わる感染症。負の頻度依存を**機構として**書いたもの。
 *
 * 頻度依存を手で書かないのが要点。見るのは「同じセルに感染個体が何体いるか」だけで、
 * 種の個体数はどこにも出てこない。それでも増えた種ほど同型との遭遇が増えるので、
 * 1個体あたりの感染リスクが自分の密度に応じて上がる。
 *
 * 空間インデックスが要るので、buildSpatialIndex より後・compact より前に呼ぶ。
 * feed で食われた個体は aAlive が0になっているが index には残っているので、
 * 伝染源にも感染先にもしない。
 *
 * 処理は3段に分かれている。順序を混ぜると測っているものが変わる：
 *   1. 伝染と自然発生を **aInfectedNext に書く**（このステップの伝染源は増やさない）
 *   2. **その時点で感染していた個体**だけが死亡・回復の抽選を受ける
 *   3. 状態を入れ替える
 *
 * 2 を 1 より後に置いても、読むのは常に古い状態（aInfected）なので、
 * 個体の走査順は結果に影響しない。ここは 03 で3回踏んだ場所なので、
 * 「順番を変えても同じ」が成り立つ形にしてある。
 */
function infection(w: World): void {
  const deaths = w.deathsInfection;
  const byContact = w.infectedByContact;
  const bySpont = w.infectedBySpontaneous;
  deaths.fill(0);
  byContact.fill(0);
  bySpont.fill(0);
  if (!w.anyInfection) return;

  const rng = w.infectionRng;
  const count = w.count;
  const next = w.aInfectedNext;
  const cur = w.aInfected;

  // --- 1. 伝染と自然発生 ---
  for (let i = 0; i < count; i++) {
    next[i] = cur[i];
    if (w.aAlive[i] === 0) continue;

    const si = w.aSpecies[i];
    const inf = w.defs[si].infection;
    if (inf === undefined) continue;
    if (cur[i] === 1) continue; // 既に感染している

    // 同じセルの感染個体を数える。scope が self なら同種だけ
    let k = 0;
    const c = w.aY[i] * w.width + w.aX[i];
    const end = w.cellStart[c + 1];
    for (let p = w.cellStart[c]; p < end; p++) {
      const j = w.cellAgents[p];
      if (j === i || w.aAlive[j] === 0 || cur[j] === 0) continue;
      if (inf.scope === 'self' && w.aSpecies[j] !== si) continue;
      k++;
    }

    if (k > 0 && inf.transmit > 0) {
      // k体それぞれが独立に伝染させる。1回ずつ引くと k に比例して乱数の
      // 消費数が変わるので、まとめて 1 - (1-p)^k で1回だけ引く
      if (rng.chance(1 - Math.pow(1 - inf.transmit, k))) {
        next[i] = 1;
        byContact[si]++;
        continue;
      }
    }
    if (inf.spontaneous > 0 && rng.chance(inf.spontaneous)) {
      next[i] = 1;
      bySpont[si]++;
    }
  }

  // --- 2. 死亡と回復（このステップの頭で感染していた個体だけ） ---
  for (let i = 0; i < count; i++) {
    if (w.aAlive[i] === 0 || cur[i] === 0) continue;
    const si = w.aSpecies[i];
    const inf = w.defs[si].infection;
    if (inf === undefined) continue;

    if (inf.lethality > 0 && rng.chance(inf.lethality)) {
      w.aAlive[i] = 0;
      next[i] = 0;
      deaths[si]++;
      const def = w.defs[si];
      if (def.corpseGrass > 0) dropCorpse(w, def.corpseGrass, def.corpseSpread, w.aX[i], w.aY[i]);
      continue;
    }
    if (inf.recover > 0 && rng.chance(inf.recover)) next[i] = 0;
  }

  // --- 3. 状態の入れ替え ---
  cur.set(next.subarray(0, count));
}

/**
 * 密度に比例した追加の死亡。負の頻度依存を手で書いたもの。
 *
 * 個体数は**このステップの死亡処理を始める前の値**で固定する（compact 前なので
 * countBySpecies がその値を返す）。殺しながら数え直すと、走査順の早い個体ほど
 * 高い密度で抽選されることになり、03 で踏んだ「走査順のバイアスが生態学的な
 * 現象に見える」形の罠がそのまま再現する。
 *
 * 大量死より**前**に置いてある。順序を決めておかないと、両方を有効にしたときに
 * 「大量死で減った後の個体数で密度を計算する」ことになり、2つの軸が掛け算で
 * 絡む。前に置けば密度は大量死の影響を受けない。
 *
 * 乱数は世界本体とも大量死とも別のストリームから引き、crowding を持つ種が
 * 無ければ1つも引かない。既存の構成の乱数列は変わらない。
 */
function crowdingDeath(w: World): void {
  const killed = w.deathsCrowding;
  killed.fill(0);
  if (!w.anyCrowding) return;

  const counts = w.crowdCounts;
  w.countBySpecies(counts);

  let total = 0;
  for (let i = 0; i < counts.length; i++) total += counts[i];

  // 種ごとの死亡確率を先に出しておく。個体ごとに割り算をやり直す必要はない
  const prob = w.crowdProb;
  prob.fill(0);
  for (let si = 0; si < counts.length; si++) {
    const c = w.defs[si].crowding;
    if (c === undefined || c.rate <= 0) continue;
    const n = c.scope === 'self' ? counts[si] : total;
    prob[si] = c.rate * (n / w.cells);
  }

  const rng = w.crowdingRng;
  for (let i = 0; i < w.count; i++) {
    // 既にこのステップで死んでいる個体は数にも乱数にも数えない（大量死と同じ扱い）
    if (w.aAlive[i] === 0) continue;
    const si = w.aSpecies[i];
    const p = prob[si];
    if (p <= 0) continue;
    if (!rng.chance(p)) continue;

    w.aAlive[i] = 0;
    killed[si]++;
    const def = w.defs[si];
    if (def.corpseGrass > 0) dropCorpse(w, def.corpseGrass, def.corpseSpread, w.aX[i], w.aY[i]);
  }
}

/**
 * 無作為な大量死。平均 interval ステップに1回、対象の種の生存個体を
 * fraction の確率で殺す。
 *
 * **形質を一切見ない。** 速度も年齢もエネルギーも参照しないので、速度の利得と
 * 代償の釣り合い（[10](../../docs/reports/10-speed-evolution.md) の丘の位置）には
 * 直接触れない。触るのは個体数だけ。丘を動かさずに谷を作るための軸なので、
 * ここに選択性を入れたらこの軸の意味が無くなる。
 *
 * 乱数は世界本体とは別のストリームから引き、間隔か割合が0なら1つも引かない。
 * 大量死を入れていない構成は、この機構を入れる前と完全に同じ乱数列をたどる。
 *
 * 死骸の還元は餓死・寿命死と同じ扱いにしてある。ただし corpseGrass > 0 の構成で
 * 大量死を使うと、谷を作るのと同時に草へ大量のエネルギーを注ぐことになる
 * （[08](../../docs/reports/08-corpse-recycling.md) で踏んだ交絡と同じ形）。
 * 揺らぎだけを見たいなら還元は0にすること。
 */
function massDeath(w: World): void {
  const killed = w.deathsDisturbance;
  killed.fill(0);

  const d = w.config.disturbance;
  if (d === undefined || d.interval <= 0 || d.fraction <= 0) return;

  const rng = w.disturbanceRng;
  // 等間隔ではなく毎ステップ 1/interval で抽選する。等間隔だと振動と位相が
  // 固定されて、大量死の効果とその位相で叩いた効果が分けられなくなる
  if (!rng.chance(1 / d.interval)) return;

  const target = w.disturbTarget;
  const p = d.fraction;

  for (let i = 0; i < w.count; i++) {
    // 既にこのステップで死んでいる個体は数にも乱数にも数えない
    if (w.aAlive[i] === 0) continue;
    const si = w.aSpecies[i];
    if (target[si] === 0) continue;
    if (!rng.chance(p)) continue;

    w.aAlive[i] = 0;
    killed[si]++;
    const def = w.defs[si];
    if (def.corpseGrass > 0) dropCorpse(w, def.corpseGrass, def.corpseSpread, w.aX[i], w.aY[i]);
  }
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

  const max = w.config.grass.max;
  const rate = w.config.grass.regrow;

  if (!w.twoResources) {
    w.grassAdded = regrowField(w, w.grass, rate, max);
    return;
  }

  // 総生産量と総容量を固定したまま2本に配る。それぞれを rate にすると
  // 入力が2倍になり、06 の豊穣化と区別がつかなくなる
  const share = w.config.grass.split!.supplyA;
  w.grassAdded =
    regrowField(w, w.grass, rate * share, max * share) +
    regrowField(w, w.grassB, rate * (1 - share), max * (1 - share));
}

/** 1本ぶんの回復。資源が1本のときはこれを1回呼ぶだけで従来と同じ計算になる */
function regrowField(w: World, grass: Float32Array, rate: number, max: number): number {
  let added = 0;

  // 上限を超えているセルは伸びも縮みもしない。死骸の還元は上限を超えて積めるので、
  // ここで max に丸めると戻したぶんを取り上げてしまう
  if (!w.grassPatched) {
    for (let c = 0; c < w.cells; c++) {
      const before = grass[c];
      if (before >= max) continue;
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
      if (before >= max) continue;
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

  return added;
}

/**
 * 死骸の在庫を放出率のぶんだけ草に変える。
 *
 * 放出率1なら在庫は毎ステップ空になり、代謝の手番で草に直接足したのと
 * 同じ順序になる（草に入る → 次の回復 の並びが変わらない）。
 * [08](../../docs/reports/08-corpse-recycling.md) の結果はそのまま再現する。
 *
 * 率を下げると在庫が溜まり、流入が均される。**総入力は変えずに
 * 変動係数だけを下げられる**のがこの仕組みの狙い。
 */
function releaseDetritus(w: World): void {
  if (!w.anyCorpse) {
    w.grassFromCorpses = 0;
    return;
  }

  const rate = w.config.grass.detritusRelease ?? 1;
  const det = w.detritus;
  const grass = w.grass;
  let released = 0;

  if (rate >= 1) {
    for (let c = 0; c < w.cells; c++) {
      const d = det[c];
      if (d === 0) continue;
      grass[c] += d;
      det[c] = 0;
      released += d;
    }
  } else {
    for (let c = 0; c < w.cells; c++) {
      const d = det[c];
      if (d === 0) continue;
      const out = d * rate;
      grass[c] += out;
      det[c] = d - out;
      released += out;
    }
  }

  w.grassFromCorpses = released;
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
  // 資源が2本あるときは合計の多い方へ向かう。**採食の配分は見ない**——
  // 見させると「探し方」と「食べ方」の2つの軸が同時に動く
  const two = w.twoResources;

  for (let oy = -r; oy <= r; oy++) {
    const row = wrap(y + oy, w.height) * w.width;
    for (let ox = -r; ox <= r; ox++) {
      if (ox === 0 && oy === 0) continue;
      const k = row + wrap(x + ox, w.width);
      const g = two ? w.grass[k] + w.grassB[k] : w.grass[k];
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

/**
 * 連続値の形質を、そのステップで実際に使う整数（移動セル数・走査半径）に落とす。
 *
 * 格子の上では半セル進むことも半セル先を見ることも出来ないので、端数は確率で
 * 繰り上げる。速度1.4なら10回のうち4回は2セル、6回は1セル動き、平均は1.4セルになる。
 * 切り捨てにすると 1.0 と 1.9 の個体が全く同じ動きをしてしまい、
 * 実効代謝だけが違うことになるので、速いほど不利という結果しか出なくなる。
 *
 * **視野でも同じことが起きる**、しかもより悪い形で。切り捨てなら 1.0〜1.99 の
 * 個体は全員が半径1で、その区間では利益が同じまま代償だけ増える。集団は必ず
 * 区間の下端へ押され、崖を落ちて次の区間の下端へ、と繰り返して視野0に着く——
 * 格子の刻み方だけで決まる結末を「見る価値は無かった」と読むことになる
 * （03 で3回踏んだ「実装の都合が生態系の挙動として観察される」）。
 *
 * 端数が無いときは乱数を引かない。変異を使わない構成の結果を変えないため。
 */
function quantize(w: World, v: number): number {
  const base = Math.floor(v);
  const frac = v - base;
  return frac > 0 && w.rng.chance(frac) ? base + 1 : base;
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
  w.moveKindSteps.fill(0);

  if (!w.anyVision) {
    for (let i = 0; i < w.count; i++) moveOne(w, i);
    return;
  }

  for (let s = 0; s < w.defs.length; s++) {
    // 定数が0でも遺伝で視野を持ちうる種があるので visionCapable で判定する。
    // visionRange > 0 で見ると、視野が遺伝する種の手番だけインデックスが古くなる
    if (w.visionCapable[s] === 1) w.buildSpatialIndex();
    for (let i = 0; i < w.count; i++) {
      if (w.aSpecies[i] === s) moveOne(w, i);
    }
  }
}

/**
 * 視界を持つ個体の行き先を決める。戻り値は scanDx/scanDy の使い方：
 *   1 = その方向へ、-1 = 逆方向へ（逃走）、0 = 何も見えないのでランダム
 *
 * 満腹なら  捕食者から逃げる → 獲物を追う → 草の多い方へ
 * 空腹なら  獲物を追う → 草の多い方へ → 捕食者から逃げる
 *
 * 空腹の側でも逃走を最後に残してあるのは、餌が見えないなら逃げた方が得だから。
 * 「腹が減ったらリスクを取る」であって、自暴自棄になるわけではない。
 */
function decideDirection(w: World, i: number, si: number, x: number, y: number, r: number): number {
  const def = w.defs[si];
  const predators = w.predatorBits[si];
  const preys = w.preyBits[si];

  // hungerThreshold が 0 なら常に false。既定の構成は下の分岐に入らず、
  // 乱数の消費列も従来と1つも変わらない
  const hungry = w.aEnergy[i] < def.hungerThreshold;

  if (!hungry && predators !== 0 && findNearest(w, x, y, predators, r)) return -1;
  if (preys !== 0 && findNearest(w, x, y, preys, r)) return 1;
  if (def.eatsGrass) {
    const c = y * w.width + x;
    const here = w.twoResources ? w.grass[c] + w.grassB[c] : w.grass[c];
    if (findGrass(w, x, y, r, here)) return 1;
  }
  if (hungry && predators !== 0 && findNearest(w, x, y, predators, r)) return -1;

  return 0;
}

/** 1個体の移動先を決める */
function moveOne(w: World, i: number): void {
  const si = w.aSpecies[i];
  const def = w.defs[si];
  const speed = quantize(w, w.aSpeed[i]);
  // 速度0の個体はここで抜ける。**視野の quantize より前**に抜けること——
  // 後ろに回すと動かない個体まで乱数を引き、既存の構成の結果が変わる
  if (speed === 0) {
    w.aMoveKind[i] = 3;
    w.moveKindSteps[si * 4 + 3]++;
    return;
  }

  const x = w.aX[i];
  const y = w.aY[i];
  // 視野が遺伝しない種は定義値をそのまま使い、乱数を1つも引かない
  const r = w.visionMutating[si] === 1 ? quantize(w, w.aVision[i]) : def.visionRange;
  let dx = 0;
  let dy = 0;

  const dir = r > 0 ? decideDirection(w, i, si, x, y, r) : 0;

  // 歩の種類を残す。採食のときに読んで「盲目の歩が何を取ったか」を分ける。
  // r>0 でも行き先が無ければ乱数で動くので、0（盲目）と 1（見たが無い）は別に数える
  const kind = r === 0 ? 0 : dir === 0 ? 1 : 2;
  w.aMoveKind[i] = kind;
  w.moveKindSteps[si * 4 + kind]++;

  if (dir === 0) {
    dx = w.rng.intRange(-speed, speed);
    dy = w.rng.intRange(-speed, speed);
  } else {
    dx = toward(dir * scanDx, speed);
    dy = toward(dir * scanDy, speed);
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
  w.deathsEaten.fill(0);
  w.deathsOther.fill(0);
  w.grazeAmount.fill(0);
  w.grazeAmountA.fill(0);
  w.grazeAmountB.fill(0);
  w.grazeCount.fill(0);
  w.grazeKindAmount.fill(0);
  w.grazeKindCount.fill(0);
  w.visionSumEaten.fill(0);
  w.visionSumOther.fill(0);

  const nSpecies = w.defs.length;
  const order = w.order;
  const count = w.count;
  // 前のステップの採食量を消す。食べなかった個体を0で表すので、
  // 消し忘れると「毎ステップ食べている」ことになる
  w.aGrazed.fill(0, 0, count);

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
          w.deathsEaten[w.aSpecies[j]]++;
          // 食われた側の視野を足す。集団平均との差が「見れば逃げられる」の実測値
          w.visionSumEaten[w.aSpecies[j]] += w.aVision[j];
          w.aEnergy[i] += def.gainFromPrey;
          ate = true;
        }
        break; // 成否によらず、1ステップの狩りは1回
      }
    }

    // 獲物を捕らえた個体はその上さらに草を食べない
    if (!ate && def.eatsGrass && w.twoResources) {
      // 採食量を配分に応じて2本に割り振り、それぞれ別に上限で頭打ちにする。
      // 配分の合計は1なので、専門化は「片方を捨てて片方に全部賭ける」になる
      const pA = w.resourceA[si];
      const capA = def.gainFromGrass * pA;
      const capB = def.gainFromGrass - capA;
      const availA = w.grass[c];
      const availB = w.grassB[c];
      const eatenA = availA < capA ? availA : capA;
      const eatenB = availB < capB ? availB : capB;
      const eaten = eatenA + eatenB;
      if (eaten > 0) {
        w.grass[c] = availA - eatenA;
        w.grassB[c] = availB - eatenB;
        w.aEnergy[i] += eaten;
        w.grazeAmount[si] += eaten;
        // 誰がどちらをどれだけ取ったかを分けて数える。合計だけでは
        // 「専門型が本当に自分の資源だけを取っているか」が見えない
        w.grazeAmountA[si] += eatenA;
        w.grazeAmountB[si] += eatenB;
        w.grazeCount[si]++;
        w.grazeKindAmount[si * 4 + w.aMoveKind[i]] += eaten;
        w.grazeKindCount[si * 4 + w.aMoveKind[i]]++;
        w.aGrazed[i] = eaten;
      }
    } else if (!ate && def.eatsGrass) {
      const avail = w.grass[c];
      if (avail > 0) {
        const eaten = avail < def.gainFromGrass ? avail : def.gainFromGrass;
        w.grass[c] = avail - eaten;
        w.aEnergy[i] += eaten;
        // 種別に「1回の採食で取れた量」を数える。採食量の上限(4)より
        // 残量(約1)のほうが小さいので、これは実質「食べた瞬間のセルの草」。
        // 21 で、視野を持つ種と持たない種が草の分布の違う部分を消費している
        // （平均 対 上側の裾）かを判定するために要る。step の外からは測れない
        // ——個体は自分のセルを食べ切るので、step 後に見ると必ず0になる
        w.grazeAmount[si] += eaten;
        w.grazeCount[si]++;
        // 歩の種類別にも分ける。1%の盲目の歩が何を取っているかは、
        // 種別の合計では有視界の歩に埋もれて見えない（27 節2 の段差）
        w.grazeKindAmount[si * 4 + w.aMoveKind[i]] += eaten;
        w.grazeKindCount[si * 4 + w.aMoveKind[i]]++;
        // 同じ量を個体別にも残す。視野が同じ種の中で違う構成では、
        // 種別の合計だけでは「誰が濃いセルを取っているか」が見えない
        w.aGrazed[i] = eaten;
      }
    }
  }
}

/**
 * 代謝でエネルギーを減らし、尽きた個体と寿命の来た個体を殺す。
 *
 * 死骸の還元が有効なら、ここで死んだ個体の体を自分のいたセルの草に戻す。
 * この手番に来ている時点で捕食は生き延びているので、**食べられて死んだ個体は
 * 自動的に対象外**になる。体が捕食者に移っているぶんを二重に数えないため。
 *
 * 戻した草は上限を超えてよい。死骸はその場に固まって落ちるものなので、
 * 上限で切ると大量死の直後ほど戻るぶんが消えることになり、
 * 「還元を入れた効果」がいちばん効くはずの場面で消えてしまう。
 */
function metabolize(w: World): void {
  w.syncTerrain();

  // 行動コストを含めた実効値を種ごとに1回だけ求める。
  // スライダーで即時に変わるので毎ステップ引き直すが、種数ぶんなので安い
  const cost = w.effMetabolism;
  for (let s = 0; s < w.defs.length; s++) cost[s] = w.effectiveMetabolism(s);

  // 速度が個体ごとに違う構成でだけ、1体ずつ引き直す
  const mutating = w.anyMutation;
  // 地形は個体のいるセルを見るので、種ごとの1回では済まない
  const terrain = w.terrainVaried;
  const tw = w.terrainWeight;
  w.terrainCostPaid = 0;
  w.terrainCostFlat = 0;

  for (let i = 0; i < w.count; i++) {
    if (w.aAlive[i] === 0) continue;
    const si = w.aSpecies[i];
    const def = w.defs[si];

    let charge = mutating
      ? w.effectiveMetabolismFor(si, w.aSpeed[i], w.aVision[i])
      : cost[si];
    if (terrain && w.terrainTargetSpecies[si] === 1) {
      // 平坦な場合との差分だけを足す。倍率1のセルでは差が0になるので、
      // contrast=0 の走行が地形を入れる前と完全に一致する
      const term = w.terrainModulatedTerm(si, mutating ? w.aSpeed[i] : def.speed);
      const weight = tw[w.aY[i] * w.width + w.aX[i]];
      charge += term * (weight - 1);
      // 設計上の平均倍率は1でも、個体が偏れば実現値はずれる。
      // 比を見ないと「起伏の効果」と「コストが上下した効果」が分けられない
      w.terrainCostFlat += term;
      w.terrainCostPaid += term * weight;
    }

    w.aEnergy[i] -= charge;
    if (w.aEnergy[i] <= 0) {
      w.aAlive[i] = 0;
      w.deathsOther[si]++;
      // 餓死した側の視野。被捕食（visionSumEaten）と逆を向くはずの選択差で、
      // 正味だけ見ていると打ち消し合ってどちらも効いていないように見える
      w.visionSumOther[si] += w.aVision[i];
      if (def.corpseGrass > 0) dropCorpse(w, def.corpseGrass, def.corpseSpread, w.aX[i], w.aY[i]);
      continue;
    }

    const age = w.aAge[i] + 1;
    w.aAge[i] = age;
    if (def.maxAge > 0 && age >= def.maxAge) {
      w.aAlive[i] = 0;
      w.deathsOther[si]++;
      w.visionSumOther[si] += w.aVision[i];
      if (def.corpseGrass > 0) dropCorpse(w, def.corpseGrass, def.corpseSpread, w.aX[i], w.aY[i]);
    }
  }
}

/**
 * 死骸を在庫に落とす。半径0なら死んだセルに全量、1以上なら周囲へ均等に分ける。
 *
 * 半径0だと1セルに採食量(4)の何倍もの山ができる。草食動物は1ステップに
 * 採食量ぶんしか食べないので、山は少数の個体に長く占有される。
 * まき散らすとその偏りが消えるので、空間の集中が効いているかを判定できる。
 */
function dropCorpse(w: World, amount: number, spread: number, x: number, y: number): void {
  if (spread <= 0) {
    w.detritus[y * w.width + x] += amount;
    return;
  }
  const side = 2 * spread + 1;
  const share = amount / (side * side);
  for (let oy = -spread; oy <= spread; oy++) {
    const row = wrap(y + oy, w.height) * w.width;
    for (let ox = -spread; ox <= spread; ox++) {
      w.detritus[row + wrap(x + ox, w.width)] += share;
    }
  }
}

/**
 * 子が受け継ぐ速度。親の値に正規ノイズを乗せ、指定の範囲に収める。
 *
 * 変異を指定していない種はここで乱数を引かない。既存の構成が
 * この機構を入れる前と同じ乱数列をたどるようにするため。
 */
function childSpeed(w: World, def: SpeciesDef, parent: number): number {
  const m = def.mutation;
  if (m === undefined) return parent;

  const v = parent + w.rng.normal() * m.speedSigma;
  if (v < m.speedMin) return m.speedMin;
  if (v > m.speedMax) return m.speedMax;
  return v;
}

/**
 * 子が受け継ぐ視野。速度と同じ形。
 *
 * 速度と別の関数にしてあるのは、片方だけを遺伝させる構成を作れるようにするため。
 * 両方を指定した種では **速度 → 視野の順に引く**。順序を決めておかないと、
 * 片方だけ有効にした走行ともう片方を足した走行で乱数列の対応が取れなくなる。
 */
function childVision(w: World, def: SpeciesDef, parent: number): number {
  const m = def.visionMutation;
  if (m === undefined) return parent;

  const v = parent + w.rng.normal() * m.sigma;
  if (v < m.min) return m.min;
  if (v > m.max) return m.max;
  return v;
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
    // 引数は左から評価されるので、乱数は速度 → 視野の順に引かれる
    const speed = childSpeed(w, def, w.aSpeed[i]);
    const vision = childVision(w, def, w.aVision[i]);
    if (w.spawn(si, w.aX[i], w.aY[i], childEnergy, speed, vision)) {
      w.aEnergy[i] -= childEnergy;
    }
  }
}
