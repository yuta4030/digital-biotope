/**
 * シード付き擬似乱数（mulberry32）。
 * スイープで見つけた条件を後から同じ結果で再生するために、
 * Math.random() は使わず必ずこれを通す。
 */
export class Rng {
  private a: number;

  constructor(seed: number) {
    this.a = seed >>> 0;
  }

  /** [0, 1) */
  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [0, n) の整数 */
  int(n: number): number {
    return (this.next() * n) | 0;
  }

  /** [min, max] の整数 */
  intRange(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }

  /** 確率 p で true */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /**
   * 平均0・標準偏差1の正規乱数（Box-Muller）。
   *
   * この方法は一度に2つ作れるが、片方は捨てている。取っておくと
   * 「1回の繁殖で next() を2回引く」という対応が崩れ、
   * 途中経過を追うときに乱数列と出来事が突き合わせられなくなるため。
   */
  normal(): number {
    // next() は 0 を返しうる。log(0) を踏まないよう (0, 1] に寄せる
    const u = 1 - this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Fisher-Yates。配列を破壊的にシャッフルする */
  shuffle(arr: Int32Array, len: number): void {
    for (let i = len - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
  }
}
