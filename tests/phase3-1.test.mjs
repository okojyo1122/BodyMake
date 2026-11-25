// Phase 3.1：アレルギー判定の3段階化（検出／要確認／検出なし）と、予算3種類の独立性
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as core from '../meals/lib/plan-core.js';
import { budgetGate } from '../scripts/validate.mjs';

const read = (p) => JSON.parse(readFileSync(new URL(`../data/meals/${p}`, import.meta.url), 'utf8'));
const load = () => ({ config: read('config.json'), ingredients: read('ingredients.json'), week: read('weeks/2026-11-30.json') });
const plan = (d, weekState) => core.buildPlan({ ...d, weekState });
const ac = load().config.allergens;
const cls = (t, mode) => core.classifyAllergenText(t, ac, mode);

// 副詞の形をしているが、アレルゲンかもしれない表記（旧実装ではすべての欄で黙って除外されていた）
const ADVERB_LIKE = ['あらかに', 'たらかに', 'まろやかにみそ', 'こまかにほぐし身', 'ほのかにかま', 'やわらかに'];

describe('3段階判定：classifyAllergenText', () => {
  test('食材名・原材料（strict）：副詞の形でも除外せず、すべてエラー', () => {
    for (const t of [...ADVERB_LIKE, 'なめらかに', '静かに']) assert.equal(cls(t, 'strict').level, 'error', t);
  });

  test('料理名（name）：明確な副詞は「要確認」、それ以外はエラー', () => {
    assert.equal(cls('なめらかに仕上げた茶碗蒸し', 'name').level, 'warning');
    assert.deepEqual(cls('なめらかに仕上げた茶碗蒸し', 'name').warnings, ['なめらかに']);
    assert.equal(cls('あらかに汁', 'name').level, 'error', '未登録の「〜らかに」は料理名ではエラー');
    assert.equal(cls('カニ玉', 'name').level, 'error');
    assert.equal(cls('親子丼', 'name').level, 'none');
  });

  test('手順（prose）：明確な副詞は検出なし', () => {
    for (const t of ['なめらかに混ぜる', '静かに煮る', '柔らかに煮る', 'やわらかになるまで煮る', '細かに刻む', '鮮やかに仕上げる', 'ほのかに香る', 'まろやかになる']) {
      assert.equal(cls(t, 'prose').level, 'none', t);
    }
  });

  test('手順（prose）：判断できない表記は「検出なし」にせず要確認', () => {
    for (const t of ['あらかにを加える', 'たらかにをのせる', 'ふんわらかに混ぜる', '煮立ったらばらす', 'たらばを焼く']) {
      const r = cls(t, 'prose');
      assert.equal(r.level, 'warning', t);
      assert.ok(r.warnings.length > 0, t);
    }
  });

  test('手順（prose）：明確なアレルゲン表記はエラー（カタカナ・漢字・英字・副詞と隣接した場合も）', () => {
    for (const t of ['ゆでたかにの身をのせる', 'カニを加える', 'やわらかカニ', '蟹を蒸す', 'タラバを焼く', 'ﾀﾗﾊﾞｶﾞﾆ', 'えびを炒める', 'Add crab', 'なめらかにかにを混ぜる', 'なめらかに混ぜ、カニを加える']) {
      assert.equal(cls(t, 'prose').level, 'error', t);
    }
  });

  test('副詞の除外はひらがな表記だけ：カタカナの「ナメラカニ」はエラー', () => {
    assert.equal(cls('ナメラカニ', 'prose').level, 'error');
    assert.equal(cls('ｼｽﾞｶﾆ', 'prose').level, 'error');
  });

  test('該当表記なし', () => {
    for (const mode of ['strict', 'name', 'prose']) assert.equal(cls('鶏むね肉を焼く', mode).level, 'none', mode);
  });
});

describe('3段階判定：checkAllergens（食材名・原材料・料理名・手順）', () => {
  const withIngredient = (patch) => {
    const d = load();
    d.ingredients.items.x = { name: 'テスト食材', category: 'meat_fish', unit: 'g', purchase: null, nutrition: null, processed: true, allergenStatus: 'needs_label_check', containsAllergens: [], ...patch };
    d.week.recipes.oyakodon.ingredients.push({ id: 'x', qty: 1, unit: 'g' });
    return core.checkAllergens(d);
  };

  test('食材名：副詞の形の表記も見逃さない（エラー）', () => {
    for (const name of ADVERB_LIKE) {
      const r = withIngredient({ name });
      assert.equal(r.status, 'error', name);
    }
  });

  test('原材料情報：副詞の形の表記も見逃さない（エラー）', () => {
    for (const a of ADVERB_LIKE) assert.ok(withIngredient({ containsAllergens: [a] }).errors.some((e) => e.includes('除外アレルゲン')), a);
  });

  test('料理名：明確な副詞は要確認の警告（エラーではない）、検出なしにもならない', () => {
    const d = load();
    d.week.recipes.oyakodon.name = 'なめらかに仕上げた親子丼';
    const r = core.checkAllergens(d);
    assert.deepEqual(r.errors, []);
    assert.equal(r.status, 'warning');
    assert.ok(r.warnings.some((w) => w.includes('なめらかに')));
    assert.ok(core.buildPlan(d).warnings.some((w) => w.startsWith('【アレルギー要確認】')), '画面の注意欄に出る');
  });

  test('手順：曖昧な表記は警告、明確な副詞は何も出ない', () => {
    const d = load();
    d.week.recipes.yaki_udon.steps.push('煮立ったらばらす。');
    const r = core.checkAllergens(d);
    assert.deepEqual(r.errors, []);
    assert.equal(r.status, 'warning');
    const d2 = load();
    d2.week.recipes.yaki_udon.steps.push('卵はなめらかに混ぜ、静かに火を通す。');
    assert.equal(core.checkAllergens(d2).status, 'none');
  });

  test('エラーと警告が同時にある場合、状態はエラー', () => {
    const d = load();
    d.week.recipes.yaki_udon.steps.push('煮立ったらばらす。', 'カニを加える。');
    const r = core.checkAllergens(d);
    assert.equal(r.status, 'error');
    assert.ok(r.warnings.length > 0);
  });

  test('実データ：検出なし（status none）でもエラー・警告とも0', () => {
    const r = core.checkAllergens(load());
    assert.equal(r.status, 'none');
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
  });

  test('食材名・原材料情報を strict 以外にする設定は検証エラー', () => {
    const d = load();
    d.config.allergens.fieldModes.ingredientName = 'prose';
    d.config.allergens.fieldModes.containsAllergens = 'name';
    const errs = core.validateConfig(d.config, d.ingredients).errors.join('\n');
    assert.match(errs, /ingredientName は見逃し防止のため strict/);
    assert.match(errs, /containsAllergens は見逃し防止のため strict/);
  });

  test('注意文は安全を保証せず、パッケージの原材料表示・混入の注意表示の確認を求める', () => {
    const { notice, levels } = load().config.allergens;
    assert.match(notice, /安全を保証するものではありません/);
    assert.match(notice, /原材料表示/);
    assert.match(notice, /混入/);
    assert.match(levels.none, /登録データ上で検出なし/);
  });
});

describe('予算：3種類の費用の独立性と未確定・超過の判定', () => {
  const staples = (d) => Object.fromEntries(Object.entries(d.ingredients.items).filter(([, v]) => v.staple).map(([k]) => [k, true]));

  test('購入予定額だけが在庫・購入済みで変わり、初回・通常週は変わらない', () => {
    const d = load();
    const a = plan(d).budget;
    const b = plan(d, { stock: { ...staples(d), chicken_breast: true }, purchased: { egg: true } }).budget;
    assert.equal(b.initial.known, a.initial.known);
    assert.equal(b.regular.known, a.regular.known);
    assert.equal(b.plannedKnown, a.regular.known - 810);
  });

  test('生鮮食品の価格未設定：初回・通常週・購入予定額すべて未確定（予算内と判定しない）', () => {
    const d = load();
    d.ingredients.items.onion.purchase.priceStatus = 'unset';
    const b = plan(d, { stock: staples(d), purchased: {} }).budget;
    assert.equal(b.initial.determined, false);
    assert.equal(b.regular.determined, false);
    assert.equal(b.regular.status, 'undetermined');
    assert.equal(b.status, 'undetermined');
    assert.deepEqual(b.plannedUnset, ['玉ねぎ']);
  });

  test('常備品だけ価格未設定：初回のみ未確定、通常週は確定、常備品を在庫ありにすれば購入予定額も確定', () => {
    const d = load();
    d.ingredients.items.miso.purchase.priceStatus = 'unset';
    const b0 = plan(d).budget;
    assert.equal(b0.initial.determined, false);
    assert.equal(b0.regular.determined, true);
    assert.deepEqual(b0.plannedUnset, ['味噌'], '購入対象に未設定があれば購入予定額は未確定');
    assert.equal(b0.status, 'over', '既知分だけで超過なら超過');
    const b1 = plan(d, { stock: staples(d), purchased: {} }).budget;
    assert.deepEqual(b1.plannedUnset, []);
    assert.equal(b1.status, 'within');
  });

  test('超過の判定：初回のみ超過（現在のデータ）', () => {
    const b = plan(load()).budget;
    assert.equal(b.initial.status, 'over');
    assert.equal(b.regular.status, 'within');
  });

  test('超過の判定：通常週も超過すると、両方 over・CLI ゲートはエラー', () => {
    const d = load();
    d.ingredients.items.salmon.purchase.priceYen = 2000; // +1,600円 → 通常週 10,580円
    const b = plan(d).budget;
    assert.equal(b.regular.known, 8980 + 1600);
    assert.equal(b.regular.status, 'over');
    assert.equal(b.initial.status, 'over');
    assert.ok(budgetGate(b, d.config).errors.some((e) => e.includes('通常週')));
  });

  test('未確定の費用は、既知分が上限未満でも予算内と判定しない', () => {
    const d = load();
    d.ingredients.items.salmon.purchase = null;
    const b = plan(d).budget;
    assert.ok(b.regular.known < b.limit);
    assert.notEqual(b.regular.status, 'within');
    assert.notEqual(b.regular.status, 'near');
  });
});
