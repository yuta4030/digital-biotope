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
      const head = def.mutation ? '初期個体の実効代謝' : '実効代謝';
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
    slider(g, '視野', 0, 8, 1, 0,
      () => def.visionRange, (v) => (def.visionRange = v), refresh);
    slider(g, '死骸の還元', 0, 100, 1, 0,
      () => def.corpseGrass, (v) => (def.corpseGrass = v));
    // 1セルに固まって落ちると、そこだけ採食量の何倍もの山になる。
    // それが安定性を大きく変える（docs/reports/09）
    slider(g, '死骸の半径', 0, 5, 1, 0,
      () => def.corpseSpread, (v) => (def.corpseSpread = v));

    if (def.mutation) {
      const m = def.mutation;
      slider(g, '変異の強さ', 0, 0.2, 0.005, 3,
        () => m.speedSigma, (v) => (m.speedSigma = v));
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
