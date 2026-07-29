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

  /** 初期個体数 */
  initialCount: number;
  /** 初期エネルギー */
  initialEnergy: number;
}

export interface GrassConfig {
  /** セルあたりの草の最大量 */
  max: number;
  /** 1ステップあたりの回復量 */
  regrow: number;
  /** 初期量（max に対する割合 0-1） */
  initialRatio: number;
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
