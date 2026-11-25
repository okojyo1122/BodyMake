// Phase 3 修正分のテスト：アレルギー表記ゆれ・栄養の欠損表示・初回購入／通常週・妻の朝食・常備品の次週引き継ぎ・原材料確認の理由
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as core from '../meals/lib/plan-core.js';

const read = (p) => JSON.parse(readFileSync(new URL(`../data/meals/${p}`, import.meta.url), 'utf8'));
const load = () => ({ config: read('config.json'), ingredients: read('ingredients.json'), week: read('weeks/2026-11-30.json') });
const plan = (d, settings, weekState) => core.buildPlan({ ...d, settings: settings && core.resolveSettings(d.config, settings), weekState });
const find = (p, id) => p.shopping.flatMap((g) => g.items).find((i) => i.id === id);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const DAY1 = '2026-11-30';
const stapleIds = (d) => Object.entries(d.ingredients.items).filter(([, v]) => v.staple).map(([k]) => k);
const allTrue = (ids) => Object.fromEntries(ids.map((k) => [k, true]));

// ---------------------------------------------------------------- アレルギー
describe('アレルギー：表記ゆれの検出と誤検出防止（A-1・A-2）', () => {
  const d0 = load();
  const ac = d0.config.allergens;
  const DETECT = ['エビ', 'えび', '海老', '蝦', 'ｴﾋﾞ', 'ｴﾋﾞﾁﾘ', 'カニ', 'かに', '蟹', 'ガニ', 'がに', 'ｶﾆ', '毛ガニ', '毛がに', 'ずわいがに', 'ズワイガニ', 'タラバガニ', 'たらばがに', 'ロブスター', 'ﾛﾌﾞｽﾀｰ', 'オマール海老', 'shrimp', 'SHRIMP', 'ｓｈｒｉｍｐ', 'crab', 'Crab', 'lobster', 'prawn', 'シュリンプ', '甲殻類'];
  const SAFE = ['なめらかに混ぜる', '滑らかにする', '静かに煮る', '細かに刻む', 'こまかに刻む', '鮮やかに仕上げる', 'ほのかに香る', 'わずかに残す', 'たしかに火を通す', 'ゆるやかに冷ます', '柔らかに煮る', 'やわらかになるまで', '穏やかに温める', '明らかに', '豊かに香る', '鶏むね肉', 'さば水煮缶', 'ねぎ', 'たまねぎ', 'しめじ', 'かぼちゃ', 'にんにく', '大根'];

  test('正規化：半角カナ→全角、カタカナ→ひらがな、英字→小文字', () => {
    assert.equal(core.normalizeForAllergen('ｴﾋﾞ'), 'えび');
    assert.equal(core.normalizeForAllergen('タラバガニ'), 'たらばがに');
    assert.equal(core.normalizeForAllergen('ＳＨＲＩＭＰ'), 'shrimp');
    assert.equal(core.normalizeForAllergen('ロブスター'), 'ろぶすたー');
  });

  test('検出すべき表記をすべて検出（キーワード関数単体）', () => {
    for (const w of DETECT) assert.ok(core.allergenKeywordHits(w, ac).length > 0, w);
  });

  test('無関係な語（「なめらかに」等の副詞・通常の食材名）は検出しない', () => {
    for (const w of SAFE) assert.deepEqual(core.allergenKeywordHits(w, ac), [], w);
  });

  test('カタカナの「カニ」は直前がひらがなでも検出（副詞の除外に巻き込まれない）', () => {
    for (const w of ['ゆでたカニを加える', 'あらかじめカニをほぐす', 'やわらかカニ', 'のｶﾆ']) assert.ok(core.allergenKeywordHits(w, ac).length > 0, w);
    assert.ok(core.allergenKeywordHits('ゆでたかにをほぐす', ac).length > 0, 'ひらがなでも副詞でなければ検出');
  });

  const withIngredient = (patch) => {
    const d = load();
    d.ingredients.items.x = { name: 'テスト食材', category: 'meat_fish', unit: 'g', purchase: null, nutrition: null, processed: true, allergenStatus: 'needs_label_check', containsAllergens: [], ...patch };
    d.week.recipes.oyakodon.ingredients.push({ id: 'x', qty: 1, unit: 'g' });
    return core.checkAllergens(d);
  };

  test('食材名：表記ゆれをすべて検出', () => {
    for (const name of DETECT) assert.ok(withIngredient({ name }).errors.length > 0, name);
  });

  test('食材名：無関係な名前は検出しない', () => {
    for (const name of ['なめらかプリン', '静岡県産みかん', 'かぼちゃ', 'たまねぎ']) assert.deepEqual(withIngredient({ name }).errors, [], name);
  });

  test('原材料（containsAllergens）：id・日本語・表記ゆれをすべて検出', () => {
    for (const a of ['shrimp', 'crab', 'えび', 'エビ', 'かに', 'カニ', '蟹', 'ｶﾆ', 'ずわいがに', '甲殻類', 'えびエキス', 'かにエキス']) {
      const r = withIngredient({ containsAllergens: [a] });
      assert.ok(r.errors.some((e) => e.includes('除外アレルゲン')), a);
    }
  });

  test('原材料（containsAllergens）：他のアレルゲン（大豆・小麦・さば等）は検出しない', () => {
    assert.deepEqual(withIngredient({ containsAllergens: ['大豆', '小麦', 'さば', '豚肉', '卵', '乳', 'ごま'] }).errors, []);
  });

  test('料理名：表記ゆれを検出、無関係な名前は検出しない', () => {
    for (const name of ['ｴﾋﾞﾁﾘ', '蝦の炒め物', '毛ガニの味噌汁', 'ずわいがに雑炊', 'ロブスターのグリル', 'カニカマサラダ']) {
      const d = load();
      d.week.recipes.oyakodon.name = name;
      assert.ok(core.checkAllergens(d).errors.some((e) => e.includes('料理') && e.includes('名称')), name);
    }
    const d = load();
    d.week.recipes.oyakodon.name = 'なめらか卵の親子丼';
    assert.deepEqual(core.checkAllergens(d).errors, []);
  });

  test('調理手順：表記ゆれを検出、副詞は検出しない', () => {
    for (const step of ['毛ガニをほぐして加える。', 'ゆでたかにの身をのせる。', 'ｴﾋﾞを炒める。', 'えびを加える。', '蝦を加える。', 'タラバガニの脚を焼く。', 'Add the shrimp.']) {
      const d = load();
      d.week.recipes.yaki_udon.steps.push(step);
      assert.ok(core.checkAllergens(d).errors.some((e) => e.includes('手順')), step);
    }
    const d = load();
    d.week.recipes.yaki_udon.steps.push('卵はなめらかに混ぜ、静かに火を通す。細かに刻んだねぎを鮮やかに散らし、ほのかに香らせる。');
    assert.deepEqual(core.checkAllergens(d).errors, []);
  });

  test('実データ（現在の週）は誤検出なし', () => {
    assert.deepEqual(core.checkAllergens(load()).errors, []);
  });

  test('ambiguousPatterns が不正な正規表現なら設定エラー', () => {
    const d = load();
    d.config.allergens.ambiguousPatterns = ['(かに'];
    assert.ok(core.validateConfig(d.config, d.ingredients).errors.some((e) => e.includes('ambiguousPatterns')));
  });
});

// ---------------------------------------------------------------- 栄養の欠損
describe('栄養：欠損時の「不完全」表示（N-1）', () => {
  const d = load();
  delete d.ingredients.items.chicken_breast.nutrition; // 月曜昼の親子丼に使用
  const p = plan(d);
  const n = p.nutrition;

  test('欠損食材を含む食事だけが不完全', () => {
    assert.equal(n.byDay[DAY1].me.bySlotIncomplete.lunch, true);
    assert.equal(n.byDay[DAY1].wife.bySlotIncomplete.lunch, true);
    assert.notEqual(n.byDay[DAY1].me.bySlotIncomplete.breakfast, true);
  });

  test('その日の合計も不完全、欠損した食材 id を保持', () => {
    assert.equal(n.byDay[DAY1].me.incomplete, true);
    assert.deepEqual(n.byDay[DAY1].me.missingIds, ['chicken_breast']);
  });

  test('欠損食材を使わない日は不完全にならない', () => {
    const usedDays = new Set(p.usages.filter((u) => u.ingredientId === 'chicken_breast').map((u) => u.date));
    for (const [date, day] of Object.entries(n.byDay)) assert.equal(day.me.incomplete, usedDays.has(date), date);
  });

  test('週平均も不完全', () => {
    assert.equal(n.weekAvgIncomplete.me, true);
    assert.equal(n.weekAvgIncomplete.wife, true);
  });

  test('欠損がなければどこにも不完全の印は付かない', () => {
    const ok = plan(load()).nutrition;
    assert.deepEqual(ok.weekAvgIncomplete, { me: false, wife: false });
    for (const day of Object.values(ok.byDay)) for (const person of Object.values(day)) {
      assert.equal(person.incomplete, false);
      assert.deepEqual(person.bySlotIncomplete, {});
    }
  });

  test('欠損食材が片方の人の朝食だけなら、その人のその食事だけ不完全', () => {
    const d2 = load();
    delete d2.ingredients.items.mekabu.nutrition; // 本人の朝食のみ
    const n2 = plan(d2).nutrition;
    assert.equal(n2.byDay[DAY1].me.bySlotIncomplete.breakfast, true);
    assert.notEqual(n2.byDay[DAY1].wife.bySlotIncomplete.breakfast, true);
    assert.equal(n2.weekAvgIncomplete.wife, false);
  });

  test('使用量0（妻のソーセージ0本）の欠損は不完全にしない', () => {
    const d2 = load();
    delete d2.ingredients.items.sausage.nutrition;
    const n2 = plan(d2, { breakfastQty: { wife: { sausage: 0 } } }).nutrition;
    assert.equal(n2.weekAvgIncomplete.wife, false);
  });
});

// ---------------------------------------------------------------- 初回購入・通常週
describe('予算：初回購入費用と通常週の費用', () => {
  test('初回購入 12,970円（全品）／通常週 8,980円（常備品15品を除く）', () => {
    const d = load();
    const b = plan(d).budget;
    assert.equal(b.initial.known, 12970);
    assert.equal(b.initial.status, 'over');
    assert.equal(b.regular.known, 8980);
    assert.equal(b.regular.status, 'within');
    assert.equal(b.regular.stapleNames.length, 15);
    assert.ok(b.initial.determined && b.regular.determined);
  });

  test('通常週 = 初回 − 常備品の購入額（独立に再計算して一致）', () => {
    const d = load();
    const p = plan(d);
    const rows = p.shopping.flatMap((g) => g.items).filter((i) => !i.excluded);
    const staple = rows.filter((i) => d.ingredients.items[i.id].staple).reduce((a, i) => a + i.cost, 0);
    assert.equal(p.budget.regular.known, p.budget.initial.known - staple);
  });

  test('在庫ありのチェックで初回・通常週の金額は変わらない（購入予定額だけが変わる）', () => {
    const d = load();
    const base = plan(d).budget;
    const b = plan(d, undefined, { stock: { egg: true, soy_sauce: true }, purchased: { onion: true } }).budget;
    assert.equal(b.initial.known, base.initial.known);
    assert.equal(b.regular.known, base.regular.known);
    assert.equal(b.plannedKnown, base.plannedKnown - 900 - 330);
  });

  test('常備品をすべて在庫ありにすると、購入予定額 = 通常週の費用（整合）', () => {
    const d = load();
    const b = plan(d, undefined, { stock: allTrue(stapleIds(d)), purchased: {} }).budget;
    assert.equal(b.plannedKnown, b.regular.known);
    assert.equal(b.status, b.regular.status);
  });

  test('生鮮食品に価格未設定 → 初回・通常週とも未確定（既知分のみ）', () => {
    const d = load();
    d.ingredients.items.salmon.purchase = { size: 2, label: '1パック', priceStatus: 'unset' };
    const b = plan(d).budget;
    assert.equal(b.initial.determined, false);
    assert.equal(b.regular.determined, false);
    assert.deepEqual(b.initial.unset, ['生鮭（切り身）']);
    assert.deepEqual(b.regular.unset, ['生鮭（切り身）']);
    assert.equal(b.regular.known, 8980 - 400);
    assert.equal(b.regular.status, 'undetermined', '既知分が上限未満なら「予算内」とせず未確定');
    assert.equal(b.initial.status, 'over', '既知分だけで上限超過なら超過');
  });

  test('常備品だけに価格未設定 → 初回は未確定、通常週は確定', () => {
    const d = load();
    d.ingredients.items.jam.purchase = null;
    const b = plan(d).budget;
    assert.equal(b.initial.determined, false);
    assert.deepEqual(b.initial.unset, ['ジャム（いちご）']);
    assert.equal(b.regular.determined, true);
  });

  test('予算ゲート（CLI）は通常週で判定する', async () => {
    const { budgetGate } = await import('../scripts/validate.mjs');
    const d = load();
    const b = plan(d).budget;
    const g = budgetGate(b, d.config);
    assert.deepEqual(g.errors, []);
    assert.ok(g.warnings.some((w) => w.includes('初回購入')));
    const over = budgetGate({ ...b, regular: { ...b.regular, known: 10001 } }, d.config);
    assert.ok(over.errors.some((e) => e.includes('通常週')));
  });
});

// ---------------------------------------------------------------- 妻の朝食
describe('妻の朝食：初期値・数量変更・栄養', () => {
  const wifeBf = (p, id) => p.usages.filter((u) => u.slot === 'breakfast' && u.shares.wife != null && u.ingredientId === id).reduce((a, u) => a + u.qty, 0);

  test('初期値：食パン2枚・ジャム大さじ1・卵1・ソーセージ2・調理油小さじ1', () => {
    const { config } = load();
    const items = Object.fromEntries(config.breakfasts.wife.items.map((i) => [i.key, i]));
    assert.deepEqual([items.bread.qty, items.bread.unit], [2, '枚']);
    assert.deepEqual([items.jam.qty, items.jam.unit], [1, '大さじ']);
    assert.deepEqual([items.egg.qty, items.egg.unit], [1, '個']);
    assert.deepEqual([items.sausage.qty, items.sausage.unit], [2, '本']);
    assert.deepEqual([items.oil.qty, items.oil.unit, items.oil.ingredient], [1, '小さじ', 'salad_oil']);
  });

  test('卵・ソーセージ・ジャム・調理油は変更可能かつ仮設定、食パンは固定', () => {
    const { config } = load();
    for (const it of config.breakfasts.wife.items) {
      const expected = ['egg', 'sausage', 'jam', 'oil'].includes(it.key);
      assert.equal(!!it.editable, expected, it.key);
      assert.equal(!!it.provisional, expected, it.key);
    }
  });

  test('栄養（1日）：食パン298＋ジャム52.5＋卵71＋ソーセージ128＋調理油40.75＝590.25kcal', () => {
    const p = plan(load());
    near(p.nutrition.byDay[DAY1].wife.bySlot.breakfast.kcal, 298 + 52.5 + 71 + 128 + 40.75);
    near(p.nutrition.byDay[DAY1].wife.bySlot.breakfast.fat, 2.5 * 2 + 0.021 + 5.1 + 6.1 * 2 + 4.6);
  });

  test('ジャムを大さじ2にすると：必要量294g・2瓶、栄養 +52.5kcal/日', () => {
    const d = load();
    const base = plan(d);
    const p = plan(d, { breakfastQty: { wife: { jam: 2 } } });
    assert.equal(wifeBf(p, 'jam'), 294);
    assert.equal(find(p, 'jam').count, 2);
    near(p.nutrition.byDay[DAY1].wife.bySlot.breakfast.kcal - base.nutrition.byDay[DAY1].wife.bySlot.breakfast.kcal, 52.5);
    assert.equal(p.budget.initial.known - base.budget.initial.known, 330, 'ジャム1瓶分増える');
  });

  test('ジャム0にすると買い物リストのジャムは0・栄養から消える', () => {
    const d = load();
    const p = plan(d, { breakfastQty: { wife: { jam: 0 } } });
    assert.equal(wifeBf(p, 'jam'), 0);
    assert.equal(find(p, 'jam').count, 0);
  });

  test('調理油を小さじ2にすると：サラダ油 +35ml/週、栄養 +40.75kcal/日', () => {
    const d = load();
    const base = plan(d);
    const p = plan(d, { breakfastQty: { wife: { oil: 2 } } });
    assert.equal(wifeBf(p, 'salad_oil'), 70);
    near(find(p, 'salad_oil').need - find(base, 'salad_oil').need, 35);
    near(p.nutrition.byDay[DAY1].wife.bySlot.breakfast.kcal - base.nutrition.byDay[DAY1].wife.bySlot.breakfast.kcal, 40.75);
  });

  test('数量は範囲内・刻み（0.5）に丸める', () => {
    const { config } = load();
    const s = core.resolveSettings(config, { breakfastQty: { wife: { jam: 1.3, oil: 99, egg: 'x' } } });
    assert.equal(s.breakfastQty.wife.jam, 1.5);
    assert.equal(s.breakfastQty.wife.oil, 3);
    assert.equal(s.breakfastQty.wife.egg, 1);
  });

  test('本人の朝食は変わらない', () => {
    const p = plan(load(), { breakfastQty: { wife: { jam: 3, oil: 3, egg: 4, sausage: 6 } } });
    assert.equal(Math.round(p.nutrition.byDay[DAY1].me.bySlot.breakfast.kcal), 393);
  });
});

// ---------------------------------------------------------------- 次週への引き継ぎ
describe('常備品の在庫：次週への引き継ぎ', () => {
  const { ingredients } = load();
  const W1 = '2026-11-30';
  const W2 = '2026-12-07';
  const W3 = '2026-12-14';
  const mkStore = (init = {}) => {
    const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
    return {
      read: (k) => (m.has(k) ? JSON.parse(m.get(k)) : null),
      write: (k, v) => m.set(k, JSON.stringify(v)),
      has: (k) => m.has(k),
    };
  };
  const open = (store, weekStart, weekStarts = [W1, W2, W3]) => {
    const r = core.loadWeekStateWithCarryOver({ weekStart, weekStarts, read: store.read, ingredients });
    if (r.created) store.write(core.storageKeys.week(weekStart), r.state);
    return r;
  };
  const prevState = {
    stock: { soy_sauce: true, jam: true, salt: true, egg: true, chicken_breast: true, onion: true, tofu_kinu: true },
    purchased: { soy_sauce: true, egg: true, cabbage: true },
  };

  test('常備品の在庫ありだけを引き継ぐ', () => {
    const store = mkStore({ [core.storageKeys.week(W1)]: prevState });
    const r = open(store, W2);
    assert.equal(r.created, true);
    assert.deepEqual(Object.keys(r.state.stock).sort(), ['jam', 'salt', 'soy_sauce']);
    assert.equal(r.state.inheritedFrom, W1);
  });

  test('生鮮食品（肉・野菜・卵・豆腐）は引き継がない', () => {
    const store = mkStore({ [core.storageKeys.week(W1)]: prevState });
    const { state } = open(store, W2);
    for (const id of ['egg', 'chicken_breast', 'onion', 'tofu_kinu']) assert.equal(state.stock[id], undefined, id);
  });

  test('購入済みは引き継がない（常備品の購入済みも）', () => {
    const store = mkStore({ [core.storageKeys.week(W1)]: prevState });
    assert.deepEqual(open(store, W2).state.purchased, {});
  });

  test('次週で変更した在庫状態は、再読み込み後も維持される（引き継ぎで上書きしない）', () => {
    const store = mkStore({ [core.storageKeys.week(W1)]: prevState });
    const first = open(store, W2);
    // 利用者が醤油の在庫を外し、みりんを在庫ありにし、卵を購入済みにした
    const edited = structuredClone(first.state);
    delete edited.stock.soy_sauce;
    edited.stock.mirin = true;
    edited.purchased.egg = true;
    store.write(core.storageKeys.week(W2), edited);
    // 前週側がその後変わっても影響しない
    store.write(core.storageKeys.week(W1), { stock: { soy_sauce: true, sugar: true }, purchased: {} });
    const again = open(store, W2);
    assert.equal(again.created, false);
    assert.deepEqual(again.state.stock, { jam: true, salt: true, mirin: true });
    assert.deepEqual(again.state.purchased, { egg: true });
  });

  test('すべて外した状態（空）も再読み込みで維持される', () => {
    const store = mkStore({ [core.storageKeys.week(W1)]: prevState });
    open(store, W2);
    store.write(core.storageKeys.week(W2), { stock: {}, purchased: {} });
    assert.deepEqual(open(store, W2).state, { stock: {}, purchased: {} });
  });

  test('引き継ぎは直前の保存済みの週から（間の週が未表示でも可）、前の週が無ければ空', () => {
    const store = mkStore({ [core.storageKeys.week(W1)]: prevState });
    assert.equal(open(store, W3).state.inheritedFrom, W1);
    const empty = mkStore();
    const r = open(empty, W1);
    assert.equal(r.created, true);
    assert.deepEqual(r.state, { purchased: {}, stock: {} });
  });

  test('後の週の状態を前の週へは引き継がない', () => {
    const store = mkStore({ [core.storageKeys.week(W2)]: prevState });
    assert.deepEqual(open(store, W1).state.stock, {});
  });

  test('引き継いだ常備品で、購入予定額 = 通常週の費用（常備品を全部在庫ありにしていた場合）', () => {
    const d = load();
    const store = mkStore({ [core.storageKeys.week(W1)]: { stock: allTrue(stapleIds(d)), purchased: {} } });
    const { state } = open(store, W2);
    const b = plan(d, undefined, state).budget;
    assert.equal(b.plannedKnown, b.regular.known);
  });

  test('常備品は加工品のみ（生鮮に staple を付けると検証エラー）', () => {
    const d = load();
    for (const id of stapleIds(d)) assert.equal(d.ingredients.items[id].processed, true, id);
    d.ingredients.items.chicken_breast.staple = true;
    assert.ok(core.validateIngredients(d.ingredients).errors.some((e) => e.includes('chicken_breast') && e.includes('常備品')));
  });
});

// ---------------------------------------------------------------- 原材料確認の理由
describe('原材料確認リスト：理由と確認優先度（B-3）', () => {
  test('確認対象22品すべてに理由と優先度（high/medium/low）がある', () => {
    const d = load();
    const r = core.checkAllergens(d);
    assert.equal(r.labelChecks.length, 22);
    for (const l of r.labelChecks) {
      assert.ok(l.reason && l.reason.length > 5, l.id);
      assert.ok(['high', 'medium', 'low'].includes(l.risk), l.id);
    }
  });

  test('優先度の高い順に並ぶ', () => {
    const r = core.checkAllergens(load());
    const rank = { high: 0, medium: 1, low: 2 };
    const ranks = r.labelChecks.map((l) => rank[l.risk]);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
    assert.deepEqual(r.labelChecks.filter((l) => l.risk === 'high').map((l) => l.id).sort(), ['dashi_granule', 'mekabu', 'miso', 'torigara']);
  });

  test('理由・優先度が無い／不正なら検証エラー', () => {
    const d = load();
    delete d.ingredients.items.miso.labelCheckReason;
    d.ingredients.items.torigara.labelCheckRisk = 'danger';
    const errs = core.validateIngredients(d.ingredients).errors.join('\n');
    assert.match(errs, /miso: 原材料確認の理由/);
    assert.match(errs, /torigara: labelCheckRisk/);
  });

  test('優先度の説明文は「目安」であり危険性を断定しないことを明記', () => {
    const { ingredients } = load();
    assert.match(ingredients.labelCheckRiskInfo.note, /目安/);
    assert.match(ingredients.labelCheckRiskInfo.note, /断定するものではありません/);
  });
});
