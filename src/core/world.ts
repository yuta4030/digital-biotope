import { Rng } from './rng.ts';
import type { SpeciesDef, WorldConfig, StepStats } from './types.ts';

/** 格子点の間を滑らかにつなぐ。線形補間だと格子線が直線の模様として残る */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * シミュレーションの状態。
 *
 * エージェントは Structure of Arrays で保持する。[0, count) が生存個体で、
 * 死亡個体は毎ステップ末尾と入れ替えて詰めるので常に密に並ぶ。
 * オブジェクトの配列にするより桁で速く、Worker への転送もそのまま出来る。
 *
 * DOM に一切触れないこと。表示側とスイープ側で同じコードを動かすため。
 */
export class World {
  readonly width: number;
  readonly height: number;
  readonly cells: number;
  readonly config: WorldConfig;
  readonly rng: Rng;

  /** 種定義。aSpecies にはこの配列のインデックスが入る（id ではない） */
  readonly defs: SpeciesDef[];
  /** [捕食者idx * 種数 + 被食者idx] が 1 なら捕食する */
  readonly preyMask: Uint8Array;
  /** 捕食対象を1つでも持つか */
  readonly isPredator: Uint8Array;
  /** 種idx が食べる相手のビット集合。視界スキャンで1回の AND で判定するため */
  readonly preyBits: Uint32Array;
  /** 種idx を食べてくる相手のビット集合（preyBits の転置） */
  readonly predatorBits: Uint32Array;
  /** 視界を持つ種が1つでもあるか。無ければ移動前のインデックス構築を省く */
  readonly anyVision: boolean;
  /** 死骸を戻す種が1つでもあるか。無ければ在庫の走査を丸ごと省く */
  readonly anyCorpse: boolean;
  /** 速度を遺伝させる種が1つでもあるか。無ければ代謝を種別に1回引くだけで済む */
  readonly anyMutation: boolean;
  /** 種別の実効代謝。スライダーで随時変わるので毎ステップ引き直す */
  readonly effMetabolism: Float64Array;

  /** 各セルの草の量 */
  readonly grass: Float32Array;
  /**
   * 各セルの回復速度の倍率。**平均はちょうど1**なので、
   * これを掛けても世界全体の生産量は config.grass.regrow のまま変わらない。
   * パッチ無しなら全要素1で、`grassPatched` が false になり掛け算自体を省く。
   */
  readonly grassWeight: Float32Array;
  grassPatched = false;
  /** grassWeight を組んだときのパッチ設定。スライダーで変わったら組み直す */
  private builtScale = -1;
  private builtContrast = -1;
  /**
   * 直前のステップで実際に草に加わった量。
   * 上限で頭打ちになったぶんは入らないので、名目の生産量（regrow × セル数）とは一致しない。
   * パッチは豊かなセルを飽和させやすく、実質的な生産量を下げる方向に効く。
   * その量を測らないと「不均質にした効果」と「痩せた効果」が区別できない。
   */
  grassAdded = 0;
  /**
   * 直前のステップで死骸から草へ戻った量。
   * 回復速度とは別口の流入なので、分けて数えないと豊穣化と区別がつかない。
   */
  grassFromCorpses = 0;
  /**
   * セルごとの死骸の在庫。死骸はまずここに積まれ、
   * config.grass.detritusRelease の割合ずつ草へ変わる。
   * 放出率1なら1ステップで空になるので、在庫を持たないのと同じ挙動になる。
   */
  readonly detritus: Float32Array;

  /**
   * 直前のステップの死亡数。種インデックス別。毎ステップ上書きする。
   *
   * 死骸の還元は餓死と寿命死にしか効かないので、その種の死因の内訳を見ないと
   * 「還元を入れたのに何も起きない」の理由が分からない。
   */
  readonly deathsEaten: Int32Array;
  readonly deathsOther: Int32Array;
  /**
   * 大量死で取り除いた数。種インデックス別で、毎ステップ上書きする。
   *
   * 餓死・寿命死（deathsOther）と混ぜない。大量死は設計上の割合と実現値が
   * ずれていないかを確かめるための量で、混ぜると確かめられなくなる。
   */
  readonly deathsDisturbance: Int32Array;

  /**
   * 大量死の対象かどうか。種インデックス別に 1/0。
   * 設定を省略した場合は全種が対象（実際に起きるかは fraction が決める）。
   */
  readonly disturbTarget: Uint8Array;
  /**
   * 大量死用の乱数。世界本体とは**別のストリーム**。
   * 同じ rng を使うと、大量死を有効にした瞬間から在来の乱数列がずれるので、
   * 「割合0で回した結果 = 大量死を入れる前の結果」が成り立たなくなる。
   * パッチ場（buildPatchField）・侵入（run.ts）と同じ理由で同じ手を使っている。
   */
  readonly disturbanceRng: Rng;

  // --- エージェント ---
  readonly capacity: number;
  count = 0;
  readonly aSpecies: Uint8Array;
  readonly aX: Int16Array;
  readonly aY: Int16Array;
  readonly aEnergy: Float32Array;
  readonly aAge: Uint16Array;
  /**
   * 個体ごとの移動速度。mutation を持たない種では常に定義値と等しい。
   * 遺伝する形質はこれだけなので、増やすときはここに配列を足して
   * spawn / compact / speedStats の3箇所を揃える。
   */
  readonly aSpeed: Float32Array;
  /** 0 になった個体はそのステップの終わりに取り除かれる */
  readonly aAlive: Uint8Array;

  // --- 空間インデックス（counting sort） ---
  readonly cellStart: Int32Array;
  readonly cellAgents: Int32Array;
  /** セルにいる種のビット集合。視界スキャンはこれだけを読む */
  readonly cellSpecies: Uint32Array;
  private readonly cursor: Int32Array;

  /** 反復順をシャッフルするための作業配列。処理順による偏りを避ける */
  readonly order: Int32Array;

  // speedStats の集計先。毎ステップ呼ぶので確保し直さない
  private readonly speedSum: Float64Array;
  private readonly speedSqSum: Float64Array;
  private readonly speedCount: Float64Array;

  stepCount = 0;

  constructor(config: WorldConfig) {
    this.config = config;
    this.width = config.width;
    this.height = config.height;
    this.cells = config.width * config.height;
    this.rng = new Rng(config.seed);
    this.defs = config.species;

    const n = this.defs.length;
    if (n > 32) throw new Error('種は32までしか扱えません（視界判定でビット集合を使うため）');

    // 捕食関係を id ベースからインデックスベースの表に変換しておく
    const idToIndex = new Map<number, number>();
    this.defs.forEach((d, i) => idToIndex.set(d.id, i));

    this.preyMask = new Uint8Array(n * n);
    this.isPredator = new Uint8Array(n);
    this.preyBits = new Uint32Array(n);
    this.predatorBits = new Uint32Array(n);
    this.defs.forEach((d, i) => {
      for (const preyId of d.preys) {
        const j = idToIndex.get(preyId);
        if (j === undefined) {
          throw new Error(`種 "${d.name}" の捕食対象 id=${preyId} が定義に存在しません`);
        }
        this.preyMask[i * n + j] = 1;
        this.isPredator[i] = 1;
        this.preyBits[i] |= 1 << j;
        this.predatorBits[j] |= 1 << i;
      }
    });

    this.anyVision = this.defs.some((d) => d.visionRange > 0 && d.speed > 0);
    this.anyCorpse = this.defs.some((d) => d.corpseGrass > 0);
    this.anyMutation = this.defs.some((d) => d.mutation !== undefined);
    this.effMetabolism = new Float64Array(n);
    this.deathsEaten = new Int32Array(n);
    this.deathsOther = new Int32Array(n);
    this.deathsDisturbance = new Int32Array(n);

    // 対象の種は構築時に固定する。id からインデックスへの変換をここで済ませておけば
    // 毎ステップの走査は Uint8Array の参照1回で済む。
    // 間隔と割合は config を毎ステップ読むので、UIのスライダーで即時に変わる
    this.disturbTarget = new Uint8Array(n).fill(1);
    const targets = config.disturbance?.species;
    if (targets !== undefined) {
      this.disturbTarget.fill(0);
      for (const id of targets) {
        const i = idToIndex.get(id);
        if (i === undefined) throw new Error(`大量死の対象 id=${id} が種定義に存在しません`);
        this.disturbTarget[i] = 1;
      }
    }
    this.disturbanceRng = new Rng((config.seed ^ 0x7c9e3b21) >>> 0);
    this.speedSum = new Float64Array(n);
    this.speedSqSum = new Float64Array(n);
    this.speedCount = new Float64Array(n);

    this.grass = new Float32Array(this.cells);
    this.grass.fill(config.grass.max * config.grass.initialRatio);
    this.grassWeight = new Float32Array(this.cells);
    this.syncGrassWeight();
    this.detritus = new Float32Array(this.cells);

    this.capacity = config.maxAgents;
    this.aSpecies = new Uint8Array(this.capacity);
    this.aX = new Int16Array(this.capacity);
    this.aY = new Int16Array(this.capacity);
    this.aEnergy = new Float32Array(this.capacity);
    this.aAge = new Uint16Array(this.capacity);
    this.aSpeed = new Float32Array(this.capacity);
    this.aAlive = new Uint8Array(this.capacity);

    this.cellStart = new Int32Array(this.cells + 1);
    this.cellAgents = new Int32Array(this.capacity);
    this.cellSpecies = new Uint32Array(this.cells);
    this.cursor = new Int32Array(this.cells);
    this.order = new Int32Array(this.capacity);

    this.spawnInitial();
  }

  /**
   * パッチ設定が変わっていたら草の回復速度の分布を組み直す。
   * 毎ステップ頭で呼ぶが、比較2回で済むのでスライダーを動かした時しか働かない。
   */
  syncGrassWeight(): void {
    const p = this.config.grass.patch;
    const scale = p ? p.scale : 0;
    const contrast = p ? p.contrast : 0;
    if (scale === this.builtScale && contrast === this.builtContrast) return;
    this.builtScale = scale;
    this.builtContrast = contrast;

    if (scale <= 0 || contrast <= 0) {
      this.grassWeight.fill(1);
      this.grassPatched = false;
      return;
    }
    if (this.width % scale !== 0 || this.height % scale !== 0) {
      throw new Error(
        `パッチの大きさ ${scale} は世界の幅 ${this.width} と高さ ${this.height} を割り切る必要があります` +
          '（トーラスの継ぎ目で分布が途切れるため）',
      );
    }
    this.buildPatchField(scale, contrast);
    this.grassPatched = true;
  }

  /**
   * 格子点に乱数を置いて滑らかに補間する（バリューノイズ）。
   *
   * 単純にブロックごとの乱数にするとパッチが軸に沿った四角になり、
   * それ自体が動物の分布を歪めかねない。[03](../../docs/reports/03-vision-and-pursuit.md)
   * の「走査順バイアスが群れの流れとして観察された」のと同じ失敗を避けるため、
   * 角を丸めて向きの偏りを消してある。
   *
   * 乱数は世界本体とは別のストリームから引く。同じ rng を使うと、
   * パッチを無効にした場合でも消費数が変わって既存の結果が再現しなくなる。
   */
  private buildPatchField(scale: number, contrast: number): void {
    const { width, height, cells, grassWeight } = this;
    const gw = width / scale;
    const gh = height / scale;

    const rng = new Rng((this.config.seed ^ 0x5bf03635) >>> 0);
    const lattice = new Float64Array(gw * gh);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next() * 2 - 1;

    // 端は反対側の格子点につなぐ。世界がトーラスなので分布も連続させる
    for (let y = 0; y < height; y++) {
      const gy = (y / scale) | 0;
      const ty = smoothstep((y % scale) / scale);
      const r0 = gy * gw;
      const r1 = ((gy + 1) % gh) * gw;
      for (let x = 0; x < width; x++) {
        const gx = (x / scale) | 0;
        const tx = smoothstep((x % scale) / scale);
        const gx1 = (gx + 1) % gw;
        const top = lattice[r0 + gx] + (lattice[r0 + gx1] - lattice[r0 + gx]) * tx;
        const bottom = lattice[r1 + gx] + (lattice[r1 + gx1] - lattice[r1 + gx]) * tx;
        grassWeight[y * width + x] = top + (bottom - top) * ty;
      }
    }

    // 平均を0に寄せてから振幅を contrast に合わせる。
    // 平均1を保つのが要点で、これを外すと不均質にしたのか痩せさせたのか分からなくなる
    let mean = 0;
    for (let c = 0; c < cells; c++) mean += grassWeight[c];
    mean /= cells;

    let amp = 0;
    for (let c = 0; c < cells; c++) {
      const d = Math.abs(grassWeight[c] - mean);
      if (d > amp) amp = d;
    }
    const k = amp > 0 ? contrast / amp : 0;
    for (let c = 0; c < cells; c++) {
      grassWeight[c] = 1 + (grassWeight[c] - mean) * k;
    }
  }

  private spawnInitial(): void {
    this.defs.forEach((def, idx) => {
      for (let k = 0; k < def.initialCount; k++) {
        this.spawn(idx, this.rng.int(this.width), this.rng.int(this.height), def.initialEnergy);
      }
    });
  }

  /**
   * 個体を1体追加する。容量超過なら false。
   * speed を省くと種の定義値になる。初期個体は全員この値で揃うので、
   * 変異のある構成では「1点から出発してどこへ動くか」を見ることになる。
   */
  spawn(speciesIdx: number, x: number, y: number, energy: number, speed?: number): boolean {
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    this.aSpecies[i] = speciesIdx;
    this.aX[i] = x;
    this.aY[i] = y;
    this.aEnergy[i] = energy;
    this.aAge[i] = 0;
    this.aSpeed[i] = speed ?? this.defs[speciesIdx].speed;
    this.aAlive[i] = 1;
    return true;
  }

  /**
   * セルごとのエージェント一覧を作り直す。
   * counting sort なので O(個体数 + セル数)。
   */
  buildSpatialIndex(): void {
    const { cells, cellStart, cursor, cellAgents, cellSpecies, aX, aY, aAlive, aSpecies, width, count } = this;

    cellStart.fill(0);
    cellSpecies.fill(0);
    // cellStart[c+1] に個数を数え込む → そのまま累積すれば開始位置になる
    for (let i = 0; i < count; i++) {
      if (aAlive[i] === 0) continue;
      const c = aY[i] * width + aX[i];
      cellStart[c + 1]++;
      cellSpecies[c] |= 1 << aSpecies[i];
    }
    for (let c = 0; c < cells; c++) {
      cellStart[c + 1] += cellStart[c];
    }
    cursor.set(cellStart.subarray(0, cells));

    for (let i = 0; i < count; i++) {
      if (aAlive[i] === 0) continue;
      const c = aY[i] * width + aX[i];
      cellAgents[cursor[c]++] = i;
    }
  }

  /** 死亡個体を取り除いて [0, count) を詰める */
  compact(): void {
    const { aSpecies, aX, aY, aEnergy, aAge, aSpeed, aAlive } = this;
    let n = this.count;
    let i = 0;
    while (i < n) {
      if (aAlive[i] === 1) {
        i++;
        continue;
      }
      // 末尾の生存個体と入れ替える
      n--;
      if (i !== n) {
        aSpecies[i] = aSpecies[n];
        aX[i] = aX[n];
        aY[i] = aY[n];
        aEnergy[i] = aEnergy[n];
        aAge[i] = aAge[n];
        aSpeed[i] = aSpeed[n];
        aAlive[i] = aAlive[n];
      }
    }
    this.count = n;
  }

  /** 実効代謝 = 基礎代謝 + 速度コスト × 速度 + 視野コスト × 視野 */
  effectiveMetabolism(speciesIdx: number): number {
    return this.effectiveMetabolismFor(speciesIdx, this.defs[speciesIdx].speed);
  }

  /**
   * 速度を指定して実効代謝を求める。速度が個体ごとに違う構成で使う。
   * 速いことの代償はここにしか無いので、speedCost が0だと選択が働かない。
   */
  effectiveMetabolismFor(speciesIdx: number, speed: number): number {
    const d = this.defs[speciesIdx];
    return d.metabolism + d.speedCost * speed + d.visionCost * d.visionRange;
  }

  /**
   * 種インデックス別の速度の平均と標準偏差を out に書き込む。O(個体数)。
   * 個体がいない種は両方 0。
   *
   * 標準偏差を出すのは、平均だけでは「集団が1点に集まっている」のか
   * 「速い個体と遅い個体に割れている」のかが区別できないため。
   */
  speedStats(mean: Float64Array, sd: Float64Array): void {
    const { speedSum: sum, speedSqSum: sq, speedCount: cnt } = this;
    sum.fill(0);
    sq.fill(0);
    cnt.fill(0);

    for (let i = 0; i < this.count; i++) {
      const s = this.aSpecies[i];
      const v = this.aSpeed[i];
      sum[s] += v;
      sq[s] += v * v;
      cnt[s]++;
    }

    for (let s = 0; s < this.defs.length; s++) {
      if (cnt[s] === 0) {
        mean[s] = 0;
        sd[s] = 0;
        continue;
      }
      const m = sum[s] / cnt[s];
      // 丸め誤差で分散がわずかに負に出ることがあるので下限で止める
      const variance = sq[s] / cnt[s] - m * m;
      mean[s] = m;
      sd[s] = variance > 0 ? Math.sqrt(variance) : 0;
    }
  }

  /**
   * 種インデックス別の個体数を out に書き込む。O(個体数)。
   * 毎ステップ呼ぶのはこちら。stats() は草の総量でセル数ぶん舐めるので重い。
   */
  countBySpecies(out: Int32Array): void {
    out.fill(0);
    for (let i = 0; i < this.count; i++) out[this.aSpecies[i]]++;
  }

  stats(): StepStats {
    const counts = new Int32Array(this.defs.length);
    this.countBySpecies(counts);

    const population = new Map<number, number>();
    this.defs.forEach((def, i) => population.set(def.id, counts[i]));

    let totalGrass = 0;
    for (let c = 0; c < this.cells; c++) totalGrass += this.grass[c];

    return { step: this.stepCount, population, totalGrass };
  }

  /** 死骸の在庫の総量。均され方を見るのに要る */
  totalDetritus(): number {
    let t = 0;
    for (let c = 0; c < this.cells; c++) t += this.detritus[c];
    return t;
  }

  /** 草の回復速度の分布。レポートで実現値を確かめるため */
  grassWeightStats(): { min: number; max: number; mean: number } {
    let min = Infinity;
    let max = 0;
    let sum = 0;
    for (let c = 0; c < this.cells; c++) {
      const v = this.grassWeight[c];
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    return { min, max, mean: sum / this.cells };
  }

  /** 全種が生存しているか（絶滅判定） */
  allAlive(): boolean {
    const seen = new Uint8Array(this.defs.length);
    for (let i = 0; i < this.count; i++) seen[this.aSpecies[i]] = 1;
    for (let s = 0; s < seen.length; s++) if (seen[s] === 0) return false;
    return true;
  }
}
