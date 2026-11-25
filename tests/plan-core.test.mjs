import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as core from '../meals/lib/plan-core.js';

const read = (p) => JSON.parse(readFileSync(new URL(`../data/meals/${p}`, import.meta.url), 'utf8'));
const load = () => ({
  config: read('config.json'),
  ingredients: read('ingredients.json'),
  week: read('weeks/2026-11-30.json'),
});
const find = (groups, id) => groups.flatMap((g) => g.items).find((i) => i.id === id);

describe('単位変換', () => {
  const { ingredients } = load();
  const it = ingredients.items;
  test('基本単位はそのまま', () => assert.equal(core.toCanonical(it.chicken_breast, 300, 'g'), 300));
  test('大さじ・小さじ・少々を基本単位へ', () => {
    assert.equal(core.toCanonical(it.soy_sauce, 2, '大さじ'), 30);
    assert.equal(core.toCanonical(it.sugar, 2, '小さじ'), 6);
    assert.equal(core.toCanonical(it.salt, 1, '少々'), 0.5);
  });
  test('変換できない単位はエラー', () => {
    assert.throws(() => core.toCanonical(it.egg, 100, 'g'), /変換できません/);
    assert.throws(() => core.toCanonical(it.egg, -1, '個'), /数量が不正/);
  });
});

describe('買い物リストの集計', () => {
  test('同じ食材を複数の料理から合算し、購入単位に切り上げる', () => {
    const d = load();
    const p = core.buildPlan(d);
    const chicken = find(p.shopping, 'chicken_breast'); // 親子丼200 + 照り焼き300 + にんにく醤油炒め300
    assert.equal(chicken.need, 800);
    assert.equal(chicken.count, 3);
    assert.equal(chicken.cost, 810);
    assert.equal(chicken.leftover, 100);
    assert.deepEqual(chicken.sources.sort(), ['鶏むね肉とブロッコリーのにんにく醤油炒め', '鶏むね肉の照り焼き', '鶏むね肉の親子丼'].sort());
  });

  test('固定朝食7日分が含まれる', () => {
    const p = core.buildPlan(load());
    assert.equal(find(p.shopping, 'natto').need, 7);
    assert.equal(find(p.shopping, 'mekabu').need, 7);
    assert.equal(find(p.shopping, 'bread_6').need, 14);
    assert.equal(find(p.shopping, 'sausage').need, 14);
    // 豆腐：朝食150g×7 + 味噌汁150 + 麻婆300 + ハンバーグ150
    assert.equal(find(p.shopping, 'tofu_kinu').need, 1650);
    // 卵：本人7 + 妻7 + 料理11
    assert.equal(find(p.shopping, 'egg').need, 25);
  });

  test('カテゴリは指定の5分類の順で並ぶ', () => {
    const p = core.buildPlan(load());
    assert.deepEqual(p.shopping.map((g) => g.label), ['肉・魚', '卵・大豆製品・乳製品', '野菜・きのこ', 'パン・その他', '調味料']);
  });

  test('ご飯は必要量を表示するが予算に含めない', () => {
    const p = core.buildPlan(load());
    const rice = find(p.shopping, 'rice_cooked');
    // 朝食100g×7 + ご飯ありの昼夕13食×(150+150)
    assert.equal(rice.need, 700 + 13 * 300);
    assert.equal(rice.excluded, true);
    assert.equal(rice.cost, 0);
    assert.ok(!p.budget.plannedUnset.includes(rice.name));
  });
});

describe('個別設定', () => {
  test('ご飯量の変更が必要量に反映される', () => {
    const d = load();
    const settings = core.resolveSettings(d.config, { mealRiceGrams: { me: 200, wife: 120 } });
    const p = core.buildPlan({ ...d, settings });
    assert.equal(find(p.shopping, 'rice_cooked').need, 700 + 13 * 320);
  });

  test('主菜倍率は main の食材だけを増減し、人ごとに配分する', () => {
    const d = load();
    const settings = core.resolveSettings(d.config, { mainDishFactor: { me: 1.5, wife: 1.0 } });
    const p = core.buildPlan({ ...d, settings });
    const chicken = find(p.shopping, 'chicken_breast');
    assert.equal(chicken.need, 1000); // 800 × 平均1.25
    assert.equal(chicken.count, 4);
    assert.equal(find(p.shopping, 'onion').need, 3); // main でない食材は変わらない
    const u = p.usages.find((x) => x.recipeId === 'oyakodon' && x.ingredientId === 'chicken_breast');
    assert.equal(core.round(u.shares.me, 4), 150);
    assert.equal(core.round(u.shares.wife, 4), 100);
  });

  test('妻の朝食（卵・ソーセージ）の数量を変更できる', () => {
    const d = load();
    const settings = core.resolveSettings(d.config, { breakfastQty: { wife: { egg: 2, sausage: 3 } } });
    const p = core.buildPlan({ ...d, settings });
    assert.equal(find(p.shopping, 'sausage').need, 21);
    assert.equal(find(p.shopping, 'egg').need, 25 + 7);
  });

  test('不正・範囲外の保存値は初期値または範囲内に戻す', () => {
    const { config } = load();
    const s = core.resolveSettings(config, {
      mealRiceGrams: { me: 'abc', wife: 9999 },
      mainDishFactor: { me: 0.1, wife: '1.26' },
      breakfastQty: { wife: { egg: -3, sausage: null } },
    });
    assert.equal(s.mealRiceGrams.me, 150);
    assert.equal(s.mealRiceGrams.wife, 400);
    assert.equal(s.mainDishFactor.me, 0.5);
    assert.equal(s.mainDishFactor.wife, 1.3);
    assert.equal(s.breakfastQty.wife.egg, 0);
    assert.equal(s.breakfastQty.wife.sausage, 2);
    assert.deepEqual(core.resolveSettings(config, null), core.defaultSettings(config));
  });
});

describe('予算', () => {
  test('在庫ありは購入予定額から除外、購入済みは影響しない', () => {
    const d = load();
    const base = core.buildPlan(d).budget;
    const stock = { soy_sauce: true, sugar: true };
    const withStock = core.buildPlan({ ...d, weekState: { stock, purchased: { egg: true } } }).budget;
    assert.equal(base.plannedKnown - withStock.plannedKnown, 330 + 260);
    assert.equal(withStock.fullKnown, base.fullKnown);
    assert.deepEqual(withStock.stockExcluded.sort(), ['砂糖（上白糖）', '醤油（濃口）'].sort());
  });

  test('調味料を全て在庫ありにすると予算内', () => {
    const d = load();
    const stock = Object.fromEntries(Object.entries(d.ingredients.items).filter(([, v]) => v.category === 'seasoning').map(([k]) => [k, true]));
    const b = core.buildPlan({ ...d, weekState: { stock, purchased: {} } }).budget;
    assert.equal(b.plannedKnown, b.nonSeasoningKnown);
    assert.ok(['within', 'near'].includes(b.status));
    assert.equal(b.remaining, 10000 - b.plannedKnown);
  });

  test('全品購入では超過として警告', () => {
    const b = core.buildPlan(load()).budget;
    assert.equal(b.status, 'over');
    assert.ok(b.remaining < 0);
  });

  test('価格未設定があると「予算内」と判定しない', () => {
    const d = load();
    d.ingredients.items.mekabu.purchase.priceStatus = 'unset';
    delete d.ingredients.items.mekabu.purchase.priceYen;
    const stock = Object.fromEntries(Object.entries(d.ingredients.items).filter(([, v]) => v.category === 'seasoning').map(([k]) => [k, true]));
    const p = core.buildPlan({ ...d, weekState: { stock, purchased: {} } });
    assert.equal(p.budget.status, 'undetermined');
    assert.deepEqual(p.budget.plannedUnset, ['めかぶ（たれ付き）']);
    assert.equal(find(p.shopping, 'mekabu').cost, null);
  });

  test('価格未設定があっても既知分だけで超過なら「超過」', () => {
    const d = load();
    d.ingredients.items.mekabu.purchase = null;
    const b = core.buildPlan(d).budget;
    assert.equal(b.status, 'over');
  });
});

describe('栄養（目安）', () => {
  test('本人の固定朝食の栄養値', () => {
    const p = core.buildPlan(load());
    const bf = p.nutrition.byDay['2026-11-30'].me.bySlot.breakfast;
    // ご飯156 + 絹豆腐84 + 納豆76 + 卵71 + めかぶ6
    assert.equal(Math.round(bf.kcal), 393);
  });
  test('共通料理は2人に配分され、合計がレシピ全体と一致', () => {
    const d = load();
    const p = core.buildPlan(d);
    const lunch = p.usages.filter((u) => u.date === '2026-11-30' && u.slot === 'lunch');
    for (const u of lunch) {
      const sum = Object.values(u.shares).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - u.qty) < 1e-9);
    }
  });
});

describe('保存状態', () => {
  test('LocalStorage のキー', () => {
    assert.equal(core.storageKeys.settings, 'bodymake.meals.v1.settings');
    assert.equal(core.storageKeys.week('2026-11-30'), 'bodymake.meals.v1.week.2026-11-30');
  });
  test('週の状態は true のものだけ採用', () => {
    assert.deepEqual(core.resolveWeekState({ purchased: { egg: true, x: 'yes' }, stock: 'bad' }), { purchased: { egg: true }, stock: {} });
    assert.deepEqual(core.resolveWeekState(null), { purchased: {}, stock: {} });
  });
});
