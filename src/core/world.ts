import { Rng } from './rng.ts';
import type { SpeciesDef, WorldConfig, StepStats } from './types.ts';

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
  /** 種別の実効代謝。スライダーで随時変わるので毎ステップ引き直す */
  readonly effMetabolism: Float64Array;

  /** 各セルの草の量 */
  readonly grass: Float32Array;

  // --- エージェント ---
  readonly capacity: number;
  count = 0;
  readonly aSpecies: Uint8Array;
  readonly aX: Int16Array;
  readonly aY: Int16Array;
  readonly aEnergy: Float32Array;
  readonly aAge: Uint16Array;
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
    this.effMetabolism = new Float64Array(n);

    this.grass = new Float32Array(this.cells);
    this.grass.fill(config.grass.max * config.grass.initialRatio);

    this.capacity = config.maxAgents;
    this.aSpecies = new Uint8Array(this.capacity);
    this.aX = new Int16Array(this.capacity);
    this.aY = new Int16Array(this.capacity);
    this.aEnergy = new Float32Array(this.capacity);
    this.aAge = new Uint16Array(this.capacity);
    this.aAlive = new Uint8Array(this.capacity);

    this.cellStart = new Int32Array(this.cells + 1);
    this.cellAgents = new Int32Array(this.capacity);
    this.cellSpecies = new Uint32Array(this.cells);
    this.cursor = new Int32Array(this.cells);
    this.order = new Int32Array(this.capacity);

    this.spawnInitial();
  }

  private spawnInitial(): void {
    this.defs.forEach((def, idx) => {
      for (let k = 0; k < def.initialCount; k++) {
        this.spawn(idx, this.rng.int(this.width), this.rng.int(this.height), def.initialEnergy);
      }
    });
  }

  /** 個体を1体追加する。容量超過なら false */
  spawn(speciesIdx: number, x: number, y: number, energy: number): boolean {
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    this.aSpecies[i] = speciesIdx;
    this.aX[i] = x;
    this.aY[i] = y;
    this.aEnergy[i] = energy;
    this.aAge[i] = 0;
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
    const { aSpecies, aX, aY, aEnergy, aAge, aAlive } = this;
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
        aAlive[i] = aAlive[n];
      }
    }
    this.count = n;
  }

  /** 実効代謝 = 基礎代謝 + 速度コスト × 速度 + 視野コスト × 視野 */
  effectiveMetabolism(speciesIdx: number): number {
    const d = this.defs[speciesIdx];
    return d.metabolism + d.speedCost * d.speed + d.visionCost * d.visionRange;
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

  /** 全種が生存しているか（絶滅判定） */
  allAlive(): boolean {
    const seen = new Uint8Array(this.defs.length);
    for (let i = 0; i < this.count; i++) seen[this.aSpecies[i]] = 1;
    for (let s = 0; s < seen.length; s++) if (seen[s] === 0) return false;
    return true;
  }
}
