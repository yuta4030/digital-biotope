import { Rng } from './rng.ts';
import type { SpeciesDef, WorldConfig, StepStats } from './types.ts';

/** 格子点の間を滑らかにつなぐ。線形補間だと格子線が直線の模様として残る */
/** セルごとの場の min/max/mean。草のパッチと地形で同じものを見るので共通化してある */
function fieldStats(field: Float32Array, cells: number): { min: number; max: number; mean: number } {
  let min = Infinity;
  let max = 0;
  let sum = 0;
  for (let c = 0; c < cells; c++) {
    const v = field[c];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, mean: sum / cells };
}

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
  /**
   * 種インデックス別に、視界を使いうるか（1/0）。
   *
   * 定数の visionRange が0でも visionMutation を持つ種は使いうるので、
   * `visionRange > 0` では判定できない。移動の順序（獲物→捕食者の間に
   * インデックスを組み直す）はこちらで決める。
   */
  readonly visionCapable: Uint8Array;
  /** 種インデックス別に、視野が遺伝するか（1/0）。個体ごとの走査半径を引く判定に使う */
  readonly visionMutating: Uint8Array;
  /** 死骸を戻す種が1つでもあるか。無ければ在庫の走査を丸ごと省く */
  readonly anyCorpse: boolean;
  /**
   * 速度**または**視野を遺伝させる種が1つでもあるか。
   * 無ければ実効代謝を種別に1回引くだけで済む。
   */
  readonly anyMutation: boolean;
  /** 視野を遺伝させる種が1つでもあるか。視野の統計を取るかどうかの判定に使う */
  readonly anyVisionMutation: boolean;
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
   * 各セルの移動コストの倍率。**平均はちょうど1**なので、
   * 世界全体の名目コストはこれを掛けても変わらない。
   * 地形なしなら全要素1で、`terrainVaried` が false になり掛け算自体を省く。
   */
  readonly terrainWeight: Float32Array;
  terrainVaried = false;
  /** 倍率をどの項に掛けるか。既定は移動コスト（形質と結合する側） */
  terrainTarget: 'speed' | 'base' = 'speed';
  private builtTerrainScale = -1;
  private builtTerrainContrast = -1;
  /**
   * 直前のステップで**実際に支払われた**地形依存の項の合計と、
   * 同じ個体が平坦な世界（倍率1）で支払ったはずの合計。
   *
   * 比が実現した平均倍率になる。設計上は1だが、個体が地形に偏って分布すれば
   * ずれる。これを見ないと「起伏の効果」と「実質的にコストが上下した効果」が
   * 分けられない——08で `grassAdded` と `grassFromCorpses` を分けて
   * 初めて豊穣化の交絡に気づけたのと同じ形の計測器。
   */
  terrainCostPaid = 0;
  terrainCostFlat = 0;
  /**
   * 地形を適用する種か。種インデックス別に 1/0。省略時は全種。
   *
   * 全種に掛けると捕食者の移動コストまで不均質になり、実現倍率が1を割るぶん
   * 捕食者が安くなる。捕食者が増えれば捕食圧が上がり、10 が示したとおり
   * 速度の丘そのものが動く。20 の第1回はこれを踏んだ。
   */
  readonly terrainTargetSpecies: Uint8Array;
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
   * 直前のステップに死んだ個体の**視野の合計**。死因ごとに分けて、種インデックス別。
   * `deathsEaten` / `deathsOther` で割ると死んだ側の平均視野になる。
   *
   * 集団の平均視野（visionStats）との差が、その死因が視野にかけている選択差そのもの。
   * これを分けて数えないと「視野が上がった／下がった」の**理由**が言えない——
   * 見えれば逃げられる（被捕食を減らす）と、見る代償で先に飢える（餓死を増やす）は
   * 逆を向いていて、正味だけ見てもどちらがどれだけ効いたのか分からない。
   * 08 で `grassAdded` と `grassFromCorpses` を分けたのと同じ形の計測器。
   *
   * 数えるのは被捕食（feed）と餓死・寿命（metabolize）だけ。
   * 大量死・密度依存・感染は形質を見ない死なので、混ぜると選択差が薄まる。
   */
  readonly visionSumEaten: Float64Array;
  readonly visionSumOther: Float64Array;
  /**
   * 直前のステップに種インデックス別で、草を食べた量と食べた回数。毎ステップ上書きする。
   *
   * 比が「1回の採食で取れた量」で、採食量の上限(4)より残量(約1)のほうが小さいので、
   * 実質**食べた瞬間のセルの草**になる。
   *
   * これは step の外からは測れない。個体は自分のセルの草を食べ切るので、
   * step 後に個体のいるセルを見ると必ず0になる（21 でそれを踏んだ）。
   *
   * 要る理由は、視野を持つ種と持たない種が**草の分布の違う部分**を消費している
   * かどうかの判定。同じ資源でも制限されている統計量が違うなら、
   * 制限要因は1つではない。
   */
  readonly grazeAmount: Float64Array;
  readonly grazeCount: Int32Array;
  /**
   * 大量死で取り除いた数。種インデックス別で、毎ステップ上書きする。
   *
   * 餓死・寿命死（deathsOther）と混ぜない。大量死は設計上の割合と実現値が
   * ずれていないかを確かめるための量で、混ぜると確かめられなくなる。
   */
  readonly deathsDisturbance: Int32Array;
  /**
   * 密度依存の死で取り除いた数。種インデックス別で、毎ステップ上書きする。
   *
   * 大量死（deathsDisturbance）と混ぜない。この2つは同じ「形質を見ない死」でも、
   * 一方は密度に比例し他方はしないので、混ぜると **同じ量を取り除いたのか**を
   * 確かめられなくなる。self と all の比較はまさにそれを揃える比較なので、
   * ここが分かれていないと実験そのものが成り立たない。
   */
  readonly deathsCrowding: Int32Array;

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
  /**
   * 密度依存の死用の乱数。大量死ともまた別のストリーム。
   * 同じ流れから引くと、片方を有効にした瞬間にもう片方の抽選がずれる。
   * self と all を比べるときは両者が同じ乱数列をたどっていてほしいので、
   * ここを共有させてはいけない。
   */
  readonly crowdingRng: Rng;
  /** crowding を持つ種が1つでもあるか。無ければ毎ステップの走査ごと飛ばす */
  readonly anyCrowding: boolean;

  /**
   * 感染で死んだ数・新たに感染した数。種インデックス別で毎ステップ上書きする。
   *
   * 感染経路を**接触と自然発生に分けて**数える。自然発生は密度に依存しない死なので、
   * そちらが主なら 15 で潰した「均等な死」をやっているだけになる。
   * 分けて数えていないと、頻度依存が効いたのかどうかを確かめられない。
   */
  readonly deathsInfection: Int32Array;
  readonly infectedByContact: Int32Array;
  readonly infectedBySpontaneous: Int32Array;
  /** 感染症用の乱数。世界本体・大量死・密度依存のどれとも別ストリーム */
  readonly infectionRng: Rng;
  /** infection を持つ種が1つでもあるか */
  readonly anyInfection: boolean;
  /**
   * 個体ごとの感染状態（0/1）。遺伝はしない——子は必ず未感染で生まれる。
   * 垂直感染を入れると軸が1本増えるので、いまは水平感染だけを見る。
   */
  readonly aInfected: Uint8Array;
  /**
   * 次ステップの感染状態。**このステップで新たに感染した個体を、
   * 同じステップの伝染源にしないため**に分けてある。
   *
   * 直接 aInfected に書き込むと、配列の添字が若い個体から順に連鎖して
   * 1ステップで世界の端まで伝染しうる。しかも伝わり方が走査順に依存するので、
   * 03 で3回踏んだ「走査順のバイアスが生態学的な現象に見える」がそのまま出る。
   */
  readonly aInfectedNext: Uint8Array;
  /** 密度依存の死で使う作業配列。step.ts から使うので private にしない */
  readonly crowdCounts: Int32Array;
  readonly crowdProb: Float64Array;

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
  /**
   * 個体ごとの視野。visionMutation を持たない種では常に定義値と等しい。
   * 走査半径は整数なので、使うときに端数を確率で繰り上げる（step.ts の quantize）。
   * 代償のほうはこの連続値のまま実効代謝に乗る。
   */
  readonly aVision: Float32Array;
  /**
   * 直前のステップにその個体が食べた草の量。食べなかった個体は0。
   *
   * 種別の合計（grazeAmount / grazeCount）では**同じ種の中で視野が違う個体**を
   * 分けられない。21 が種をまたいで見つけた「無警戒型は94%の歩で0.423ずつ、
   * 警戒型は46%の歩で1.032ずつ」が、1つの種の中の連続した視野の軸の上でも
   * 成り立つのかを見るには、個体ごとに要る。
   *
   * step の外からは測れない。個体は自分のセルの草を食べ切るので、
   * step 後にセルを見ると必ず0になる（21 でそれを踏んだ）。
   */
  readonly aGrazed: Float32Array;
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

  // traitStats の集計先。毎ステップ呼ぶので確保し直さない。
  // 速度と視野で使い回すが、1回の呼び出しの中で閉じるので混ざらない
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

    // 視野は「定数が0でも遺伝で0を超えうる」ので、種ごとに使いうるかを先に畳んでおく。
    // 上限0の変異（対照）は視野を使えないので capable に数えない
    this.visionCapable = new Uint8Array(n);
    this.visionMutating = new Uint8Array(n);
    this.defs.forEach((d, i) => {
      const vm = d.visionMutation;
      this.visionMutating[i] = vm !== undefined ? 1 : 0;
      this.visionCapable[i] = d.visionRange > 0 || (vm !== undefined && vm.max > 0) ? 1 : 0;
    });
    this.anyVision = this.defs.some((d, i) => this.visionCapable[i] === 1 && d.speed > 0);
    this.anyCorpse = this.defs.some((d) => d.corpseGrass > 0);
    this.anyVisionMutation = this.defs.some((d) => d.visionMutation !== undefined);
    this.anyMutation =
      this.defs.some((d) => d.mutation !== undefined) || this.anyVisionMutation;
    this.effMetabolism = new Float64Array(n);
    this.deathsEaten = new Int32Array(n);
    this.deathsOther = new Int32Array(n);
    this.visionSumEaten = new Float64Array(n);
    this.visionSumOther = new Float64Array(n);
    this.grazeAmount = new Float64Array(n);
    this.grazeCount = new Int32Array(n);
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
    // 地形の対象。大量死と同じ形にしてあるのは同じ交絡を踏んだため
    // （全種に掛けると捕食者が安くなり、捕食圧が速度の丘を動かす）
    this.terrainTargetSpecies = new Uint8Array(n).fill(1);
    const terrainTargets = config.terrain?.species;
    if (terrainTargets !== undefined) {
      this.terrainTargetSpecies.fill(0);
      for (const id of terrainTargets) {
        const i = idToIndex.get(id);
        if (i === undefined) throw new Error(`地形の対象 id=${id} が種定義に存在しません`);
        this.terrainTargetSpecies[i] = 1;
      }
    }

    this.disturbanceRng = new Rng((config.seed ^ 0x7c9e3b21) >>> 0);
    this.deathsCrowding = new Int32Array(n);
    this.anyCrowding = this.defs.some((d) => d.crowding !== undefined && d.crowding.rate > 0);
    this.crowdingRng = new Rng((config.seed ^ 0x51ab7d0f) >>> 0);
    this.crowdCounts = new Int32Array(n);
    this.crowdProb = new Float64Array(n);
    this.deathsInfection = new Int32Array(n);
    this.infectedByContact = new Int32Array(n);
    this.infectedBySpontaneous = new Int32Array(n);
    this.anyInfection = this.defs.some((d) => d.infection !== undefined);
    this.infectionRng = new Rng((config.seed ^ 0x2f6a91c5) >>> 0);
    this.speedSum = new Float64Array(n);
    this.speedSqSum = new Float64Array(n);
    this.speedCount = new Float64Array(n);

    this.grass = new Float32Array(this.cells);
    this.grass.fill(config.grass.max * config.grass.initialRatio);
    this.grassWeight = new Float32Array(this.cells);
    this.syncGrassWeight();
    this.terrainWeight = new Float32Array(this.cells);
    this.syncTerrain();
    this.detritus = new Float32Array(this.cells);

    this.capacity = config.maxAgents;
    this.aSpecies = new Uint8Array(this.capacity);
    this.aX = new Int16Array(this.capacity);
    this.aY = new Int16Array(this.capacity);
    this.aEnergy = new Float32Array(this.capacity);
    this.aAge = new Uint16Array(this.capacity);
    this.aSpeed = new Float32Array(this.capacity);
    this.aVision = new Float32Array(this.capacity);
    this.aGrazed = new Float32Array(this.capacity);
    this.aAlive = new Uint8Array(this.capacity);
    this.aInfected = new Uint8Array(this.capacity);
    this.aInfectedNext = new Uint8Array(this.capacity);

    this.cellStart = new Int32Array(this.cells + 1);
    this.cellAgents = new Int32Array(this.capacity);
    this.cellSpecies = new Uint32Array(this.cells);
    this.cursor = new Int32Array(this.cells);
    this.order = new Int32Array(this.capacity);

    this.spawnInitial();
    this.seedInfection();
  }

  /**
   * 初期個体の一部を感染状態にする。
   *
   * spawnInitial の**後**に、専用の乱数ストリームから引く。初期配置の途中で
   * 引くと、感染を有効にした瞬間に個体の初期座標がずれる。
   * 感染を書かない構成では1つも引かないので、既存の結果は変わらない。
   */
  private seedInfection(): void {
    if (!this.anyInfection) return;
    for (let i = 0; i < this.count; i++) {
      const inf = this.defs[this.aSpecies[i]].infection;
      if (inf === undefined || inf.initial <= 0) continue;
      if (this.infectionRng.chance(inf.initial)) this.aInfected[i] = 1;
    }
  }

  /** 種インデックス別の感染個体数を out に書き込む */
  countInfected(out: Int32Array): void {
    out.fill(0);
    for (let i = 0; i < this.count; i++) {
      if (this.aInfected[i] === 1) out[this.aSpecies[i]]++;
    }
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
    this.buildNoiseField(this.grassWeight, scale, contrast, 0x5bf03635);
    this.grassPatched = true;
  }

  /**
   * 地形設定が変わっていたら移動コストの倍率を組み直す。
   * syncGrassWeight と同じ形で、毎ステップ頭から呼ぶ。
   */
  syncTerrain(): void {
    const t = this.config.terrain;
    const scale = t ? t.scale : 0;
    const contrast = t ? t.contrast : 0;
    const target = t ? t.target : 'speed';
    if (
      scale === this.builtTerrainScale &&
      contrast === this.builtTerrainContrast &&
      target === this.terrainTarget
    ) {
      return;
    }
    this.builtTerrainScale = scale;
    this.builtTerrainContrast = contrast;
    this.terrainTarget = target;

    if (scale <= 0 || contrast <= 0) {
      this.terrainWeight.fill(1);
      this.terrainVaried = false;
      return;
    }
    if (this.width % scale !== 0 || this.height % scale !== 0) {
      throw new Error(
        `地形の大きさ ${scale} は世界の幅 ${this.width} と高さ ${this.height} を割り切る必要があります` +
          '（トーラスの継ぎ目で分布が途切れるため）',
      );
    }
    // 草のパッチとは別の種混ぜを使う。同じにすると「山が痩せている」が
    // 常に成り立ってしまい、地形の効果と資源分布の効果が完全に相関する
    this.buildNoiseField(this.terrainWeight, scale, contrast, 0x1d7a44e9);
    this.terrainVaried = true;
  }

  /**
   * 格子点に乱数を置いて滑らかに補間する（バリューノイズ）。平均1・振幅 contrast に正規化する。
   *
   * 単純にブロックごとの乱数にするとパッチが軸に沿った四角になり、
   * それ自体が動物の分布を歪めかねない。[03](../../docs/reports/03-vision-and-pursuit.md)
   * の「走査順バイアスが群れの流れとして観察された」のと同じ失敗を避けるため、
   * 角を丸めて向きの偏りを消してある。
   *
   * 乱数は世界本体とは別のストリームから引く。同じ rng を使うと、
   * パッチを無効にした場合でも消費数が変わって既存の結果が再現しなくなる。
   * `seedMix` は場ごとに変える——草のパッチと地形が同じ乱数列を使うと
   * 2つの場が完全に一致してしまい、別々の軸として動かせなくなる。
   */
  private buildNoiseField(
    out: Float32Array,
    scale: number,
    contrast: number,
    seedMix: number,
  ): void {
    const { width, height, cells } = this;
    const gw = width / scale;
    const gh = height / scale;

    const rng = new Rng((this.config.seed ^ seedMix) >>> 0);
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
        out[y * width + x] = top + (bottom - top) * ty;
      }
    }

    // 平均を0に寄せてから振幅を contrast に合わせる。
    // 平均1を保つのが要点で、これを外すと不均質にしたのか痩せさせたのか分からなくなる
    let mean = 0;
    for (let c = 0; c < cells; c++) mean += out[c];
    mean /= cells;

    let amp = 0;
    for (let c = 0; c < cells; c++) {
      const d = Math.abs(out[c] - mean);
      if (d > amp) amp = d;
    }
    const k = amp > 0 ? contrast / amp : 0;
    for (let c = 0; c < cells; c++) {
      out[c] = 1 + (out[c] - mean) * k;
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
   * speed / vision を省くと種の定義値になる。初期個体は全員この値で揃うので、
   * 変異のある構成では「1点から出発してどこへ動くか」を見ることになる。
   */
  spawn(
    speciesIdx: number,
    x: number,
    y: number,
    energy: number,
    speed?: number,
    vision?: number,
  ): boolean {
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    this.aSpecies[i] = speciesIdx;
    this.aX[i] = x;
    this.aY[i] = y;
    this.aEnergy[i] = energy;
    this.aAge[i] = 0;
    this.aSpeed[i] = speed ?? this.defs[speciesIdx].speed;
    this.aVision[i] = vision ?? this.defs[speciesIdx].visionRange;
    // 繁殖は feed より後なので、生まれた子はこのステップに食べていない。
    // 使い回した添字に前の個体の値が残ると、視野別の採食統計が汚れる
    this.aGrazed[i] = 0;
    this.aAlive[i] = 1;
    // 子は必ず未感染で生まれる（垂直感染は入れていない）。
    // 使い回した添字に前の個体の状態が残らないよう、必ず書き戻す
    this.aInfected[i] = 0;
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
    const { aSpecies, aX, aY, aEnergy, aAge, aSpeed, aVision, aGrazed, aAlive, aInfected } = this;
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
        aVision[i] = aVision[n];
        // 詰めた後に視野別の採食を集計するので、これも一緒に動かさないと
        // 「誰がどれだけ食べたか」の対応がずれる
        aGrazed[i] = aGrazed[n];
        aAlive[i] = aAlive[n];
        aInfected[i] = aInfected[n];
      }
    }
    this.count = n;
  }

  /** 実効代謝 = 基礎代謝 + 速度コスト × 速度 + 視野コスト × 視野 */
  effectiveMetabolism(speciesIdx: number): number {
    const d = this.defs[speciesIdx];
    return this.effectiveMetabolismFor(speciesIdx, d.speed, d.visionRange);
  }

  /**
   * 速度と視野を指定して実効代謝を求める。形質が個体ごとに違う構成で使う。
   * 速いこと・見ることの代償はここにしか無いので、
   * speedCost / visionCost が0だとその形質に選択が働かない。
   *
   * 視野は**連続値のまま**乗る。走査半径は整数に落とすが（quantize）、
   * 代償まで整数にすると同じ半径の区間で代償が同じになり、
   * 区間の中で選択が働かなくなって集団が区間内を漂う。
   */
  effectiveMetabolismFor(speciesIdx: number, speed: number, vision?: number): number {
    const d = this.defs[speciesIdx];
    return d.metabolism + d.speedCost * speed + d.visionCost * (vision ?? d.visionRange);
  }

  /**
   * 地形の倍率が掛かる項。`target` が `speed` なら移動コスト、`base` なら基礎代謝。
   *
   * 実効代謝は `effectiveMetabolismFor() + この項 × (倍率 - 1)` になる。
   * 倍率1のセルでは差が0なので、平坦な世界と完全に一致する。
   *
   * 対照（`base`）で振れ幅を揃えるには、この項の大きさが `speed` のときと
   * 同じになるよう contrast を調整する必要がある。同じ contrast では
   * `speedCost × speed` 対 `metabolism` で振れ幅が違う。
   */
  terrainModulatedTerm(speciesIdx: number, speed: number): number {
    const d = this.defs[speciesIdx];
    return this.terrainTarget === 'speed' ? d.speedCost * speed : d.metabolism;
  }

  /** 地形の倍率の min/max/mean。設計上 mean はちょうど1になる */
  terrainWeightStats(): { min: number; max: number; mean: number } {
    return fieldStats(this.terrainWeight, this.cells);
  }

  /**
   * 種インデックス別の速度の平均と標準偏差を out に書き込む。O(個体数)。
   * 個体がいない種は両方 0。
   */
  speedStats(mean: Float64Array, sd: Float64Array): void {
    this.traitStats(this.aSpeed, mean, sd);
  }

  /**
   * 同じものを視野について。速度と別々に呼べるようにしてあるのは、
   * どちらか片方だけを遺伝させる構成を作るため。
   */
  visionStats(mean: Float64Array, sd: Float64Array): void {
    this.traitStats(this.aVision, mean, sd);
  }

  /**
   * 種インデックス別の形質の平均と標準偏差。
   *
   * 標準偏差を出すのは、平均だけでは「集団が1点に集まっている」のか
   * 「大きい個体と小さい個体に割れている」のかが区別できないため。
   * **ただし標準偏差でも足りない**（20 で踏んだ）。二山かどうかは分布そのものを
   * 見るしかないので、判定に使うのは run.ts のヒストグラム。
   */
  private traitStats(value: Float32Array, mean: Float64Array, sd: Float64Array): void {
    const { speedSum: sum, speedSqSum: sq, speedCount: cnt } = this;
    sum.fill(0);
    sq.fill(0);
    cnt.fill(0);

    for (let i = 0; i < this.count; i++) {
      const s = this.aSpecies[i];
      const v = value[i];
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
    return fieldStats(this.grassWeight, this.cells);
  }

  /** 全種が生存しているか（絶滅判定） */
  allAlive(): boolean {
    const seen = new Uint8Array(this.defs.length);
    for (let i = 0; i < this.count; i++) seen[this.aSpecies[i]] = 1;
    for (let s = 0; s < seen.length; s++) if (seen[s] === 0) return false;
    return true;
  }
}
