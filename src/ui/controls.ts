import type { WorldConfig } from '../core/types.ts';

/** 世界の幅120と高さ90を割り切る値。パッチはトーラスの継ぎ目でつながる必要がある */
const PATCH_SCALES = [5, 6, 10, 15, 30];

/** 大量死の平均間隔。割合と組にして「割合÷間隔」を揃えられるよう、5倍刻みで並べてある */
const DISTURB_INTERVALS = [20, 100, 500, 2500];

/**
 * 種定義からスライダーを組み立てる。
 * 種を presets に足せばここは触らずにUIが増える。
 */
export function buildControls(container: HTMLElement, config: WorldConfig): void {
  container.innerHTML = '';

  const env = group('環境');
  slider(env, '草の回復速度', 0.01, 0.4, 0.01, 2,
    () => config.grass.regrow, (v) => (config.grass.regrow = v));
  slider(env, '草の最大量', 1, 20, 1, 0,
    () => config.grass.max, (v) => (config.grass.max = v));

  // パッチは回復速度の「分布」を変えるだけで、平均は上の回復速度のまま。
  // 世界の大きさ(120×90)を割り切る値だけを選べるようにしてある
  const patch = (config.grass.patch ??= { scale: 10, contrast: 0 });
  slider(env, 'パッチの強さ', 0, 1, 0.05, 2,
    () => patch.contrast, (v) => (patch.contrast = v));
  slider(env, 'パッチの大きさ', 0, PATCH_SCALES.length - 1, 1, 0,
    () => Math.max(0, PATCH_SCALES.indexOf(patch.scale)),
    (v) => (patch.scale = PATCH_SCALES[v]),
    undefined,
    (v) => String(PATCH_SCALES[v]));

  // 資源が2本の構成でだけ供給比を出す。**ここで初めて split を生やしてはいけない**
  // ——生やした瞬間に草の初期化が2本ぶんに変わり、既存の構成の結果が動く。
  // 資源を2本にするのは presets の仕事（types.ts の ResourceSplitConfig 参照）
  const split = config.grass.split;
  if (split !== undefined) {
    slider(env, '資源Aの供給比', 0, 1, 0.05, 2,
      () => split.supplyA, (v) => (split.supplyA = v));
  }

  // 地形は「移動の代償」の分布を変える。パッチ（資源の分布）とは別の軸なので
  // 同じ大きさの選択肢を共有しつつ、場そのものは別の乱数列から作られる。
  // 強さ0（既定）なら全セルの倍率が1で、掛け算そのものを省く
  const terrain = (config.terrain ??= { scale: 30, contrast: 0, target: 'speed' });
  slider(env, '地形の強さ', 0, 1, 0.05, 2,
    () => terrain.contrast, (v) => (terrain.contrast = v));
  slider(env, '地形の大きさ', 0, PATCH_SCALES.length - 1, 1, 0,
    () => Math.max(0, PATCH_SCALES.indexOf(terrain.scale)),
    (v) => (terrain.scale = PATCH_SCALES[v]),
    undefined,
    (v) => String(PATCH_SCALES[v]));
  // 20 の対照。同じ場・同じ生成器のまま「形質との結合だけ」を外す。
  // base 側では速度の限界代償が speedCost で一定になるので、
  // ここで差が消えれば効いていたのは不均質さではなく形質の差異化のほう
  choice(env, '地形が掛かる項', [
    { value: 'speed', label: '移動コスト' },
    { value: 'base', label: '基礎代謝（対照）' },
  ], () => terrain.target, (v) => (terrain.target = v as 'speed' | 'base'));

  // 無作為な大量死。割合0（既定）なら何も起きず、乱数も消費しない。
  // 間隔と割合は別々に動かせるが、比べるときは割合÷間隔を揃えること
  // （揃えないと平均個体数まで動く。types.ts の DisturbanceConfig 参照）
  const dist = (config.disturbance ??= { interval: 100, fraction: 0 });
  slider(env, '大量死の割合', 0, 0.8, 0.01, 2,
    () => dist.fraction, (v) => (dist.fraction = v));
  slider(env, '大量死の平均間隔', 0, DISTURB_INTERVALS.length - 1, 1, 0,
    () => Math.max(0, DISTURB_INTERVALS.indexOf(dist.interval)),
    (v) => (dist.interval = DISTURB_INTERVALS[v]),
    undefined,
    (v) => String(DISTURB_INTERVALS[v]));

  // 死骸の在庫を毎ステップどれだけ草に戻すか。1（既定）なら在庫を素通りする＝
  // 08 と同じ挙動。下げると流入が時間方向に均される。
  // 還元を書いていない構成では読まれもしないので、置いても何も起きない
  config.grass.detritusRelease ??= 1;
  slider(env, '死骸の放出率', 0.02, 1, 0.02, 2,
    () => config.grass.detritusRelease!, (v) => (config.grass.detritusRelease = v));

  container.appendChild(env);

  for (const def of config.species) {
    const g = group(def.name, def.color);

    // 行動コストがあると「代謝」スライダーの値と実際に減る量がずれるので、
    // 実効値を常に表示しておく
    const eff = document.createElement('div');
    eff.className = 'derived';
    const refresh = () => {
      const total = def.metabolism + def.speedCost * def.speed + def.visionCost * def.visionRange;
      const hasCost = def.speedCost > 0 || def.visionCost > 0;
      // 速度が遺伝する種は個体ごとに実効代謝が違う。ここに出せるのは初期個体の値だけ
      const head = def.mutation || def.visionMutation ? '初期個体の実効代謝' : '実効代謝';
      eff.textContent = hasCost
        ? `${head} ${total.toFixed(2)}` +
          `（基礎 ${def.metabolism.toFixed(2)}` +
          ` + 速度 ${(def.speedCost * def.speed).toFixed(2)}` +
          ` + 視野 ${(def.visionCost * def.visionRange).toFixed(2)}）`
        : `${head} ${total.toFixed(2)}（行動コストなし）`;
    };

    slider(g, '代謝', 0, 2, 0.05, 2,
      () => def.metabolism, (v) => (def.metabolism = v), refresh);
    slider(g, '速度コスト', 0, 0.5, 0.01, 2,
      () => def.speedCost, (v) => (def.speedCost = v), refresh);
    slider(g, '視野コスト', 0, 0.3, 0.01, 2,
      () => def.visionCost, (v) => (def.visionCost = v), refresh);

    if (def.eatsGrass) {
      slider(g, '採食量', 0, 12, 0.5, 1,
        () => def.gainFromGrass, (v) => (def.gainFromGrass = v));
    }
    if (def.preys.length > 0) {
      slider(g, '捕食利得', 0, 40, 1, 0,
        () => def.gainFromPrey, (v) => (def.gainFromPrey = v));
      slider(g, '捕獲成功率', 0.01, 1, 0.01, 2,
        () => def.captureRate, (v) => (def.captureRate = v));
    }

    slider(g, '繁殖閾値', 5, 100, 1, 0,
      () => def.reproduceThreshold, (v) => (def.reproduceThreshold = v));
    slider(g, '繁殖確率', 0, 0.3, 0.005, 3,
      () => def.reproduceProb, (v) => (def.reproduceProb = v));
    // 速度が遺伝する種では、この値は初期個体に配るぶんにしか効かない
    slider(g, def.mutation ? '移動速度 *' : '移動速度', 0, 4, def.mutation ? 0.1 : 1, def.mutation ? 1 : 0,
      () => def.speed, (v) => (def.speed = v), refresh);
    // 視野が遺伝する種では、この値は初期個体に配るぶんにしか効かない（速度と同じ）。
    // 刻みを 0.05 にしてあるのは 26・27 の窓の端（低い側 0.55〜0.60、
    // 高い側 0.95〜1.00）をスライダーの上で踏めるようにするため
    slider(g, def.visionMutation ? '視野 *' : '視野', 0, 8, def.visionMutation ? 0.05 : 1,
      def.visionMutation ? 2 : 0,
      () => def.visionRange, (v) => (def.visionRange = v), refresh);
    if (def.resourceA !== undefined) {
      // 名目の配分。**実際に何を取ったかは計器の「摂取 A:B」で見ること。**
      // 23 では p=0.90 の名目上の専門型が摂取 A50% で、事実上の汎用型だった
      slider(g, '資源Aへの配分', 0, 1, 0.05, 2,
        () => def.resourceA!, (v) => (def.resourceA = v));
    }

    // 死骸まわりは `*`。World.anyCorpse は構築時に決まるので、走行中に0から
    // 上げても在庫が放出されない（死骸が積まれるだけで草に戻らない）。
    // リセットすれば効く
    slider(g, '死骸の還元 *', 0, 100, 1, 0,
      () => def.corpseGrass, (v) => (def.corpseGrass = v));
    // 1セルに固まって落ちると、そこだけ採食量の何倍もの山になる。
    // それが安定性を大きく変える（docs/reports/09）
    slider(g, '死骸の半径', 0, 5, 1, 0,
      () => def.corpseSpread, (v) => (def.corpseSpread = v));

    if (def.mutation) {
      const m = def.mutation;
      slider(g, '変異の強さ（速度）', 0, 0.2, 0.005, 3,
        () => m.speedSigma, (v) => (m.speedSigma = v));
    }
    if (def.visionMutation) {
      const m = def.visionMutation;
      slider(g, '変異の強さ（視野）', 0, 0.2, 0.005, 3,
        () => m.sigma, (v) => (m.sigma = v));
    }

    // 感染症と密度依存の死は、**プリセットが書いている種にだけ**出す。
    // ここで生やすと anyInfection / anyCrowding が立ち、走査そのものが増える。
    // 機構を足すのは presets の仕事という約束（CLAUDE.md）に合わせてある
    if (def.infection) {
      const inf = def.infection;
      slider(g, '伝染確率', 0, 1, 0.05, 2,
        () => inf.transmit, (v) => (inf.transmit = v));
      slider(g, '致死性', 0, 0.1, 0.005, 3,
        () => inf.lethality, (v) => (inf.lethality = v));
      slider(g, '回復率', 0, 0.1, 0.005, 3,
        () => inf.recover, (v) => (inf.recover = v));
      // 17 の対照。機構もつまみも同一で、宿主特異性だけが無い。
      // **対照のほうが多く殺しているのに共存しない**のが筋6の要点
      choice(g, '伝染範囲', [
        { value: 'self', label: '同種のみ' },
        { value: 'all', label: '全種（対照）' },
      ], () => inf.scope, (v) => (inf.scope = v as 'self' | 'all'));
    }
    if (def.crowding) {
      const cr = def.crowding;
      slider(g, '密度依存の死', 0, 0.5, 0.01, 2,
        () => cr.rate, (v) => (cr.rate = v));
      choice(g, '見る密度', [
        { value: 'self', label: '自種' },
        { value: 'all', label: '全種（対照）' },
      ], () => cr.scope, (v) => (cr.scope = v as 'self' | 'all'));
    }

    // 視野0の種では効かないが、視野は実行中に上げられるので常に出しておく
    slider(g, '空腹閾値', 0, 40, 1, 0,
      () => def.hungerThreshold, (v) => (def.hungerThreshold = v));
    slider(g, '初期個体数 *', 0, 2000, 10, 0,
      () => def.initialCount, (v) => (def.initialCount = v));

    refresh();
    g.appendChild(eff);
    container.appendChild(g);
  }

  const note = document.createElement('div');
  note.className = 'group';
  note.style.color = 'var(--dim)';
  note.textContent = '* が付いた項目はリセット時に反映されます。その他は即時反映。';
  container.appendChild(note);
}

/**
 * 選択肢。**対照を切り替えるためにある。**
 *
 * 16・17・20 はどれも「機構もつまみも同一で、性質を1つだけ外した対照」を持っていて、
 * それが効いたかどうかの判定そのものだった。数値のスライダーでは表せない。
 */
function choice(
  parent: HTMLElement,
  label: string,
  options: { value: string; label: string }[],
  get: () => string,
  set: (v: string) => void,
): void {
  const row = document.createElement('div');
  row.className = 'row choice';

  const name = document.createElement('span');
  name.textContent = label;

  const select = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    select.appendChild(opt);
  }
  select.value = get();
  select.addEventListener('change', () => set(select.value));

  row.append(name, select);
  parent.appendChild(row);
}

function group(title: string, color?: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'group';
  const h = document.createElement('h2');
  if (color) {
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = color;
    h.appendChild(sw);
  }
  h.appendChild(document.createTextNode(title));
  el.appendChild(h);
  return el;
}

function slider(
  parent: HTMLElement,
  label: string,
  min: number,
  max: number,
  stepSize: number,
  digits: number,
  get: () => number,
  set: (v: number) => void,
  onInput?: () => void,
  /** 表示だけ差し替える。スライダーの値と見せたい数字が違うとき用 */
  format?: (v: number) => string,
): void {
  const row = document.createElement('div');
  row.className = 'row';

  const name = document.createElement('span');
  name.textContent = label;

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(stepSize);
  input.value = String(get());

  const show = format ?? ((v: number) => v.toFixed(digits));

  const out = document.createElement('output');
  out.textContent = show(get());

  input.addEventListener('input', () => {
    const v = Number(input.value);
    set(v);
    out.textContent = show(v);
    onInput?.();
  });

  row.append(name, input, out);
  parent.appendChild(row);
}
