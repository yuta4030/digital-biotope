import { World } from '../core/world.ts';
import { step } from '../core/step.ts';
import { presets, presetByKey } from '../core/presets.ts';
import { GridRenderer, GraphRenderer } from './render.ts';
import { buildControls } from './controls.ts';
import type { WorldConfig } from '../core/types.ts';

const CELL_SCALE = 6;

const gridCanvas = document.querySelector<HTMLCanvasElement>('#grid')!;
const graphCanvas = document.querySelector<HTMLCanvasElement>('#graph')!;
const readout = document.querySelector<HTMLDivElement>('#readout')!;
const controlsEl = document.querySelector<HTMLElement>('#controls')!;
const descEl = document.querySelector<HTMLParagraphElement>('#presetDesc')!;

const playPause = document.querySelector<HTMLButtonElement>('#playPause')!;
const resetBtn = document.querySelector<HTMLButtonElement>('#resetBtn')!;
const speedInput = document.querySelector<HTMLInputElement>('#speed')!;
const speedLabel = document.querySelector<HTMLSpanElement>('#speedLabel')!;
const seedInput = document.querySelector<HTMLInputElement>('#seed')!;
const presetSelect = document.querySelector<HTMLSelectElement>('#preset')!;

let config: WorldConfig = presets[0].build();
let world = new World(config);
let grid = new GridRenderer(gridCanvas, world, CELL_SCALE);
const graph = new GraphRenderer(graphCanvas, world);

let running = true;
let stepsPerFrame = 1;

// --- プリセット ---
for (const p of presets) {
  const opt = document.createElement('option');
  opt.value = p.key;
  opt.textContent = p.label;
  presetSelect.appendChild(opt);
}
presetSelect.value = presets[0].key;

presetSelect.addEventListener('change', () => loadPreset(presetSelect.value));

/** 種の数も色も変わるので、ワールドと描画側をまとめて作り直す */
function loadPreset(key: string): void {
  const preset = presetByKey(key);
  config = preset.build();
  config.seed = Number(seedInput.value) || 0;

  world = new World(config);
  grid = new GridRenderer(gridCanvas, world, CELL_SCALE);
  graph.reset(world);

  buildControls(controlsEl, config);
  descEl.textContent = preset.description;
}

// --- 操作 ---
playPause.addEventListener('click', () => {
  running = !running;
  playPause.textContent = running ? '停止' : '再生';
});

/** スライダーで変えたパラメータは保ったまま、初期配置からやり直す */
resetBtn.addEventListener('click', () => {
  config.seed = Number(seedInput.value) || 0;
  world = new World(config);
  graph.reset(world);
});

speedInput.addEventListener('input', () => {
  stepsPerFrame = Number(speedInput.value);
  speedLabel.textContent = `${stepsPerFrame}x`;
});

seedInput.addEventListener('change', () => resetBtn.click());

window.addEventListener('resize', () => graph.resize());

// スペースキーで再生/停止
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault();
    playPause.click();
  }
});

/** 草の総量。セル数ぶん舐めるのでフレームに1回だけ */
function totalGrass(): number {
  let t = 0;
  for (let c = 0; c < world.cells; c++) t += world.grass[c];
  return t;
}

// --- ループ ---
let lastFpsAt = performance.now();
let framesSince = 0;
let fps = 0;

function frame(): void {
  if (running) {
    const g = totalGrass();
    for (let i = 0; i < stepsPerFrame; i++) {
      step(world);
      graph.sample(world, g);
    }
  }

  grid.draw(world);
  graph.draw();

  framesSince++;
  const now = performance.now();
  if (now - lastFpsAt >= 500) {
    fps = (framesSince * 1000) / (now - lastFpsAt);
    framesSince = 0;
    lastFpsAt = now;
  }
  updateReadout();

  requestAnimationFrame(frame);
}

const readoutCounts = () => {
  const counts = new Int32Array(world.defs.length);
  world.countBySpecies(counts);
  return counts;
};

function updateReadout(): void {
  const counts = readoutCounts();

  // .readout は flex なので、gap を効かせるため各項目を要素で包む
  const parts = [`<span>step <b>${world.stepCount.toLocaleString()}</b></span>`];
  world.defs.forEach((def, i) => {
    parts.push(
      `<span><span style="color:${def.color}">■</span> ${def.name} <b>${counts[i]}</b></span>`,
    );
  });
  parts.push(`<span>${fps.toFixed(0)} fps</span>`);
  readout.innerHTML = parts.join('');
}

buildControls(controlsEl, config);
descEl.textContent = presets[0].description;
requestAnimationFrame(frame);
