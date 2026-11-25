// Phase 3 追加検証：栄養・予算・集計・固定朝食・アレルギーの境界条件
// Phase 3 で todo だった N-1 / A-1 / A-2 の再現テストは、修正後に通常テストへ変更済み。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as core from '../meals/lib/plan-core.js';

const read = (p) => JSON.parse(readFileSync(new URL(`../data/meals/${p}`, import.meta.url), 'utf8'));
const load = () => ({ config: read('config.json'), ingredients: read('ingredients.json'), week: read('weeks/2026-11-30.json') });
const plan = (d, settings, weekState) => core.buildPlan({ ...d, settings: settings && core.resolveSettings(d.config, settings), weekState });
const find = (p, id) => p.shopping.flatMap((g) => g.items).find((i) => i.id === id);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const KEYS = ['kcal', 'protein', 'fat', 'carbs'];
const seasoningStock = (d) => Object.fromEntries(Object.entries(d.ingredients.items).filter(([, v]) => v.category === 'seasoning').map(([k]) => [k, true]));
const DAY1 = '2026-11-30';

describe('栄養：夫婦で異なる主菜倍率（本人1.5・妻0.5）', () => {
  const d = load();
  const p = plan(d, { mainDishFactor: { me: 1.5, wife: 0.5 } });
  const base = plan(d);

  test('料理全体の材料量 = 本人分 + 妻分（全明細で整合）', () => {
    for (const u of p.usages) near(Object.values(u.shares).reduce((a, b) => a + b, 0), u.qty);
  });

  test('主菜食材は 本人:妻 = 3:1、主菜以外は 1:1', () => {
    let mainCount = 0;
    for (const u of p.usages.filter((x) => x.recipeId)) {
      const isMain = d.week.recipes[u.recipeId].ingredients.some((r) => r.id === u.ingredientId && r.main);
      if (isMain) { near(u.shares.me, 3 * u.shares.wife); mainCount++; }
      else near(u.shares.me, u.shares.wife);
    }
    assert.ok(mainCount >= 14, '主菜食材の明細が検査されている');
  });

  test('平均倍率1.0なので料理全体の量は倍率1.0と同じ', () => {
    near(find(p, 'chicken_breast').need, find(base, 'chicken_breast').need);
  });

  test('親子丼（鶏むね200g・266kcal）：本人 +66.5kcal、妻 -66.5kcal', () => {
    const me = p.nutrition.byDay[DAY1].me.bySlot.lunch.kcal - base.nutrition.byDay[DAY1].me.bySlot.lunch.kcal;
    const wife = p.nutrition.byDay[DAY1].wife.bySlot.lunch.kcal - base.nutrition.byDay[DAY1].wife.bySlot.lunch.kcal;
    near(me, 66.5);
    near(wife, -66.5);
  });

  test('2人の摂取量の合計は倍率を変えても同じ（平均1.0の場合）', () => {
    for (const k of KEYS) {
      near(p.nutrition.byDay[DAY1].me.total[k] + p.nutrition.byDay[DAY1].wife.total[k],
        base.nutrition.byDay[DAY1].me.total[k] + base.nutrition.byDay[DAY1].wife.total[k]);
    }
  });

  test('朝食は主菜倍率の影響を受けない', () => {
    near(p.nutrition.byDay[DAY1].me.bySlot.breakfast.kcal, base.nutrition.byDay[DAY1].me.bySlot.breakfast.kcal);
  });
});

describe('栄養：ご飯の量', () => {
  test('本人200g・妻100g → 1食あたり本人+78kcal、妻-78kcal（ご飯156kcal/100g）', () => {
    const d = load();
    const base = plan(d);
    const p = plan(d, { mealRiceGrams: { me: 200, wife: 100 } });
    for (const slot of ['lunch', 'dinner']) {
      near(p.nutrition.byDay[DAY1].me.bySlot[slot].kcal - base.nutrition.byDay[DAY1].me.bySlot[slot].kcal, 78);
      near(p.nutrition.byDay[DAY1].wife.bySlot[slot].kcal - base.nutrition.byDay[DAY1].wife.bySlot[slot].kcal, -78);
    }
  });

  test('ご飯なしの食事（焼きうどん）はご飯の量に影響されない', () => {
    const d = load();
    const base = plan(d);
    const p = plan(d, { mealRiceGrams: { me: 300, wife: 0 } });
    near(p.nutrition.byDay['2026-12-02'].me.bySlot.lunch.kcal, base.nutrition.byDay['2026-12-02'].me.bySlot.lunch.kcal);
  });

  test('妻0gでもエラーにならず、妻のご飯分の栄養は0', () => {
    const d = load();
    const p = plan(d, { mealRiceGrams: { me: 150, wife: 0 } });
    const rice = p.usages.filter((u) => u.ingredientId === 'rice_cooked' && u.slot !== 'breakfast');
    assert.ok(rice.every((u) => u.shares.wife === 0));
  });
});

describe('栄養：日合計・週平均の整合', () => {
  const d = load();
  const p = plan(d, { mainDishFactor: { me: 1.3, wife: 0.8 }, mealRiceGrams: { me: 180, wife: 120 } });

  test('各日の合計 = 朝食 + 昼食 + 夕食（人ごと）', () => {
    for (const day of Object.values(p.nutrition.byDay)) {
      for (const person of Object.values(day)) {
        for (const k of KEYS) near(person.total[k], Object.values(person.bySlot).reduce((a, s) => a + s[k], 0));
      }
    }
  });

  test('週平均 = 7日の合計 ÷ 7', () => {
    assert.equal(Object.keys(p.nutrition.byDay).length, 7);
    for (const pid of ['me', 'wife']) {
      for (const k of KEYS) near(p.nutrition.weekAvg[pid][k], Object.values(p.nutrition.byDay).reduce((a, day) => a + day[pid].total[k], 0) / 7);
    }
  });

  test('明細から独立に再計算した値と一致', () => {
    const items = d.ingredients.items;
    for (const pid of ['me', 'wife']) {
      let kcal = 0;
      for (const u of p.usages) {
        const n = items[u.ingredientId].nutrition;
        kcal += ((u.shares[pid] ?? 0) / n.per) * n.kcal;
      }
      near(kcal / 7, p.nutrition.weekAvg[pid].kcal, 1e-6);
    }
  });

  test('栄養値が欠損した食材は計算から除外し、警告を出す', () => {
    const d2 = load();
    delete d2.ingredients.items.chicken_breast.nutrition;
    const p2 = plan(d2);
    assert.deepEqual(p2.nutrition.missing, ['chicken_breast']);
    assert.ok(p2.warnings.some((w) => w.includes('chicken_breast')));
  });

  test('栄養値が欠損した食材を含む食事・日に「不完全」の印が付く（N-1）', () => {
    const d2 = load();
    delete d2.ingredients.items.chicken_breast.nutrition;
    const p2 = plan(d2);
    assert.equal(p2.nutrition.byDay[DAY1].me.incomplete, true);
    assert.equal(p2.nutrition.byDay[DAY1].me.bySlotIncomplete?.lunch, true);
    assert.notEqual(p2.nutrition.byDay[DAY1].me.bySlotIncomplete?.breakfast, true);
  });
});

describe('固定朝食（7日分・夫婦別）', () => {
  const d = load();
  const p = plan(d);
  const bf = (pid) => {
    const m = {};
    for (const u of p.usages.filter((x) => x.slot === 'breakfast' && x.shares[pid] != null)) m[u.ingredientId] = (m[u.ingredientId] ?? 0) + u.qty;
    return m;
  };

  test('本人：ご飯700g・絹豆腐1050g・納豆7・卵7・めかぶ7', () => {
    assert.deepEqual(bf('me'), { rice_cooked: 700, tofu_kinu: 1050, natto: 7, egg: 7, mekabu: 7 });
  });

  test('妻：食パン14枚・ジャム大さじ7（147g）・卵7・ソーセージ14・調理油小さじ7（35ml）', () => {
    assert.deepEqual(bf('wife'), { bread_6: 14, jam: 147, egg: 7, sausage: 14, salad_oil: 35 });
  });

  test('夫婦合計の朝食の卵は14個、各日1回ずつ', () => {
    const eggs = p.usages.filter((u) => u.slot === 'breakfast' && u.ingredientId === 'egg');
    assert.equal(eggs.length, 14);
    assert.equal(new Set(eggs.map((u) => u.date)).size, 7);
  });

  test('妻の卵・ソーセージは仮設定（provisional）として定義されている', () => {
    const items = Object.fromEntries(d.config.breakfasts.wife.items.map((i) => [i.key, i]));
    assert.equal(items.egg.provisional, true);
    assert.equal(items.sausage.provisional, true);
    assert.equal(items.egg.qty, 1);
    assert.equal(items.sausage.qty, 2);
    assert.ok(!d.config.breakfasts.me.items.some((i) => i.editable), '本人の朝食は固定');
  });

  test('朝食の栄養は全日同じ（本人393kcal / 妻約590kcal＝従来549.5＋調理油小さじ1の40.75kcal）', () => {
    for (const day of Object.values(p.nutrition.byDay)) {
      assert.equal(Math.round(day.me.bySlot.breakfast.kcal), 393);
      assert.equal(Math.round(day.wife.bySlot.breakfast.kcal), 590);
    }
  });
});

describe('予算・食材集計', () => {
  test('全食材の必要量を独立に再計算して一致（39品目）', () => {
    const d = load();
    const p = plan(d);
    const items = d.ingredients.items;
    const need = {};
    const add = (id, q, u) => { need[id] = (need[id] ?? 0) + core.toCanonical(items[id], q, u); };
    for (let i = 0; i < 7; i++) {
      for (const bf of Object.values(d.config.breakfasts)) for (const it of bf.items) add(it.ingredient, it.qty, it.unit);
      for (const slot of ['lunch', 'dinner']) {
        const m = d.week.days[i][slot];
        for (const rid of m.recipes) for (const ri of d.week.recipes[rid].ingredients) add(ri.id, ri.qty, ri.unit);
        if (m.withRice) need.rice_cooked += 300;
      }
    }
    const rows = p.shopping.flatMap((g) => g.items);
    assert.equal(rows.length, Object.keys(need).length);
    for (const r of rows) near(r.need, core.round(need[r.id], 2), 1e-9);
  });

  test('全食材を購入：12,970円・超過（-2,970円）', () => {
    const d = load();
    const b = plan(d).budget;
    const sum = plan(d).shopping.flatMap((g) => g.items).filter((i) => !i.excluded).reduce((a, i) => a + i.count * i.unitPrice, 0);
    assert.equal(b.plannedKnown, sum);
    assert.equal(b.plannedKnown, 12970);
    assert.equal(b.status, 'over');
    assert.equal(b.remaining, -2970);
  });

  test('調味料14品を在庫扱い：9,310円・上限に近い（残り690円）', () => {
    const d = load();
    const b = plan(d, undefined, { stock: seasoningStock(d), purchased: {} }).budget;
    assert.equal(b.stockExcluded.length, 14);
    assert.equal(b.plannedKnown, 9310);
    assert.equal(b.status, 'near');
    assert.equal(b.remaining, 690);
  });

  test('一部だけ在庫扱い（醤油・卵）：その価格だけ減る', () => {
    const d = load();
    const b = plan(d, undefined, { stock: { soy_sauce: true, egg: true }, purchased: {} }).budget;
    assert.equal(b.plannedKnown, 12970 - 330 - 900);
  });

  test('購入済みと在庫ありを同時にチェックしても二重に減額しない', () => {
    const d = load();
    const both = plan(d, undefined, { stock: { egg: true }, purchased: { egg: true } });
    const stockOnly = plan(d, undefined, { stock: { egg: true }, purchased: {} });
    const purchasedOnly = plan(d, undefined, { stock: {}, purchased: { egg: true } });
    assert.equal(both.budget.plannedKnown, 12970 - 900);
    assert.equal(both.budget.plannedKnown, stockOnly.budget.plannedKnown);
    assert.equal(purchasedOnly.budget.plannedKnown, 12970, '購入済みは予定額を変えない（購入予定として残る）');
    const egg = find(both, 'egg');
    assert.equal(egg.inStock && egg.purchased, true);
    const cat = both.shopping.find((g) => g.id === 'egg_soy_dairy');
    assert.equal(cat.subtotalKnown, 1750 - 900);
  });

  test('未設定価格がある：予算内と判定しない／分かっている分で超過なら超過', () => {
    const d = load();
    d.ingredients.items.salmon.purchase = { size: 2, label: '1パック', priceStatus: 'unset' };
    const stock = seasoningStock(d);
    const b = plan(d, undefined, { stock, purchased: {} }).budget;
    assert.equal(b.status, 'undetermined');
    assert.deepEqual(b.plannedUnset, ['生鮭（切り身）']);
    assert.equal(b.plannedKnown, 9310 - 400);
    const b2 = plan(d).budget;
    assert.equal(b2.status, 'over');
  });

  test('未設定価格の食材を在庫ありにすると未確定が解消する', () => {
    const d = load();
    d.ingredients.items.salmon.purchase = null;
    const stock = { ...seasoningStock(d), salmon: true };
    const b = plan(d, undefined, { stock, purchased: {} }).budget;
    assert.deepEqual(b.plannedUnset, []);
    assert.notEqual(b.status, 'undetermined');
  });

  test('予算ちょうど10,000円は超過ではない', () => {
    const d = load();
    d.ingredients.items.salmon.purchase.priceYen = 400 + 690;
    const b = plan(d, undefined, { stock: seasoningStock(d), purchased: {} }).budget;
    assert.equal(b.plannedKnown, 10000);
    assert.equal(b.status, 'near');
    assert.equal(b.remaining, 0);
  });

  test('購入単位の切り上げ（境界値・浮動小数誤差）', () => {
    const ing = { name: 'x', purchase: { size: 300, priceYen: 100, priceStatus: 'estimated' } };
    assert.deepEqual(core.purchasePlan(ing, 0), { count: 0, cost: 0, priceStatus: 'estimated', leftover: 0 });
    assert.equal(core.purchasePlan(ing, 300).count, 1);
    assert.equal(core.purchasePlan(ing, 300.1).count, 2);
    assert.equal(core.purchasePlan(ing, 0.1 * 3 * 1000).count, 1); // 300.00000000000006
    assert.equal(core.purchasePlan(ing, 1).leftover, 299);
  });

  test('実データの切り上げ：ソーセージ14本→2袋、妻3本にすると21本→3袋', () => {
    const d = load();
    assert.equal(find(plan(d), 'sausage').count, 2);
    assert.equal(find(plan(d, { breakfastQty: { wife: { sausage: 3 } } }), 'sausage').count, 3);
    assert.equal(find(plan(d), 'chicken_thigh').leftover, 0);
  });
});

describe('アレルギー：追加ケース', () => {
  const withIngredient = (patch) => {
    const d = load();
    d.ingredients.items.x = { name: 'テスト食材', category: 'meat_fish', unit: 'g', purchase: null, nutrition: null, processed: true, allergenStatus: 'needs_label_check', containsAllergens: [], ...patch };
    d.week.recipes.oyakodon.ingredients.push({ id: 'x', qty: 1, unit: 'g' });
    return core.checkAllergens(d);
  };

  test('食材名（エビ・えび・海老・カニ・かに・蟹）を検出', () => {
    for (const name of ['むきエビ', '桜えび', '伊勢海老', 'カニカマ', 'かにかま', '蟹みそ']) {
      assert.ok(withIngredient({ name }).errors.length > 0, name);
    }
  });

  test('原材料情報（containsAllergens に shrimp / crab）を検出', () => {
    assert.ok(withIngredient({ containsAllergens: ['shrimp'] }).errors.length > 0);
    assert.ok(withIngredient({ containsAllergens: ['crab'] }).errors.length > 0);
  });

  test('原材料情報に日本語表記（えび・かに）で書かれていても検出（A-1）', () => {
    assert.ok(withIngredient({ containsAllergens: ['えび'] }).errors.length > 0);
    assert.ok(withIngredient({ containsAllergens: ['かに'] }).errors.length > 0);
  });

  test('濁音・別名・半角カナ（ガニ・がに・蝦・ロブスター・ｴﾋﾞ）を検出（A-2）', () => {
    for (const name of ['毛ガニ', 'ずわいがに', 'タラバガニ', '蝦', 'ロブスター', 'ｴﾋﾞ', 'ｶﾆ']) {
      assert.ok(withIngredient({ name }).errors.length > 0, name);
    }
  });

  test('原材料不明の加工食品は安全（free）と判定されない', () => {
    assert.ok(withIngredient({ allergenStatus: 'free' }).errors.length > 0);
    assert.ok(withIngredient({ allergenStatus: undefined }).errors.length > 0);
    const r = withIngredient({});
    assert.deepEqual(r.errors, []);
    assert.ok(r.labelChecks.some((l) => l.id === 'x'), '確認対象に入る');
  });

  test('原材料確認リスト22品はすべて加工食品で、確認理由を説明できる', () => {
    const d = load();
    const r = core.checkAllergens(d);
    assert.equal(r.labelChecks.length, 22);
    for (const l of r.labelChecks) {
      const ing = d.ingredients.items[l.id];
      assert.equal(ing.processed, true, `${l.id}`);
      assert.equal(ing.allergenStatus, 'needs_label_check');
    }
  });
});
