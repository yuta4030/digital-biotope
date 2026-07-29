import type { WorldConfig } from '../core/types.ts';

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
      eff.textContent = hasCost
        ? `実効代謝 ${total.toFixed(2)}` +
          `（基礎 ${def.metabolism.toFixed(2)}` +
          ` + 速度 ${(def.speedCost * def.speed).toFixed(2)}` +
          ` + 視野 ${(def.visionCost * def.visionRange).toFixed(2)}）`
        : `実効代謝 ${total.toFixed(2)}（行動コストなし）`;
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
    slider(g, '移動速度', 0, 4, 1, 0,
      () => def.speed, (v) => (def.speed = v), refresh);
    slider(g, '視野', 0, 8, 1, 0,
      () => def.visionRange, (v) => (def.visionRange = v), refresh);
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

  const out = document.createElement('output');
  out.textContent = get().toFixed(digits);

  input.addEventListener('input', () => {
    const v = Number(input.value);
    set(v);
    out.textContent = v.toFixed(digits);
    onInput?.();
  });

  row.append(name, input, out);
  parent.appendChild(row);
}
