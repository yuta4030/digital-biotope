import type { World } from '../core/world.ts';

/**
 * 計器の読み出し。
 *
 * World が毎ステップ数えている量（採食・死因の内訳・草の流入・地形の実現倍率・
 * 感染経路）はすべて**表示側から見えていなかった**。この模型で覆った結論5件のうち
 * 3件は「動かした覚えのない軸が動いていた」ことが原因で、それに気づけたのは
 * どれも計器を分けて数えていたからだった
 * （[OVERVIEW §4](../../docs/OVERVIEW.md#4-一番痛い教訓--動かした覚えのない軸が動く)）。
 * つまみを動かして眺めるだけの画面は、その3件をそのまま素通りさせる。
 *
 * ## 窓を取る理由
 *
 * 1ステップぶんの値はほとんど整数の0か1で、読める量になっていない
 * （個体数1300の種で感染死は1ステップに数体）。だから直近 `cap` 歩の合計を
 * 保って割る。単位はレポートと揃えて **%/歩**（1個体が1歩に受ける確率）にしてある
 * ——[17](../../docs/reports/17-infection.md) の「0.90%/歩 対 1.39%/歩」と
 * そのまま突き合わせられる。
 *
 * ## 最小値を出す理由
 *
 * **絶滅は平均では予測できない。振れ幅の下端が0に当たった瞬間に決まる。**
 * 01・04・06・07・09 が全部この形で、上位捕食者ほど谷が浅い数字（1〜5体）になる。
 * だから現在値だけでなく窓の中の最小と最大を必ず並べる。
 */

/** 種ごとに窓へ積む量 */
const S_POP = 0;
const S_GRAZE_AMT = 1;
const S_GRAZE_CNT = 2;
const S_GRAZE_A = 3;
const S_GRAZE_B = 4;
const S_D_EATEN = 5;
const S_D_OTHER = 6;
const S_D_DISTURB = 7;
const S_D_CROWD = 8;
const S_D_INFECT = 9;
const S_INFECTED = 10;
const S_INF_CONTACT = 11;
const S_INF_SPONT = 12;
const PER_SPECIES = 13;

/** 世界ぜんたいで窓へ積む量 */
const W_GRASS_ADDED = 0;
const W_GRASS_CORPSE = 1;
const W_TERRAIN_PAID = 2;
const W_TERRAIN_FLAT = 3;
const PER_WORLD = 4;

export class Instruments {
  private nSpecies: number;
  private slots: number;
  /** [ステップ * slots + スロット] の環状バッファ */
  private buf: Float64Array;
  private sums: Float64Array;
  private head = 0;
  private filled = 0;
  private infected: Int32Array;

  constructor(
    private world: World,
    private cap = 300,
  ) {
    this.nSpecies = world.defs.length;
    this.slots = this.nSpecies * PER_SPECIES + PER_WORLD;
    this.buf = new Float64Array(this.cap * this.slots);
    this.sums = new Float64Array(this.slots);
    this.infected = new Int32Array(this.nSpecies);
  }

  /** プリセット切替で種の数が変わるので、窓ごと作り直す */
  reset(world: World): void {
    this.world = world;
    this.nSpecies = world.defs.length;
    this.slots = this.nSpecies * PER_SPECIES + PER_WORLD;
    this.buf = new Float64Array(this.cap * this.slots);
    this.sums = new Float64Array(this.slots);
    this.infected = new Int32Array(this.nSpecies);
    this.head = 0;
    this.filled = 0;
  }

  get windowSteps(): number {
    return this.filled;
  }

  /**
   * 1ステップぶん取り込む。**step の直後に呼ぶこと。**
   * World の計器は毎ステップ上書きされるので、1歩でも飛ばすとその歩は失われる。
   *
   * counts は呼び出し側が既に数えているものを受け取る。同じ O(個体数) の走査を
   * グラフとここで2回やる理由が無い。
   */
  sample(w: World, counts: Int32Array): void {
    const base = this.head * this.slots;
    const buf = this.buf;
    const sums = this.sums;

    // 環状バッファから出ていく1歩ぶんを合計から差し引く
    if (this.filled === this.cap) {
      for (let k = 0; k < this.slots; k++) sums[k] -= buf[base + k];
    }

    if (w.anyInfection) w.countInfected(this.infected);
    else this.infected.fill(0);

    for (let s = 0; s < this.nSpecies; s++) {
      const o = base + s * PER_SPECIES;
      buf[o + S_POP] = counts[s];
      buf[o + S_GRAZE_AMT] = w.grazeAmount[s];
      buf[o + S_GRAZE_CNT] = w.grazeCount[s];
      buf[o + S_GRAZE_A] = w.grazeAmountA[s];
      buf[o + S_GRAZE_B] = w.grazeAmountB[s];
      buf[o + S_D_EATEN] = w.deathsEaten[s];
      buf[o + S_D_OTHER] = w.deathsOther[s];
      buf[o + S_D_DISTURB] = w.deathsDisturbance[s];
      buf[o + S_D_CROWD] = w.deathsCrowding[s];
      buf[o + S_D_INFECT] = w.deathsInfection[s];
      buf[o + S_INFECTED] = this.infected[s];
      buf[o + S_INF_CONTACT] = w.infectedByContact[s];
      buf[o + S_INF_SPONT] = w.infectedBySpontaneous[s];
    }

    const wo = base + this.nSpecies * PER_SPECIES;
    buf[wo + W_GRASS_ADDED] = w.grassAdded;
    buf[wo + W_GRASS_CORPSE] = w.grassFromCorpses;
    buf[wo + W_TERRAIN_PAID] = w.terrainCostPaid;
    buf[wo + W_TERRAIN_FLAT] = w.terrainCostFlat;

    for (let k = 0; k < this.slots; k++) sums[k] += buf[base + k];

    this.head = (this.head + 1) % this.cap;
    if (this.filled < this.cap) this.filled++;
  }

  private sum(species: number, slot: number): number {
    return this.sums[species * PER_SPECIES + slot];
  }

  private worldSum(slot: number): number {
    return this.sums[this.nSpecies * PER_SPECIES + slot];
  }

  /** 窓の中の最小・最大。谷を見るために要るので、平均と一緒には畳まない */
  private popRange(species: number): { min: number; max: number } {
    let min = Infinity;
    let max = 0;
    const off = species * PER_SPECIES + S_POP;
    for (let k = 0; k < this.filled; k++) {
      const v = this.buf[k * this.slots + off];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min: min === Infinity ? 0 : min, max };
  }

  render(el: HTMLElement, counts: Int32Array): void {
    const w = this.world;
    if (this.filled === 0) {
      el.innerHTML = '';
      return;
    }

    const pct = (x: number) => (x * 100).toFixed(2);
    const hasInfection = w.anyInfection;
    const hasTwo = w.twoResources;

    // 見出しは短く。長い説明は下の注に回す——列が7本になる構成があるので、
    // 見出しの幅がそのまま表の幅になる
    const head = ['種', '個体数', '窓内', '採食', '死亡 %/歩'];
    if (hasTwo) head.push('摂取 A:B');
    if (hasInfection) head.push('感染');

    const rows: string[] = [];
    for (let s = 0; s < this.nSpecies; s++) {
      const def = w.defs[s];
      const popSum = this.sum(s, S_POP);
      const { min, max } = this.popRange(s);

      // 「何%の歩で、1回あたりいくら食べたか」。21 が視野の有無で
      // 94%/0.423 対 46%/1.032 を出した量そのもの。合計は同じでも
      // 制限しているものが違う——それが2本目のニッチ軸の正体だった
      const gCnt = this.sum(s, S_GRAZE_CNT);
      const gAmt = this.sum(s, S_GRAZE_AMT);
      const graze =
        !def.eatsGrass || popSum === 0
          ? '—'
          : `${pct(gCnt / popSum)}% の歩 × ${(gCnt > 0 ? gAmt / gCnt : 0).toFixed(3)}`;

      // 死因は必ず分けて出す。同じ「%/歩」でも、被食・餓死・大量死・密度依存・感染は
      // 形質を見るものと見ないものが混ざっている。正味だけ見ると
      // 逆を向いた選択差が打ち消し合って「何も効いていない」に見える
      const parts: string[] = [];
      const put = (label: string, v: number) => {
        if (v > 0) parts.push(`${label} ${pct(v / popSum)}`);
      };
      if (popSum > 0) {
        put('被食', this.sum(s, S_D_EATEN));
        put('餓死/寿命', this.sum(s, S_D_OTHER));
        put('大量死', this.sum(s, S_D_DISTURB));
        put('密度', this.sum(s, S_D_CROWD));
        put('感染', this.sum(s, S_D_INFECT));
      }

      // 折り返さない列（桁が揃っていないと読めないもの）だけ num を付ける
      const cells: { html: string; num?: boolean }[] = [
        { html: `<span class="sw" style="background:${def.color}"></span>${def.name}` },
        { html: `<b>${counts[s]}</b>`, num: true },
        { html: min === max ? String(min) : `${min} – ${max}`, num: true },
        { html: graze },
        { html: parts.length > 0 ? parts.join('　') : '—' },
      ];

      if (hasTwo) {
        const a = this.sum(s, S_GRAZE_A);
        const b = this.sum(s, S_GRAZE_B);
        // 名目の配分ではなく**実際に取った内訳**。23 で「p=0.90 の名目上の
        // 専門型が摂取 A50%＝事実上の汎用型だった」を踏んだので、
        // 設定値ではなく実測を出す
        cells.push({
          html: a + b > 0 ? `${Math.round((a / (a + b)) * 100)} : ${Math.round((b / (a + b)) * 100)}` : '—',
          num: true,
        });
      }
      if (hasInfection) {
        const infRate = popSum > 0 ? this.sum(s, S_INFECTED) / popSum : 0;
        const con = this.sum(s, S_INF_CONTACT);
        const spo = this.sum(s, S_INF_SPONT);
        // 接触と自然発生の内訳。自然発生が主なら密度に依存しない死で、
        // 15 で潰した「均等な死」をやっているだけになる
        const route = con + spo > 0 ? `（接触 ${Math.round((con / (con + spo)) * 100)}%）` : '';
        cells.push({ html: def.infection === undefined ? '—' : `${Math.round(infRate * 100)}%${route}` });
      }

      rows.push(
        `<tr>${cells.map((c) => `<td${c.num ? ' class="num"' : ''}>${c.html}</td>`).join('')}</tr>`,
      );
    }

    // --- 世界ぜんたい ---
    const notes: string[] = [];
    const steps = this.filled;
    const added = this.worldSum(W_GRASS_ADDED) / steps;
    const corpse = this.worldSum(W_GRASS_CORPSE) / steps;
    // 08 で踏んだ交絡。回復速度をいじっていないのだからエネルギー量は同じはず、
    // と思っていたら死骸から毎ステップ数百が入っていた。分けて出す
    notes.push(
      `草への流入 ${added.toFixed(1)}/歩` +
        (corpse > 0
          ? `　死骸から <b>${corpse.toFixed(1)}</b>/歩（総入力の ${Math.round((corpse / (added + corpse)) * 100)}%）`
          : ''),
    );

    if (w.terrainVaried) {
      const paid = this.worldSum(W_TERRAIN_PAID);
      const flat = this.worldSum(W_TERRAIN_FLAT);
      // 倍率の平均は設計上ちょうど1。実現値がずれるのは個体が地形に偏ったとき。
      // 20 はこれを見ていたので「不均質にした効果」と「コストが下がった効果」を分けられた
      const realized = flat > 0 ? paid / flat : 1;
      const stats = w.terrainWeightStats();
      notes.push(
        `地形の実現倍率 <b>${realized.toFixed(3)}</b>（設計上は1.000／場は ${stats.min.toFixed(2)}–${stats.max.toFixed(2)}）`,
      );
    }
    if (w.grassPatched) {
      const stats = w.grassWeightStats();
      notes.push(`パッチの倍率 ${stats.min.toFixed(2)}–${stats.max.toFixed(2)}（平均 ${stats.mean.toFixed(3)}）`);
    }
    if (w.anyCorpse) {
      notes.push(`死骸の在庫 ${w.totalDetritus().toFixed(0)}`);
    }
    // 見出しを短くしたぶんの説明。単位はレポートと同じなので、
    // ここを読めば表の数字をそのまま報告の数字と突き合わせられる
    notes.push(
      `<span class="dim">窓内＝直近${steps}歩の個体数の最小–最大（谷）　` +
        `採食＝採食に成功した歩の割合 × 1回あたりの量　` +
        `死亡＝1個体が1歩に受ける確率（%/歩）</span>`,
    );

    el.innerHTML =
      `<h2>計器<span class="win">直近 ${steps} 歩</span></h2>` +
      // 列が多いので、狭い画面では表だけを横スクロールさせる。
      // ページごと横に伸びると盤面まで見えなくなる
      `<div class="scroll"><table class="inst">` +
      `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>` +
      `<tbody>${rows.join('')}</tbody></table></div>` +
      `<div class="derived">${notes.join('<br>')}</div>`;
  }
}
