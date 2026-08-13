import { presetByKey } from '../../../src/core/presets.ts';
import { trial, header, done, banner } from './_lib.ts';
import type { WorldConfig } from '../../../src/core/types.ts';

/**
 * レポート23: 資源を2本にする
 *
 *   node docs/reports/scripts/23-two-resources.ts
 *
 * [DIRECTION](../DIRECTION.md) が「残っているのはニッチ軸そのものを増やすこと」と
 * 書いていた分。07 も 20 も同じ軸（`eatsGrass`）の**空間分布**を変えていて、
 * 軸を増やしたことは一度も無い。
 *
 * ただし [22](../22-vision-evolution.md) が直前に
 * 「中間へ動いた側が両方の資源を取ると軸が畳まれる」を出している。
 * **同じ形がここでも出ないかを先に確かめる。** 4スレッドで約6分。
 */

const t0 = performance.now();
banner();
const SEEDS_8 = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
const STEPS = 6000;
const TAIL = 3000;

/** 実効代謝0.40の草食。行動コストも視野も0で、動く軸は採食の配分だけ */
function build(supplyA: number, affinities: number[], counts?: number[]): () => WorldConfig {
  return () => {
    const cfg = presetByKey('tworesource').build();
    cfg.grass.split!.supplyA = supplyA;
    cfg.species = affinities.map((pA, k) => ({
      ...cfg.species[0],
      id: k + 1,
      name: `p=${pA.toFixed(2)}`,
      resourceA: pA,
      initialCount: counts ? counts[k] : 300,
    }));
    return cfg;
  };
}

/**
 * 1行出す。資源別の摂取も一緒に出すのが要点で、個体数だけ見ていると
 * 「専門型が本当に自分の資源だけを取っているか」を確かめられない。
 */
async function row(label: string, b: () => WorldConfig): Promise<void> {
  const t = await trial(b, { seeds: SEEDS_8, steps: STEPS, tail: TAIL });
  const cells = t.species.map((s) => {
    const g = s.grazeA + s.grazeB;
    const share = g > 0 ? (s.grazeA / g) * 100 : NaN;
    return (
      `${s.name} ${s.mean.toFixed(0).padStart(4)}(${String(s.min).padStart(4)}-${String(s.max).padStart(4)})` +
      ` A${Number.isFinite(share) ? share.toFixed(0).padStart(3) : ' --'}%`
    );
  });
  console.log(`  ${label.padEnd(22)} ${cells.join('  ')}`);
}

// ---------------------------------------------------------------------------
// 対照。2本に割っても総生産量が変わっていないことを先に確かめる。
// ここがずれていたら以降の数字は「軸を増やした効果」ではなく
// 「痩せさせた/太らせた効果」を含む（06 の豊穣化と同じ形の交絡）
// ---------------------------------------------------------------------------
header('対照: 2本に割っても総生産量と総個体数は変わらないか（8シード）');
{
  const single = await trial(
    () => {
      const cfg = presetByKey('tworesource').build();
      delete cfg.grass.split;
      cfg.species = [{ ...cfg.species[0], id: 1, name: '資源1本', initialCount: 300 }];
      return cfg;
    },
    { seeds: SEEDS_8, steps: STEPS, tail: TAIL },
  );
  console.log(
    `  資源1本 汎用のみ         ${single.species[0].mean.toFixed(0)}体  ` +
      `生産 ${single.grassProduced.toFixed(1)}/歩  草 ${single.grassMean.toFixed(0)}`,
  );

  const split = await trial(build(0.5, [0.5]), { seeds: SEEDS_8, steps: STEPS, tail: TAIL });
  console.log(
    `  資源2本 汎用のみ         ${split.species[0].mean.toFixed(0)}体  ` +
      `生産 ${split.grassProduced.toFixed(1)}/歩  草 ${split.grassMean.toFixed(0)}`,
  );
}

// ---------------------------------------------------------------------------
// 専門型2種だけなら共存するか。
// 供給比を振って、個体数が比に追随するかを見る。
// 追随するなら、それぞれが自分の資源に制限されている＝本当に軸が2本ある
// ---------------------------------------------------------------------------
header('専門型2種（汎用型なし）: 供給比を振る（8シード）');
for (const s of [0.1, 0.2, 0.3, 0.5, 0.7, 0.9]) {
  await row(`A供給 ${s.toFixed(1)}`, build(s, [1, 0]));
}

// ---------------------------------------------------------------------------
// 本題。汎用型を入れると何が起きるか。
//
// 22 の予想: 中間は両端の資源を両方取れるので軸を畳む。
// この模型の採食は遭遇律速（セルにあるものを食べるだけ）なので、
// 資源が乏しいと配分の上限が効かなくなり、専門化しても損しか無いはず
// ---------------------------------------------------------------------------
header('汎用型を等量で混ぜる（8シード）');
for (const s of [0.3, 0.5]) {
  await row(`A供給 ${s.toFixed(1)} 3種同数`, build(s, [1, 0.5, 0]));
}

header('汎用型を少数だけ投入する（専門型300 対 汎用30）');
for (const s of [0.3, 0.5]) {
  await row(`A供給 ${s.toFixed(1)} 汎用30体`, build(s, [1, 0.5, 0], [300, 30, 300]));
}

// ---------------------------------------------------------------------------
// どこまで専門化を緩めれば勝てるのか。
// 専門型と、少しだけ汎用寄りの型を並べる
// ---------------------------------------------------------------------------
header('専門の度合いを振る（A専門 対 やや汎用、A供給0.5・8シード）');
for (const p of [0.9, 0.75, 0.6, 0.5]) {
  await row(`p=1.00 対 p=${p.toFixed(2)}`, build(0.5, [1, p]));
}

await done(t0);
