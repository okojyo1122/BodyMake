// 週間献立の決定的な計算ロジック（ブラウザ / Node 共用・副作用なし）。
// 集計・予算・栄養・アレルギー・データ検証はすべてここで行い、AIには任せない。

export const STORAGE_PREFIX = 'bodymake.meals.v1';
export const storageKeys = {
  settings: `${STORAGE_PREFIX}.settings`,
  week: (weekStart) => `${STORAGE_PREFIX}.week.${weekStart}`,
};

export const SLOTS = ['lunch', 'dinner'];
export const SLOT_LABELS = { breakfast: '朝食', lunch: '昼食', dinner: '夕食' };
export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const PRICE_STATUSES = ['estimated', 'unset'];
const ALLERGEN_STATUSES = ['free', 'needs_label_check', 'contains'];
const EPS = 1e-9;

export function round(n, digits = 1) {
  const f = 10 ** digits;
  return Math.round((n + Number.EPSILON) * f) / f;
}

export function formatNumber(n, digits = 2) {
  return String(round(n, digits));
}

/** レシピ表記（大さじ2 / 少々 / 200g）で数量を表示する */
export function formatQty(qty, unit) {
  if (unit === '少々') return qty === 1 ? '少々' : `少々×${formatNumber(qty)}`;
  if (unit === '大さじ' || unit === '小さじ') return `${unit}${formatNumber(qty)}`;
  return `${formatNumber(qty)}${unit}`;
}

export function formatYen(n) {
  return `${Math.round(n).toLocaleString('ja-JP')}円`;
}

// ---------- 日付 ----------
export function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
}
export function addDays(s, n) {
  const d = parseDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function weekdayLabel(s) {
  return WEEKDAYS[parseDate(s).getUTCDay()];
}
export function formatDateJa(s) {
  const d = parseDate(s);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEKDAYS[d.getUTCDay()]}）`;
}

// ---------- 単位 ----------
/** レシピ上の数量を食材の基本単位に変換する。変換できない単位は例外。 */
export function toCanonical(ingredient, qty, unit) {
  if (!ingredient) throw new Error('食材が見つかりません');
  if (typeof qty !== 'number' || !Number.isFinite(qty) || qty < 0) {
    throw new Error(`${ingredient.name}: 数量が不正です (${qty})`);
  }
  if (unit === ingredient.unit) return qty;
  const factor = ingredient.conversions?.[unit];
  if (typeof factor === 'number' && factor > 0) return qty * factor;
  throw new Error(`${ingredient.name}: 単位「${unit}」を基本単位「${ingredient.unit}」に変換できません`);
}

// ---------- 個別設定 ----------
function clampNum(v, lim, fallback) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  let x = Math.min(lim.max, Math.max(lim.min, n));
  if (lim.step) x = round(Math.round((x - lim.min) / lim.step) * lim.step + lim.min, 4);
  return x;
}

export function defaultSettings(config) {
  const breakfastQty = {};
  for (const [pid, bf] of Object.entries(config.breakfasts)) {
    for (const it of bf.items) {
      if (it.editable) (breakfastQty[pid] ??= {})[it.key] = it.qty;
    }
  }
  return {
    mealRiceGrams: { ...config.defaults.mealRiceGrams },
    mainDishFactor: { ...config.defaults.mainDishFactor },
    breakfastQty,
  };
}

/** LocalStorage 等から読んだ値を検証し、範囲外・不正値は初期値に戻す */
export function resolveSettings(config, stored) {
  const def = defaultSettings(config);
  const s = stored && typeof stored === 'object' ? stored : {};
  const lim = config.settingsLimits;
  const out = { mealRiceGrams: {}, mainDishFactor: {}, breakfastQty: {} };
  for (const p of config.people) {
    out.mealRiceGrams[p.id] = clampNum(s.mealRiceGrams?.[p.id], lim.mealRiceGrams, def.mealRiceGrams[p.id]);
    out.mainDishFactor[p.id] = clampNum(s.mainDishFactor?.[p.id], lim.mainDishFactor, def.mainDishFactor[p.id]);
  }
  for (const [pid, bf] of Object.entries(config.breakfasts)) {
    for (const it of bf.items) {
      if (!it.editable) continue;
      (out.breakfastQty[pid] ??= {})[it.key] = clampNum(s.breakfastQty?.[pid]?.[it.key], it.editable, it.qty);
    }
  }
  return out;
}

export function resolveWeekState(stored) {
  const pick = (o) => {
    const r = {};
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (v === true) r[k] = true;
    return r;
  };
  const out = { purchased: pick(stored?.purchased), stock: pick(stored?.stock) };
  const from = stored?.inheritedFrom;
  if (typeof from === 'string' && parseDate(from)) out.inheritedFrom = from;
  return out;
}

// ---------- 展開 ----------
function avgFactor(config, settings) {
  const ids = config.people.map((p) => p.id);
  return ids.reduce((a, id) => a + settings.mainDishFactor[id], 0) / ids.length;
}

/** 朝食の実際の数量（個別設定を反映） */
export function breakfastItems(config, settings, personId) {
  const bf = config.breakfasts[personId];
  if (!bf) return [];
  return bf.items.map((it) => ({
    ...it,
    qty: it.editable ? settings.breakfastQty?.[personId]?.[it.key] ?? it.qty : it.qty,
  }));
}

/** 2人分レシピの材料を、主菜倍率を反映した数量と1人あたり配分にする */
export function scaledRecipeIngredients(recipe, config, settings) {
  const f = avgFactor(config, settings);
  const ids = config.people.map((p) => p.id);
  return recipe.ingredients.map((ri) => {
    const qty = ri.main ? ri.qty * f : ri.qty;
    const shares = {};
    for (const id of ids) {
      shares[id] = ri.main ? (ri.qty / ids.length) * settings.mainDishFactor[id] : ri.qty / ids.length;
    }
    return { ...ri, qty, shareRatio: Object.fromEntries(ids.map((id) => [id, qty > 0 ? shares[id] / qty : 0])) };
  });
}

/**
 * 1週間分の食材使用を明細化する。
 * 各明細: { ingredientId, qty(基本単位), shares{personId: 基本単位量}, date, slot, recipeId?, label }
 */
export function expandWeek({ config, ingredients, week, settings }) {
  const items = ingredients.items;
  const usages = [];
  const riceId = config.rice.ingredientId;
  const push = (u) => usages.push(u);

  for (const day of week.days) {
    // 朝食（個別・固定）
    for (const p of config.people) {
      for (const it of breakfastItems(config, settings, p.id)) {
        const ing = items[it.ingredient];
        const q = toCanonical(ing, it.qty, it.unit);
        push({ ingredientId: it.ingredient, qty: q, shares: { [p.id]: q }, date: day.date, slot: 'breakfast', recipeId: null, label: `${p.label}の朝食` });
      }
    }
    // 昼食・夕食（2人共通）
    for (const slot of SLOTS) {
      const meal = day[slot];
      if (!meal) continue;
      for (const rid of meal.recipes) {
        const recipe = week.recipes[rid];
        for (const ri of scaledRecipeIngredients(recipe, config, settings)) {
          const ing = items[ri.id];
          const q = toCanonical(ing, ri.qty, ri.unit);
          const shares = Object.fromEntries(Object.entries(ri.shareRatio).map(([k, r]) => [k, q * r]));
          push({ ingredientId: ri.id, qty: q, shares, date: day.date, slot, recipeId: rid, label: recipe.name });
        }
      }
      if (meal.withRice) {
        const shares = {};
        let total = 0;
        for (const p of config.people) {
          shares[p.id] = settings.mealRiceGrams[p.id];
          total += shares[p.id];
        }
        if (total > 0) push({ ingredientId: riceId, qty: total, shares, date: day.date, slot, recipeId: null, label: `${SLOT_LABELS[slot]}のご飯` });
      }
    }
  }
  return usages;
}

// ---------- 栄養 ----------
const ZERO = () => ({ kcal: 0, protein: 0, fat: 0, carbs: 0 });

export function nutritionOf(ingredient, qtyCanonical) {
  const n = ingredient?.nutrition;
  if (!n || typeof n.per !== 'number' || n.per <= 0) return null;
  const r = qtyCanonical / n.per;
  return { kcal: n.kcal * r, protein: n.protein * r, fat: n.fat * r, carbs: n.carbs * r };
}

/**
 * 人ごと・日ごと・食事ごとの栄養（目安）。
 * 栄養値が無い食材は計算から除外し、その食材を含む食事・日・週平均に「不完全」の印を付ける
 * （実際より少ない値が確定値のように見えないようにするため）。
 *   byDay[date][pid] = { total, bySlot, incomplete, bySlotIncomplete{slot:true}, missingIds[] }
 *   weekAvgIncomplete[pid] = true/false
 */
export function summarizeNutrition(usages, ingredients, config) {
  const items = ingredients.items;
  const byDay = {};
  const missing = new Set();
  for (const u of usages) {
    const day = (byDay[u.date] ??= {});
    for (const [pid, q] of Object.entries(u.shares)) {
      const person = (day[pid] ??= { total: ZERO(), bySlot: {}, incomplete: false, bySlotIncomplete: {}, missingIds: [] });
      const slot = (person.bySlot[u.slot] ??= ZERO());
      const n = nutritionOf(items[u.ingredientId], q);
      if (!n) {
        if (q > 0) {
          missing.add(u.ingredientId);
          person.incomplete = true;
          person.bySlotIncomplete[u.slot] = true;
          if (!person.missingIds.includes(u.ingredientId)) person.missingIds.push(u.ingredientId);
        }
        continue;
      }
      for (const k of Object.keys(n)) { person.total[k] += n[k]; slot[k] += n[k]; }
    }
  }
  const days = Object.keys(byDay);
  const weekAvg = {};
  const weekAvgIncomplete = {};
  for (const p of config.people) {
    const s = ZERO();
    for (const d of days) for (const k of Object.keys(s)) s[k] += byDay[d][p.id]?.total[k] ?? 0;
    weekAvg[p.id] = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, days.length ? v / days.length : 0]));
    weekAvgIncomplete[p.id] = days.some((d) => byDay[d][p.id]?.incomplete);
  }
  return { byDay, weekAvg, weekAvgIncomplete, missing: [...missing] };
}

// ---------- 買い物リスト・予算 ----------
export function purchasePlan(ingredient, need) {
  if (ingredient.excludedFromBudget) {
    return { count: null, cost: 0, priceStatus: 'excluded', leftover: null };
  }
  const p = ingredient.purchase;
  if (!p || typeof p.size !== 'number' || p.size <= 0) {
    return { count: null, cost: null, priceStatus: 'unset', leftover: null };
  }
  const count = need > 0 ? Math.ceil(need / p.size - EPS) : 0;
  const priced = p.priceStatus === 'estimated' && typeof p.priceYen === 'number' && p.priceYen >= 0;
  return {
    count,
    cost: priced ? count * p.priceYen : null,
    priceStatus: priced ? 'estimated' : 'unset',
    leftover: count * p.size - need,
  };
}

/** 同じ食材の必要量を合算し、購入単位に切り上げて価格を出す */
export function aggregateShopping(usages, ingredients, weekState = { purchased: {}, stock: {} }) {
  const items = ingredients.items;
  const map = new Map();
  for (const u of usages) {
    const e = map.get(u.ingredientId) ?? { need: 0, sources: new Set() };
    e.need += u.qty;
    e.sources.add(u.label);
    map.set(u.ingredientId, e);
  }
  const groups = ingredients.categories.map((c) => ({ ...c, items: [], subtotalKnown: 0, unsetCount: 0 }));
  const byCat = Object.fromEntries(groups.map((g) => [g.id, g]));
  for (const [id, e] of map) {
    const ing = items[id];
    const plan = purchasePlan(ing, e.need);
    const row = {
      id,
      name: ing.name,
      category: ing.category,
      unit: ing.unit,
      need: round(e.need, 2),
      purchaseLabel: ing.purchase?.label ?? null,
      purchaseSize: ing.purchase?.size ?? null,
      unitPrice: ing.purchase?.priceYen ?? null,
      ...plan,
      leftover: plan.leftover == null ? null : round(plan.leftover, 2),
      excluded: !!ing.excludedFromBudget,
      excludedReason: ing.excludedReason ?? null,
      inStock: !!weekState.stock?.[id],
      purchased: !!weekState.purchased?.[id],
      staple: !!ing.staple,
      needsLabelCheck: ing.allergenStatus !== 'free',
      note: ing.note ?? null,
      sources: [...e.sources],
    };
    const g = byCat[ing.category];
    g.items.push(row);
    if (!row.excluded && !row.inStock) {
      if (row.cost == null) g.unsetCount++;
      else g.subtotalKnown += row.cost;
    }
  }
  for (const g of groups) g.items.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  return groups.filter((g) => g.items.length > 0);
}

/**
 * 予算判定。価格未設定がある場合は「未確定」とし、予算内とは判定しない。
 * status: 'over' | 'undetermined' | 'near' | 'within'
 */
export function computeBudget(groups, config) {
  const limit = config.budget.weeklyLimitYen;
  const all = groups.flatMap((g) => g.items).filter((i) => !i.excluded);
  const tally = (rows) => ({
    known: rows.reduce((a, r) => a + (r.cost ?? 0), 0),
    unset: rows.filter((r) => r.cost == null).map((r) => r.name),
  });
  const planned = tally(all.filter((i) => !i.inStock));
  const full = tally(all);
  const nonSeasoning = tally(all.filter((i) => i.category !== 'seasoning'));
  const regular = tally(all.filter((i) => !i.staple));
  const statusOf = (t) => {
    if (t.known > limit) return 'over';
    if (t.unset.length > 0) return 'undetermined';
    if (t.known > limit * (config.budget.nearLimitRatio ?? 0.9)) return 'near';
    return 'within';
  };
  // 初回購入：常備品も含めて全食材を購入する場合（在庫チェックに関係なく一定）
  // 通常週：常備品はすべて在庫あり、それ以外は全て購入する場合（在庫チェックに関係なく一定）
  // 価格未設定がある場合 determined=false（金額は既知分のみで、確定値として扱わない）
  const scenario = (t) => ({ known: t.known, unset: t.unset, determined: t.unset.length === 0, status: statusOf(t) });
  return {
    limit,
    plannedKnown: planned.known,
    plannedUnset: planned.unset,
    remaining: limit - planned.known,
    status: statusOf(planned),
    fullKnown: full.known,
    fullUnset: full.unset,
    nonSeasoningKnown: nonSeasoning.known,
    nonSeasoningUnset: nonSeasoning.unset,
    initial: scenario(full),
    regular: { ...scenario(regular), stapleNames: all.filter((i) => i.staple).map((i) => i.name) },
    stockExcluded: all.filter((i) => i.inStock).map((i) => i.name),
  };
}

// ---------- 週の在庫状態（常備品の次週引き継ぎ） ----------
/**
 * 週の在庫・購入状態を決める。
 * - stored（その週の保存済み状態）があれば、それをそのまま使う（再読み込みで上書きしない）。
 * - 無ければ「その週の初回表示」として、previous（前の週の保存済み状態）から
 *   常備品（staple: true）の在庫ありだけを引き継ぐ。生鮮食品の在庫・購入済みは引き継がない。
 * 戻り値 { state, created }：created=true のときは呼び出し側で保存し、以後は引き継ぎ済みとして扱う。
 */
export function initWeekState({ stored, previous, previousWeekStart = null, ingredients }) {
  if (stored && typeof stored === 'object') return { state: resolveWeekState(stored), created: false };
  const prev = resolveWeekState(previous);
  const stock = {};
  for (const id of Object.keys(prev.stock)) if (ingredients.items[id]?.staple === true) stock[id] = true;
  const state = { purchased: {}, stock };
  if (Object.keys(stock).length > 0 && parseDate(previousWeekStart)) state.inheritedFrom = previousWeekStart;
  return { state, created: true };
}

/**
 * 画面用：保存領域（read(key) → 値 or null）から週の状態を読み、無ければ直前の保存済みの週から常備品を引き継ぐ。
 * weekStarts は index.json の週一覧。created=true なら呼び出し側で storageKeys.week(weekStart) に保存すること。
 */
export function loadWeekStateWithCarryOver({ weekStart, weekStarts, read, ingredients }) {
  const stored = read(storageKeys.week(weekStart));
  if (stored && typeof stored === 'object') return initWeekState({ stored, ingredients });
  const earlier = [...new Set(weekStarts)].filter((w) => w < weekStart).sort().reverse();
  for (const w of earlier) {
    const prev = read(storageKeys.week(w));
    if (prev && typeof prev === 'object') return initWeekState({ stored: null, previous: prev, previousWeekStart: w, ingredients });
  }
  return initWeekState({ stored: null, previous: null, ingredients });
}

// ---------- アレルギー ----------
/** 表記ゆれの正規化：NFKC（半角カナ→全角・全角英数→半角）、英字小文字化、カタカナ→ひらがな */
export function normalizeForAllergen(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

const MASK = '〓';
function allKeywords(ac) {
  return [...new Set([...ac.excluded.flatMap((a) => a.keywords), ...(ac.sharedKeywords ?? [])].map(normalizeForAllergen))];
}
function matchedKeywords(text, ac) {
  const norm = normalizeForAllergen(text);
  return allKeywords(ac).filter((k) => norm.includes(k));
}

/**
 * えび・かにの表記を3段階で判定する（見逃し防止を優先）。
 *   mode 'strict'（食材名・原材料情報）：除外処理を一切しない。当たればすべて error。
 *   mode 'name'  （料理名）：明確な副詞（adverbWhitelist）に当たる部分は warning、それ以外は error。
 *   mode 'prose' （調理手順）：明確な副詞は検出なし、ambiguousPatterns（ひらがな）は warning、それ以外は error。
 * 副詞・曖昧パターンの照合は NFKC 後・かな変換前の表記で行うため、カタカナ「カニ」や漢字「蟹」は常に error。
 * 戻り値 { level: 'error'|'warning'|'none', errors: [語], warnings: [該当表記] }
 */
export function classifyAllergenText(text, ac, mode = 'strict') {
  let s = String(text ?? '').normalize('NFKC');
  const warnings = [];
  if (mode === 'name' || mode === 'prose') {
    const words = [...(ac.adverbWhitelist ?? [])].map((w) => w.normalize('NFKC')).sort((a, b) => b.length - a.length);
    for (const w of words) {
      if (!s.includes(w)) continue;
      if (mode === 'name' && matchedKeywords(w, ac).length) warnings.push(w);
      s = s.split(w).join(MASK);
    }
  }
  if (mode === 'prose') {
    for (const p of ac.ambiguousPatterns ?? []) {
      s = s.replace(new RegExp(p, 'g'), (m) => { warnings.push(m); return MASK; });
    }
  }
  const errors = matchedKeywords(s, ac);
  const uniqWarnings = [...new Set(warnings)];
  return { level: errors.length ? 'error' : uniqWarnings.length ? 'warning' : 'none', errors, warnings: uniqWarnings };
}

/** 後方互換：error 相当の語だけを返す（既定は手順＝prose の扱い） */
export function allergenKeywordHits(text, ac, mode = 'prose') {
  return classifyAllergenText(text, ac, mode).errors;
}

/** containsAllergens の1項目が除外アレルゲンに当たるか（id・表示名・キーワード。除外処理なし） */
function matchesExcludedAllergen(value, ac) {
  const v = normalizeForAllergen(value).trim();
  if (!v) return false;
  if (ac.excluded.some((a) => normalizeForAllergen(a.id) === v || normalizeForAllergen(a.label) === v)) return true;
  return classifyAllergenText(value, ac, 'strict').level === 'error';
}

export const LABEL_CHECK_RISKS = ['high', 'medium', 'low'];

/**
 * 食材単位でえび・かにを検査する。料理名で安全とは判断しない（危険側の検出のみ）。
 * 3段階：errors（アレルゲン検出＝検証エラー）／warnings（判定が曖昧＝要確認）／どちらも無ければ
 * status 'none'（登録データ上で検出なし。安全の保証ではない）。
 */
export function checkAllergens({ config, ingredients, week }) {
  const errors = [];
  const warnings = [];
  const labelChecks = [];
  const ac = config.allergens;
  const modes = { ingredientName: 'strict', containsAllergens: 'strict', recipeName: 'name', steps: 'prose', ...(ac.fieldModes ?? {}) };
  const inspect = (text, mode, where) => {
    const r = classifyAllergenText(text, ac, mode);
    if (r.errors.length) errors.push(`${where}に除外アレルゲンの語（${r.errors.join(', ')}）が含まれます`);
    if (r.warnings.length) warnings.push(`${where}に、えび・かにか判別できない表記（${r.warnings.join('、')}）があります。内容を確認してください`);
  };
  const used = new Set();
  for (const bf of Object.values(config.breakfasts)) for (const it of bf.items) used.add(it.ingredient);
  for (const r of Object.values(week.recipes ?? {})) for (const ri of r.ingredients ?? []) used.add(ri.id);
  if (week.days?.some((d) => SLOTS.some((s) => d[s]?.withRice))) used.add(config.rice.ingredientId);

  for (const id of used) {
    const ing = ingredients.items[id];
    if (!ing) continue;
    // 原材料情報は常に strict（副詞の除外をしない）。fieldModes で緩めることは validateConfig で禁止
    const hitIds = (Array.isArray(ing.containsAllergens) ? ing.containsAllergens : []).filter((a) => matchesExcludedAllergen(a, ac));
    if (hitIds.length || ing.allergenStatus === 'contains') {
      errors.push(`食材「${ing.name}」(${id}) は除外アレルゲン（${hitIds.join(', ') || 'contains'}）を含みます`);
    }
    inspect(`${ing.name} ${id}`, modes.ingredientName, `食材「${ing.name}」(${id}) の名称`);
    if (!ALLERGEN_STATUSES.includes(ing.allergenStatus)) {
      errors.push(`食材「${ing.name}」(${id}) の allergenStatus が未設定または不正です（未確認は安全扱いにしません）`);
    }
    if (ing.processed && ing.allergenStatus === 'free') {
      errors.push(`加工食品「${ing.name}」(${id}) は原材料未確認のため allergenStatus を free にできません`);
    }
    if (ing.allergenStatus !== 'free') {
      labelChecks.push({ id, name: ing.name, note: ing.note ?? null, reason: ing.labelCheckReason ?? null, risk: ing.labelCheckRisk ?? null });
    }
  }
  for (const [rid, r] of Object.entries(week.recipes ?? {})) {
    inspect(r.name ?? '', modes.recipeName, `料理「${r.name}」(${rid}) の名称`);
    inspect((r.steps ?? []).join('\n'), modes.steps, `料理「${r.name}」(${rid}) の手順`);
  }
  const rank = (x) => { const i = LABEL_CHECK_RISKS.indexOf(x); return i < 0 ? -1 : i; };
  labelChecks.sort((a, b) => rank(a.risk) - rank(b.risk) || a.name.localeCompare(b.name, 'ja'));
  const status = errors.length ? 'error' : warnings.length ? 'warning' : 'none';
  return { errors, warnings, status, labelChecks };
}

// ---------- データ検証 ----------
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

export function validateIngredients(ingredients) {
  const errors = [];
  const warnings = [];
  const cats = new Set((ingredients.categories ?? []).map((c) => c.id));
  for (const [id, ing] of Object.entries(ingredients.items ?? {})) {
    const where = `食材 ${id}`;
    if (!ing.name) errors.push(`${where}: name がありません`);
    if (!cats.has(ing.category)) errors.push(`${where}: category「${ing.category}」が不正です`);
    if (!ing.unit) errors.push(`${where}: unit がありません`);
    for (const [u, f] of Object.entries(ing.conversions ?? {})) {
      if (!isNum(f) || f <= 0) errors.push(`${where}: conversions.${u} が不正です`);
    }
    if (!ing.excludedFromBudget) {
      const p = ing.purchase;
      if (!p) warnings.push(`${where}: 購入単位・価格が未設定です（予算は未確定扱い）`);
      else {
        if (!isNum(p.size) || p.size <= 0) errors.push(`${where}: purchase.size が不正です`);
        if (!PRICE_STATUSES.includes(p.priceStatus)) errors.push(`${where}: purchase.priceStatus は estimated / unset のいずれか`);
        if (p.priceStatus === 'estimated' && (!isNum(p.priceYen) || p.priceYen < 0)) errors.push(`${where}: 推定価格 priceYen が不正です`);
        if (p.priceStatus === 'unset') warnings.push(`${where}: 価格未設定（予算は未確定扱い）`);
      }
    }
    const n = ing.nutrition;
    if (!n) warnings.push(`${where}: 栄養値が未設定です`);
    else if (!isNum(n.per) || n.per <= 0 || !['kcal', 'protein', 'fat', 'carbs'].every((k) => isNum(n[k]) && n[k] >= 0)) {
      errors.push(`${where}: nutrition が不正です`);
    }
    if (!Array.isArray(ing.containsAllergens)) errors.push(`${where}: containsAllergens（配列）がありません`);
    if (typeof ing.processed !== 'boolean') errors.push(`${where}: processed（true/false）がありません`);
    if (ing.allergenStatus === 'needs_label_check') {
      if (typeof ing.labelCheckReason !== 'string' || !ing.labelCheckReason.trim()) errors.push(`${where}: 原材料確認の理由 labelCheckReason がありません`);
      if (!LABEL_CHECK_RISKS.includes(ing.labelCheckRisk)) errors.push(`${where}: labelCheckRisk は high / medium / low のいずれか`);
    }
    if ('staple' in ing && typeof ing.staple !== 'boolean') errors.push(`${where}: staple は true/false`);
    if (ing.staple === true && !ing.processed) errors.push(`${where}: 生鮮食品（processed: false）は常備品（staple）にできません`);
  }
  return { errors, warnings };
}

export function validateConfig(config, ingredients) {
  const errors = [];
  const items = ingredients.items ?? {};
  if (!isNum(config.budget?.weeklyLimitYen) || config.budget.weeklyLimitYen <= 0) errors.push('config: budget.weeklyLimitYen が不正です');
  const rice = items[config.rice?.ingredientId];
  if (!rice) errors.push('config: rice.ingredientId が食材マスタにありません');
  else if (!rice.excludedFromBudget) errors.push('config: ご飯（米）は excludedFromBudget: true である必要があります');
  const pids = new Set((config.people ?? []).map((p) => p.id));
  for (const [pid, bf] of Object.entries(config.breakfasts ?? {})) {
    if (!pids.has(pid)) errors.push(`config: 朝食の対象者「${pid}」が people にありません`);
    for (const it of bf.items ?? []) {
      const ing = items[it.ingredient];
      if (!ing) { errors.push(`config: 朝食(${pid}) の食材 ${it.ingredient} が食材マスタにありません`); continue; }
      try { toCanonical(ing, it.qty, it.unit); } catch (e) { errors.push(`config: 朝食(${pid}) ${e.message}`); }
      const ed = it.editable;
      if (ed && !(isNum(ed.min) && isNum(ed.max) && ed.min <= it.qty && it.qty <= ed.max)) errors.push(`config: 朝食(${pid}) ${it.key} の変更範囲が不正です`);
    }
  }
  for (const p of config.allergens?.ambiguousPatterns ?? []) {
    try { new RegExp(p, 'g'); } catch { errors.push(`config: allergens.ambiguousPatterns「${p}」が正規表現として不正です`); }
  }
  for (const [k, m] of Object.entries(config.allergens?.fieldModes ?? {})) {
    if (!['strict', 'name', 'prose'].includes(m)) errors.push(`config: allergens.fieldModes.${k} は strict / name / prose のいずれか`);
  }
  for (const k of ['ingredientName', 'containsAllergens']) {
    const m = config.allergens?.fieldModes?.[k];
    if (m && m !== 'strict') errors.push(`config: allergens.fieldModes.${k} は見逃し防止のため strict である必要があります`);
  }
  return { errors, warnings: [] };
}

/**
 * 週データの検証。history は過去の週データ（同じ料理の連続チェック用）。
 */
export function validateWeek({ config, ingredients, week, history = [] }) {
  const errors = [];
  const warnings = [];
  const items = ingredients.items ?? {};
  const start = parseDate(week.weekStart);
  if (!start) errors.push(`week: weekStart「${week.weekStart}」が日付ではありません`);
  else if (start.getUTCDay() !== 1) errors.push(`week: weekStart「${week.weekStart}」が月曜日ではありません`);
  const n = config.rules?.daysPerWeek ?? 7;
  if (!Array.isArray(week.days) || week.days.length !== n) errors.push(`week: days は${n}日分必要です`);
  const recipes = week.recipes ?? {};
  const usedRecipes = new Map();
  (week.days ?? []).forEach((d, i) => {
    if (start && d.date !== addDays(week.weekStart, i)) errors.push(`week: days[${i}].date は ${addDays(week.weekStart, i)} である必要があります`);
    for (const slot of SLOTS) {
      const m = d[slot];
      if (!m || !Array.isArray(m.recipes) || m.recipes.length === 0) { errors.push(`week: ${d.date} ${SLOT_LABELS[slot]} の料理がありません`); continue; }
      if (typeof m.withRice !== 'boolean') errors.push(`week: ${d.date} ${SLOT_LABELS[slot]} の withRice がありません`);
      for (const rid of m.recipes) {
        if (!recipes[rid]) errors.push(`week: ${d.date} ${SLOT_LABELS[slot]} の料理 ${rid} が recipes にありません`);
        usedRecipes.set(rid, (usedRecipes.get(rid) ?? 0) + 1);
      }
    }
  });
  for (const [rid, r] of Object.entries(recipes)) {
    const where = `料理 ${rid}`;
    if (!r.name) errors.push(`${where}: name がありません`);
    if (!['main', 'side', 'soup'].includes(r.kind)) errors.push(`${where}: kind は main / side / soup のいずれか`);
    if (!Array.isArray(r.steps) || r.steps.length === 0) errors.push(`${where}: steps がありません`);
    if (!Array.isArray(r.ingredients) || r.ingredients.length === 0) { errors.push(`${where}: ingredients がありません`); continue; }
    for (const ri of r.ingredients) {
      const ing = items[ri.id];
      if (!ing) { errors.push(`${where}: 食材 ${ri.id} が食材マスタにありません`); continue; }
      try { toCanonical(ing, ri.qty, ri.unit); } catch (e) { errors.push(`${where}: ${e.message}`); }
    }
    if (!usedRecipes.has(rid)) warnings.push(`${where}: どの食事にも使われていません`);
    if (r.kind === 'main' && (usedRecipes.get(rid) ?? 0) > 1) warnings.push(`${where}: 同じ週に${usedRecipes.get(rid)}回登場します`);
  }
  // 過去週との重複（主菜）
  const N = config.rules?.noRepeatWeeks ?? 0;
  const kinds = config.rules?.noRepeatKinds ?? ['main'];
  if (N > 0 && start) {
    const prev = history
      .filter((w) => w.weekStart < week.weekStart)
      .sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1))
      .slice(0, N);
    const norm = (s) => String(s).replace(/\s/g, '');
    const prevNames = new Map();
    for (const w of prev) for (const r of Object.values(w.recipes ?? {})) if (kinds.includes(r.kind)) prevNames.set(norm(r.name), w.weekStart);
    for (const r of Object.values(recipes)) {
      if (kinds.includes(r.kind) && prevNames.has(norm(r.name))) {
        errors.push(`料理「${r.name}」は直近${N}週（${prevNames.get(norm(r.name))}の週）にも登場しています`);
      }
    }
  }
  return { errors, warnings };
}

/** 画面・CLI 共通：全データを検証し、週の計算結果を返す */
export function buildPlan({ config, ingredients, week, settings, weekState, history = [] }) {
  const s = settings ?? defaultSettings(config);
  const vi = validateIngredients(ingredients);
  const vc = validateConfig(config, ingredients);
  const vw = validateWeek({ config, ingredients, week, history });
  const allergen = checkAllergens({ config, ingredients, week });
  const errors = [...vi.errors, ...vc.errors, ...vw.errors, ...allergen.errors];
  const warnings = [...allergen.warnings.map((w) => `【アレルギー要確認】${w}`), ...vi.warnings, ...vc.warnings, ...vw.warnings];
  if (vi.errors.length || vc.errors.length || vw.errors.length) {
    return { ok: false, errors, warnings, allergen };
  }
  const usages = expandWeek({ config, ingredients, week, settings: s });
  const shopping = aggregateShopping(usages, ingredients, weekState);
  const budget = computeBudget(shopping, config);
  const nutrition = summarizeNutrition(usages, ingredients, config);
  for (const id of nutrition.missing) warnings.push(`食材 ${id}: 栄養値がないため栄養計算から除外されています`);
  return { ok: errors.length === 0, errors, warnings, allergen, usages, shopping, budget, nutrition, settings: s };
}
