import type { World } from '../core/world.ts';

/**
 * 遺伝する形質の分布。
 *
 * **平均と標準偏差では足りない。** world.ts の traitStats にも書いてあるとおり、
 * 平均だけでは「集団が1点に集まっている」のか「2つの型に割れている」のかが
 * 区別できず、標準偏差を足しても割れ方までは分からない。
 * [20](../../docs/reports/20-terrain.md) はこれで「分化した」に見える上昇
 * （0.25 → 0.40）を拾い、割ってみたら全クラス一様だった。
 *
 * そして [22](../../docs/reports/22-vision-evolution.md)・
 * [24](../../docs/reports/24-quantize-check.md)・
 * [25](../../docs/reports/25-low-hill-check.md) は
 * **どれも分布の形そのものが論点**だった（丘は2つあるのに集団は単峰か、
 * 凹凸は生態か格子か）。読み出しに平均しか出していない状態は、
 * 見たい現象が原理的に見えないということ。
 *
 * 整数の目盛りを必ず引くのは 24 のため。走査半径は端数を確率で繰り上げるので
 * 適応度に刻み幅1の周期構造ができる。分布の山が整数のどちら側に寄っているかが
 * 見えないと、「生態が決めた位置」と「格子が決めた位置」を取り違える。
 */
export type TraitKind = 'speed' | 'vision';

const BINS = 72;

interface Range {
  min: number;
  max: number;
}

/** その形質を遺伝させている種のインデックス */
function mutatingSpecies(world: World, kind: TraitKind): number[] {
  const out: number[] = [];
  world.defs.forEach((d, i) => {
    if (kind === 'speed' ? d.mutation !== undefined : d.visionMutation !== undefined) out.push(i);
  });
  return out;
}

/**
 * 横軸の範囲。**変異の下限・上限をそのまま使う**（実際の分布に合わせて伸縮させない）。
 *
 * 自動で詰めると、集団が動くたびに軸が動いて「どこに居るのか」が読めなくなる。
 * 上限に張り付いているのか内点で釣り合っているのかは
 * [10](../../docs/reports/10-speed-evolution.md) の主題そのものなので、
 * 軸は固定して分布のほうを動かす。
 */
function rangeOf(world: World, kind: TraitKind, species: number[]): Range {
  let min = Infinity;
  let max = -Infinity;
  for (const i of species) {
    const d = world.defs[i];
    const lo = kind === 'speed' ? d.mutation!.speedMin : d.visionMutation!.min;
    const hi = kind === 'speed' ? d.mutation!.speedMax : d.visionMutation!.max;
    if (lo < min) min = lo;
    if (hi > max) max = hi;
  }
  return { min, max: max > min ? max : min + 1 };
}

export class HistogramRenderer {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 150;
  /** [種インデックス * BINS + ビン] */
  private bins: Float64Array;

  constructor(
    private canvas: HTMLCanvasElement,
    private world: World,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.bins = new Float64Array(world.defs.length * BINS);
    this.resize();
  }

  reset(world: World): void {
    this.world = world;
    this.bins = new Float64Array(world.defs.length * BINS);
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.canvas.clientWidth || 380;
    if (cssW === this.w) return;
    this.w = cssW;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** その形質を遺伝させる種が無ければ描くものが無い */
  available(kind: TraitKind): boolean {
    return mutatingSpecies(this.world, kind).length > 0;
  }

  draw(kind: TraitKind): void {
    const { ctx, w, h } = this;
    const world = this.world;
    ctx.clearRect(0, 0, w, h);

    const species = mutatingSpecies(world, kind);
    if (species.length === 0) return;

    const { min, max } = rangeOf(world, kind, species);
    const value = kind === 'speed' ? world.aSpeed : world.aVision;

    this.bins.fill(0);
    const inSpecies = new Uint8Array(world.defs.length);
    for (const i of species) inSpecies[i] = 1;

    let total = 0;
    for (let i = 0; i < world.count; i++) {
      const s = world.aSpecies[i];
      if (inSpecies[s] === 0) continue;
      let b = Math.floor(((value[i] - min) / (max - min)) * BINS);
      if (b < 0) b = 0;
      if (b >= BINS) b = BINS - 1;
      this.bins[s * BINS + b]++;
      total++;
    }

    const pad = { l: 34, r: 8, t: 8, b: 20 };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;

    ctx.font = '10px system-ui';
    ctx.fillStyle = '#7c8a97';

    if (total === 0) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('個体がいません', w / 2, h / 2);
      return;
    }

    // 縦軸は種ごとに正規化しない。個体数の少ない種が同じ高さで並ぶと
    // 「両方とも同じくらい居る」に見えてしまう（谷を平均で隠すのと同じ形の嘘）
    let peak = 0;
    for (let k = 0; k < this.bins.length; k++) if (this.bins[k] > peak) peak = this.bins[k];
    if (peak <= 0) return;

    const x = (v: number) => pad.l + ((v - min) / (max - min)) * plotW;
    const y = (n: number) => pad.t + plotH - (n / peak) * plotH;

    // 整数の目盛り。24 の量子化はここにしか現れない
    ctx.strokeStyle = '#262e36';
    ctx.lineWidth = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const tickStep = max - min > 6 ? 2 : 1;
    for (let v = Math.ceil(min); v <= max; v += tickStep) {
      const px = Math.round(x(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, pad.t);
      ctx.lineTo(px, pad.t + plotH);
      ctx.stroke();
      ctx.fillText(String(v), px, pad.t + plotH + 4);
    }

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(peak), pad.l - 5, y(peak));
    ctx.fillText('0', pad.l - 5, y(0));

    // 種ごとに階段状の面で重ねる。線だけだと重なった所で消える
    for (const s of species) {
      const def = world.defs[s];
      ctx.beginPath();
      ctx.moveTo(x(min), y(0));
      for (let b = 0; b < BINS; b++) {
        const n = this.bins[s * BINS + b];
        const x0 = pad.l + (b / BINS) * plotW;
        const x1 = pad.l + ((b + 1) / BINS) * plotW;
        ctx.lineTo(x0, y(n));
        ctx.lineTo(x1, y(n));
      }
      ctx.lineTo(x(max), y(0));
      ctx.closePath();
      ctx.fillStyle = def.color + '4d'; // 30%
      ctx.fill();
      ctx.strokeStyle = def.color;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // 平均を破線で。**分布と重ねて初めて「平均が何を代表していないか」が見える**
    ctx.setLineDash([3, 3]);
    for (const s of species) {
      let sum = 0;
      let n = 0;
      for (let b = 0; b < BINS; b++) {
        const c = this.bins[s * BINS + b];
        sum += c * (min + ((b + 0.5) / BINS) * (max - min));
        n += c;
      }
      if (n === 0) continue;
      const px = Math.round(x(sum / n)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, pad.t);
      ctx.lineTo(px, pad.t + plotH);
      ctx.strokeStyle = world.defs[s].color;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}
