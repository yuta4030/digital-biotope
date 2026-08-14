import type { World } from '../core/world.ts';

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/**
 * 盤面に何を出すか。
 *
 * 既定（`life`）以外は**場そのもの**を見るためにある。地形もパッチも
 * 「平均1に正規化してあるから総量は変わらない」という前提で入れた軸だが、
 * 08・14・20 で3回、その前提が外れている
 * （[OVERVIEW §4](../../docs/OVERVIEW.md#4-一番痛い教訓--動かした覚えのない軸が動く)）。
 * 実際にどんな場ができているかを見ないまま強さのつまみだけ動かすのは、
 * その4回目を用意しているのと同じ。
 */
export type GridLayer = 'life' | 'grass' | 'terrain' | 'patch' | 'detritus';

/** 倍率の場（平均1）を色に落とす。1を灰、低い側を青、高い側を赤に振る */
function divergeAt(data: Uint8ClampedArray, o: number, v: number, span: number): void {
  const t = span > 0 ? Math.max(-1, Math.min(1, (v - 1) / span)) : 0;
  if (t >= 0) {
    data[o] = 40 + t * 190;
    data[o + 1] = 46 + t * 40;
    data[o + 2] = 52 - t * 20;
  } else {
    data[o] = 40 + t * 25;
    data[o + 1] = 46 - t * 60;
    data[o + 2] = 52 - t * 150;
  }
}

/**
 * グリッド描画。
 *
 * セル数と同じ解像度の ImageData を1枚組み立てて、それを拡大して貼る。
 * セルごとに fillRect を呼ぶより一桁速く、ライフゲーム的なドット絵にもなる。
 */
export class GridRenderer {
  private ctx: CanvasRenderingContext2D;
  private off: HTMLCanvasElement;
  private offCtx: CanvasRenderingContext2D;
  private img: ImageData;
  private rgb: Uint8Array;
  private occ: Int16Array;
  /** occ に採用した個体が感染しているか。感染は色を薄めて表す */
  private occInfected: Uint8Array;
  layer: GridLayer = 'life';

  constructor(
    private canvas: HTMLCanvasElement,
    world: World,
    scale: number,
  ) {
    canvas.width = world.width * scale;
    canvas.height = world.height * scale;

    this.ctx = canvas.getContext('2d')!;
    this.ctx.imageSmoothingEnabled = false;

    this.off = document.createElement('canvas');
    this.off.width = world.width;
    this.off.height = world.height;
    this.offCtx = this.off.getContext('2d')!;
    this.img = this.offCtx.createImageData(world.width, world.height);

    this.occ = new Int16Array(world.cells);
    this.occInfected = new Uint8Array(world.cells);
    this.rgb = new Uint8Array(world.defs.length * 3);
    world.defs.forEach((def, i) => {
      const [r, g, b] = hexToRgb(def.color);
      this.rgb[i * 3] = r;
      this.rgb[i * 3 + 1] = g;
      this.rgb[i * 3 + 2] = b;
    });
  }

  draw(w: World): void {
    const data = this.img.data;
    const grassMax = w.config.grass.max;
    const occ = this.occ;
    const occInf = this.occInfected;
    const showLife = this.layer === 'life';

    if (showLife) {
      // 同じセルに複数いる場合は種インデックスの大きい方（上位の捕食者）を表示する。
      // 単純な後勝ちだと、個体数の少ない頂点捕食者が草食動物に埋もれて見えなくなる
      occ.fill(-1);
      for (let i = 0; i < w.count; i++) {
        const c = w.aY[i] * w.width + w.aX[i];
        const s = w.aSpecies[i];
        if (s > occ[c]) {
          occ[c] = s;
          occInf[c] = w.aInfected[i];
        }
      }
    }

    // 場を見るときの振れ幅。倍率の場は 1±contrast なので、
    // 設定した強さをそのまま色の上限にすれば「強さ0.3の世界」の見た目が固定される
    const terrainSpan = w.config.terrain?.contrast ?? 0;
    const patchSpan = w.config.grass.patch?.contrast ?? 0;
    let detritusMax = 0;
    if (this.layer === 'detritus') {
      for (let c = 0; c < w.cells; c++) if (w.detritus[c] > detritusMax) detritusMax = w.detritus[c];
    }

    for (let c = 0; c < w.cells; c++) {
      const o = c << 2;
      data[o + 3] = 255;

      if (showLife && occ[c] >= 0) {
        const k = occ[c] * 3;
        if (occInf[c] === 1) {
          // 感染個体は白へ寄せる。別の色を割り当てると種の色と競合するし、
          // 種が増えるたびに色を足すことになる
          data[o] = (this.rgb[k] + 255 * 2) / 3;
          data[o + 1] = (this.rgb[k + 1] + 255 * 2) / 3;
          data[o + 2] = (this.rgb[k + 2] + 255 * 2) / 3;
        } else {
          data[o] = this.rgb[k];
          data[o + 1] = this.rgb[k + 1];
          data[o + 2] = this.rgb[k + 2];
        }
        continue;
      }

      switch (this.layer) {
        case 'terrain':
          divergeAt(data, o, w.terrainWeight[c], terrainSpan);
          break;
        case 'patch':
          divergeAt(data, o, w.grassWeight[c], patchSpan);
          break;
        case 'detritus': {
          const t = detritusMax > 0 ? w.detritus[c] / detritusMax : 0;
          data[o] = 20 + t * 210;
          data[o + 1] = 22 + t * 150;
          data[o + 2] = 26 + t * 30;
          break;
        }
        default: {
          // 空きセルは草の量に応じた緑
          const t = (w.grass[c] + w.grassB[c]) / grassMax;
          data[o] = 10 + t * 26;
          data[o + 1] = 18 + t * 116;
          data[o + 2] = 14 + t * 44;
        }
      }
    }

    this.offCtx.putImageData(this.img, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.off, 0, 0, this.canvas.width, this.canvas.height);
  }
}

/** 固定長の履歴。古いものから捨てる */
class Ring {
  private buf: Float32Array;
  private head = 0;
  len = 0;

  constructor(private cap: number) {
    this.buf = new Float32Array(cap);
  }

  push(v: number): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.cap;
    if (this.len < this.cap) this.len++;
  }

  /** k=0 が最古 */
  at(k: number): number {
    return this.buf[(this.head - this.len + k + this.cap) % this.cap];
  }

  max(): number {
    let m = 0;
    for (let k = 0; k < this.len; k++) {
      const v = this.at(k);
      if (v > m) m = v;
    }
    return m;
  }

  clear(): void {
    this.head = 0;
    this.len = 0;
  }
}

/** 個体数の推移グラフ。草は参照用に薄く塗る */
export class GraphRenderer {
  private ctx: CanvasRenderingContext2D;
  private w: number;
  private h: number;
  private series: Ring[];
  private grass: Ring;
  /** 対数軸にするか。谷が1〜5体の種を見るときはこちらでないと読めない */
  logScale = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private world: World,
    private points = 600,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.w = 0;
    this.h = 260;

    this.series = world.defs.map(() => new Ring(points));
    this.grass = new Ring(points);

    this.resize();
  }

  /** CSS上の幅に合わせてバッファを取り直す。ウィンドウリサイズ時に呼ぶ */
  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.canvas.clientWidth || 380;
    if (cssW === this.w) return;

    this.w = cssW;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * 毎ステップ呼ぶ。草の総量はセル数ぶん舐めるので間引いて渡す。
   * 個体数は呼び出し側が数えたものを受け取る（読み出しと計器でも要るので、
   * 同じ O(個体数) の走査を3回やる理由が無い）。
   */
  sample(counts: Int32Array, totalGrass: number): void {
    for (let i = 0; i < counts.length; i++) this.series[i].push(counts[i]);
    this.grass.push(totalGrass);
  }

  /** プリセット切替で種の数が変わりうるので、系列ごと作り直す */
  reset(world: World): void {
    this.world = world;
    this.series = world.defs.map(() => new Ring(this.points));
    this.grass.clear();
  }

  draw(): void {
    const { ctx, w, h } = this;
    const pad = { l: 40, r: 8, t: 10, b: 18 };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;

    ctx.clearRect(0, 0, w, h);

    const len = this.series[0]?.len ?? 0;
    if (len < 2) return;

    let yMax = 0;
    for (const s of this.series) yMax = Math.max(yMax, s.max());
    yMax = Math.max(10, Math.ceil(yMax / 100) * 100);

    const x = (k: number) => pad.l + (k / (this.points - 1)) * plotW;

    // 対数軸。**上位捕食者は谷で1〜5体まで落ちるので、線形軸では
    // 絶滅を決めている当の区間が軸の下端に潰れて見えない**（筋1）。
    // 0体は描けないので下端に落とす——絶滅が「線が底に張り付く」で読める
    const logTop = Math.log10(Math.max(10, yMax));
    const y = this.logScale
      ? (v: number) =>
          v < 1 ? pad.t + plotH : pad.t + plotH - (Math.log10(v) / logTop) * plotH
      : (v: number) => pad.t + plotH - (v / yMax) * plotH;

    // 横の目盛り
    ctx.strokeStyle = '#262e36';
    ctx.fillStyle = '#7c8a97';
    ctx.lineWidth = 1;
    ctx.font = '10px system-ui';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const ticks: number[] = [];
    if (this.logScale) {
      for (let e = 0; Math.pow(10, e) <= Math.max(10, yMax); e++) ticks.push(Math.pow(10, e));
    } else {
      for (let g = 0; g <= 4; g++) ticks.push((yMax / 4) * g);
    }
    for (const v of ticks) {
      const py = Math.round(y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, py);
      ctx.lineTo(w - pad.r, py);
      ctx.stroke();
      ctx.fillText(String(v), pad.l - 6, py);
    }

    // 草（自分のスケールで正規化した参照線）
    const grassCap = this.world.cells * this.world.config.grass.max;
    if (grassCap > 0) {
      ctx.beginPath();
      ctx.moveTo(x(0), pad.t + plotH);
      for (let k = 0; k < len; k++) {
        ctx.lineTo(x(k), pad.t + plotH - (this.grass.at(k) / grassCap) * plotH);
      }
      ctx.lineTo(x(len - 1), pad.t + plotH);
      ctx.closePath();
      ctx.fillStyle = 'rgba(90, 190, 100, 0.13)';
      ctx.fill();
    }

    // 各種の個体数
    this.world.defs.forEach((def, i) => {
      ctx.beginPath();
      for (let k = 0; k < len; k++) {
        const px = x(k);
        const py = y(this.series[i].at(k));
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = def.color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }
}
