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

  /** 1ステップに動けるセル数。0なら動かない */
  speed: number;
  /**
   * 視界の広さ（セル）。0ならランダムウォーク。
   * 1以上なら周囲を見て、捕食者から逃げる → 獲物を追う → 草の多い方へ、の順で動く。
   * 広げるほど1ステップの計算量が (2r+1)^2 で増えるので効く範囲で小さく。
   */
  visionRange: number;
  /**
   * 空腹とみなすエネルギー。下回ると逃走より採餌を優先する（リスクを取る）。
   *
   * 0 なら常に満腹扱いで、捕食者が見えている限り餌を探さない。視野0の種には
   * 影響しない（そもそも逃走も追跡もしないため）。
   */
  hungerThreshold: number;

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
