/**
 * 移動速度の変異。指定した種は speed を種の定数ではなく個体ごとの値として持ち、
 * 繁殖のたびに親の値へノイズを乗せて子に渡す。
 *
 * 省略した種は全個体が speed のまま動かず、乱数も一切消費しないので、
 * 既存の構成の結果はこの機構を入れる前と完全に一致する。
 */
export interface MutationDef {
  /** 子に乗るずれの標準偏差（速度の単位）。0 なら親と同じ速度の子が生まれる */
  speedSigma: number;
  /** 速度の下限。0 を許すと動かない個体が生まれる */
  speedMin: number;
  /** 速度の上限 */
  speedMax: number;
}

/**
 * 種の定義。捕食関係を preys で持つので、種を足せば連鎖が伸びる。
 * ここに書いたものが全てで、シミュレーション側に種別のハードコードは無い。
 */
export interface SpeciesDef {
  id: number;
  name: string;
  /** 描画色 "#rrggbb" */
  color: string;

  /** 地面の草を食べるか */
  eatsGrass: boolean;
  /** 捕食する種の id。複数指定可 */
  preys: number[];

  /**
   * 1ステップあたりの基礎エネルギー消費。実際に減る量はこれに行動コストが乗る：
   *
   *   実効代謝 = metabolism + speedCost × speed + visionCost × visionRange
   *
   * 両コストが0なら実効代謝 = metabolism で、行動は無料。
   */
  metabolism: number;
  /** 移動速度1あたりの追加消費。速い個体ほど燃費が悪くなる */
  speedCost: number;
  /** 視野1あたりの追加消費。感覚器の維持費に相当 */
  visionCost: number;
  /** 草を1回食べて得るエネルギー（セルの残量が上限） */
  gainFromGrass: number;
  /** 獲物を1体食べて得るエネルギー */
  gainFromPrey: number;
  /**
   * 同じセルの獲物に襲いかかって成功する確率 (0-1)。狩りは1ステップ1回で、
   * 失敗するとそのステップは何も食べられない。
   *
   * 視界を使う場合はここを1未満にしないと成立しない。追跡が決定的なので、
   * 1.0のままだと「速度が足りず永遠に捕まえられない」か
   * 「必ず捕まえて獲物を絶滅させる」の二択になる。
   */
  captureRate: number;

  /** 繁殖に必要なエネルギー */
  reproduceThreshold: number;
  /** 条件を満たしたステップで実際に繁殖する確率 */
  reproduceProb: number;
  /** 親が子に渡すエネルギーの割合 (0-1) */
  reproduceCost: number;

  /**
   * 1ステップに動けるセル数。0なら動かない。
   *
   * mutation を指定した種では、これは初期個体に配る値でしかなく、
   * 以降の各個体の速度は遺伝と選択で決まる。整数でなくてもよい。
   */
  speed: number;
  /**
   * 速度を遺伝させる場合の設定。省略すると speed は種の定数として固定される。
   * 実効代謝に speedCost が乗るので、速いことに代償が無いと一方向に上がり続ける。
   */
  mutation?: MutationDef;
  /**
   * 視界の広さ（セル）。0ならランダムウォーク。
   * 1以上なら周囲を見て、捕食者から逃げる → 獲物を追う → 草の多い方へ、の順で動く。
   * 広げるほど1ステップの計算量が (2r+1)^2 で増えるので効く範囲で小さく。
   */
  visionRange: number;
  /** 寿命（ステップ）。0なら寿命なし */
  maxAge: number;

  /**
   * 死んだときに自分のいたセルの草へ戻る量。0なら還元なし（既定）。
   *
   * **食べられて死んだ個体は戻さない。** 体が捕食者に移っているため。
   * 戻るのは餓死と寿命死だけで、実装上は捕食で死んだ個体が代謝の手番に
   * 到達しないことで自動的にそうなる。
   *
   * これは草の回復速度とは別口でエネルギーを注ぎ込む操作なので、
   * 放っておくと豊穣化（[06](../../docs/reports/06-enrichment.md)）と区別がつかない。
   * 実際に死骸から入った量は step が別に数えている。
   */
  corpseGrass: number;
  /**
   * 死骸をまき散らす半径（セル）。0なら死んだセルに全部落ちる（既定）。
   * 1以上なら (2r+1)^2 セルへ均等に分ける。
   *
   * 死骸は1セルに固まって落ちるので、草食動物が1回に食べられる量（採食量）を
   * 大きく超えた山になる。時間方向の均し（detritusRelease）と対にして、
   * **空間方向に均したらどうなるか**を見るための軸。
   */
  corpseSpread: number;

  /** 初期個体数 */
  initialCount: number;
  /** 初期エネルギー */
  initialEnergy: number;
}

/**
 * 草地の空間的な不均質さ。回復速度をセルごとに変える。
 *
 * 重みの平均はちょうど1に正規化されるので、`regrow` が表す
 * **世界全体の生産量は変わらない**。分布だけが変わる。
 * 豊穣化（生産量そのものを増やす操作、[06](../../docs/reports/06-enrichment.md)）と
 * 混ざらないようにするため。
 */
export interface GrassPatchConfig {
  /**
   * パッチの大きさ（セル）。世界の幅と高さを割り切る値であること。
   * 小さいほど細かいまだら、大きいほど広い草原と荒野に分かれる。
   */
  scale: number;
  /**
   * 不均質の強さ (0-1)。0なら一様。
   * 回復速度は最も痩せたセルで `regrow × (1-contrast)`、
   * 最も豊かなセルで `regrow × (1+contrast)` になる。1なら痩せた側は完全な不毛地。
   */
  contrast: number;
}

export interface GrassConfig {
  /** セルあたりの草の最大量 */
  max: number;
  /** 1ステップあたりの回復量。パッチがある場合は世界の平均値になる */
  regrow: number;
  /** 初期量（max に対する割合 0-1） */
  initialRatio: number;
  /** 空間的な不均質。省略か contrast=0 なら一様（既定） */
  patch?: GrassPatchConfig;
  /**
   * 死骸をいったんセルごとの在庫（デトリタス）に積み、毎ステップこの割合だけ
   * 草に変える (0-1]。1なら在庫を素通りして即座に草になる＝既定で、
   * [08](../../docs/reports/08-corpse-recycling.md) と同じ挙動。
   *
   * 在庫はローパスフィルタとして働くので、**総入力を変えずに流入のばらつき
   * だけを下げられる**。08で「効いているのは変動係数」まで絞れたので、
   * それを直接動かすための操作。
   */
  detritusRelease?: number;
}

export interface WorldConfig {
  width: number;
  height: number;
  seed: number;
  grass: GrassConfig;
  species: SpeciesDef[];
  /** エージェント数の上限。超える分は繁殖が抑制される */
  maxAgents: number;
}

/** 1ステップ分の統計 */
export interface StepStats {
  step: number;
  /** species id -> 個体数 */
  population: Map<number, number>;
  /** 草の総量 */
  totalGrass: number;
}
