import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as core from '../meals/lib/plan-core.js';
import { validateAll } from '../scripts/validate.mjs';

const read = (p) => JSON.parse(readFileSync(new URL(`../data/meals/${p}`, import.meta.url), 'utf8'));
const load = () => ({
  config: read('config.json'),
  ingredients: read('ingredients.json'),
  week: read('weeks/2026-11-30.json'),
});

describe('アレルギー（えび・かに）', () => {
  test('実データにエラーがない', () => {
    const r = core.checkAllergens(load());
    assert.deepEqual(r.errors, []);
  });

  test('加工食品・調味料はすべて「原材料確認」対象', () => {
    const d = load();
    const r = core.checkAllergens(d);
    const ids = new Set(r.labelChecks.map((l) => l.id));
    for (const [id, ing] of Object.entries(d.ingredients.items)) {
      if (ing.processed || ing.category === 'seasoning') assert.ok(ids.has(id), `${id} が確認対象に入っていない`);
    }
  });

  test('食材の containsAllergens にえびがあればエラー', () => {
    const d = load();
    d.ingredients.items.dashi_granule.containsAllergens = ['shrimp'];
    const r = core.checkAllergens(d);
    assert.ok(r.errors.some((e) => e.includes('顆粒和風だし') && e.includes('shrimp')));
  });

  test('食材名にかに・エビ等があればエラー（料理名に頼らず食材で検出）', () => {
    const d = load();
    d.ingredients.items.kanikama = { name: 'かにかま', category: 'meat_fish', unit: '本', purchase: null, nutrition: null, processed: true, allergenStatus: 'needs_label_check', containsAllergens: [] };
    d.week.recipes.oyakodon.ingredients.push({ id: 'kanikama', qty: 2, unit: '本' });
    const r = core.checkAllergens(d);
    assert.ok(r.errors.some((e) => e.includes('かにかま')));
    const p = core.buildPlan(d);
    assert.equal(p.ok, false);
  });

  test('料理名が安全そうでも、食材が危険なら検出する', () => {
    const d = load();
    d.ingredients.items.shrimp_x = { name: '小えび（むき身）', category: 'meat_fish', unit: 'g', purchase: { size: 100, label: '1P', priceYen: 300, priceStatus: 'estimated' }, nutrition: { per: 100, kcal: 80, protein: 18, fat: 0.5, carbs: 0 }, processed: false, allergenStatus: 'contains', containsAllergens: ['shrimp'] };
    d.week.recipes.yaki_udon.ingredients.push({ id: 'shrimp_x', qty: 50, unit: 'g' });
    const r = core.checkAllergens(d);
    assert.ok(r.errors.length >= 1);
  });

  test('加工食品を free（安全）にするとエラー', () => {
    const d = load();
    d.ingredients.items.torigara.allergenStatus = 'free';
    assert.ok(core.checkAllergens(d).errors.some((e) => e.includes('鶏ガラ')));
  });

  test('allergenStatus 未設定は安全扱いしない', () => {
    const d = load();
    delete d.ingredients.items.cabbage.allergenStatus;
    assert.ok(core.checkAllergens(d).errors.some((e) => e.includes('キャベツ')));
  });

  test('料理名・手順のえび・かに表記を検出し、「なめらかに」等は誤検出しない', () => {
    const d = load();
    d.week.recipes.oyakodon.steps.push('卵はなめらかに混ぜる。');
    assert.deepEqual(core.checkAllergens(d).errors, []);
    d.week.recipes.oyakodon.name = 'エビ入り親子丼';
    d.week.recipes.yaki_udon.steps.push('仕上げに桜海老をのせる。');
    const errs = core.checkAllergens(d).errors;
    assert.ok(errs.some((e) => e.includes('エビ入り親子丼')));
    assert.ok(errs.some((e) => e.includes('海老')));
  });
});

describe('週データの検証', () => {
  test('実データは検証OK', () => {
    const r = core.validateWeek(load());
    assert.deepEqual(r.errors, []);
  });

  test('月曜始まりでない・日付ずれを検出', () => {
    const d = load();
    d.week.weekStart = '2026-12-01';
    const r = core.validateWeek(d);
    assert.ok(r.errors.some((e) => e.includes('月曜日ではありません')));
  });

  test('存在しない料理・食材・変換できない単位を検出', () => {
    const d = load();
    d.week.days[0].lunch.recipes.push('no_such_recipe');
    d.week.recipes.oyakodon.ingredients.push({ id: 'no_such_ing', qty: 1, unit: 'g' });
    d.week.recipes.yaki_udon.ingredients.push({ id: 'egg', qty: 50, unit: 'g' });
    const errs = core.validateWeek(d).errors.join('\n');
    assert.match(errs, /no_such_recipe/);
    assert.match(errs, /no_such_ing/);
    assert.match(errs, /単位「g」/);
  });

  test('直近の週と同じ主菜はエラー、汁物の重複は許可', () => {
    const d = load();
    const next = structuredClone(d.week);
    next.weekStart = '2026-12-07';
    next.days.forEach((day, i) => { day.date = core.addDays('2026-12-07', i); });
    const r = core.validateWeek({ ...d, week: next, history: [d.week] });
    assert.ok(r.errors.some((e) => e.includes('鶏むね肉の親子丼')));
    assert.ok(!r.errors.some((e) => e.includes('味噌汁')));
  });

  test('N週より前の料理は再登場してよい', () => {
    const d = load();
    const mk = (ws, recipes) => ({ weekStart: ws, recipes });
    const old = mk('2026-11-09', { a: { name: '鶏むね肉の親子丼', kind: 'main' } });
    const w2 = mk('2026-11-16', {});
    const w3 = mk('2026-11-23', {});
    const r = core.validateWeek({ ...d, history: [old, w2, w3] });
    assert.deepEqual(r.errors, []);
  });

  test('食材マスタの価格状態・栄養の不正を検出', () => {
    const d = load();
    d.ingredients.items.egg.purchase.priceStatus = 'guess';
    d.ingredients.items.onion.nutrition = { per: 0, kcal: 1, protein: 0, fat: 0, carbs: 0 };
    const errs = core.validateIngredients(d.ingredients).errors.join('\n');
    assert.match(errs, /egg: purchase.priceStatus/);
    assert.match(errs, /onion: nutrition/);
  });

  test('米が予算対象になっていたらエラー', () => {
    const d = load();
    d.ingredients.items.rice_cooked.excludedFromBudget = false;
    assert.ok(core.validateConfig(d.config, d.ingredients).errors.some((e) => e.includes('excludedFromBudget')));
  });
});

describe('CLI 検証（scripts/validate.mjs）', () => {
  test('リポジトリの全データがエラーなし', async () => {
    const r = await validateAll();
    assert.deepEqual(r.errors, []);
  });
});
