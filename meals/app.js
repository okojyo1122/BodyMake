// 週間献立ページの表示・操作。計算はすべて lib/plan-core.js（決定的ロジック）で行う。
// APIキー等の秘密情報はこのファイル・データに置かない（静的サイトのため誰でも閲覧可能）。
import * as core from './lib/plan-core.js';

const DATA_BASE = '../data/meals/';

// ---------- LocalStorage（使えない環境でも動作は継続） ----------
const storage = {
  get(key) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
};

const state = {
  config: null, ingredients: null, index: null,
  week: null, history: [], settings: null, weekState: null, plan: null,
  storageOk: true,
};

// ---------- DOM ヘルパー（データは textContent で挿入し、HTMLとして解釈しない） ----------
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'value') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);
const yen = core.formatYen;
const n0 = (v) => Math.round(v).toLocaleString('ja-JP');

async function loadJSON(path) {
  const res = await fetch(DATA_BASE + path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path} を読み込めませんでした（HTTP ${res.status}）`);
  return res.json();
}

// ---------- 初期化 ----------
async function init() {
  try {
    const [config, ingredients, index] = await Promise.all([
      loadJSON('config.json'), loadJSON('ingredients.json'), loadJSON('index.json'),
    ]);
    Object.assign(state, { config, ingredients, index });
    state.settings = core.resolveSettings(config, storage.get(core.storageKeys.settings));
    $('hdr-limit').textContent = yen(config.budget.weeklyLimitYen);
    $('allergen-notice').replaceChildren(h('strong', null, config.allergens.notice));

    const sel = $('week-select');
    const weeks = [...index.weeks].sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1));
    for (const w of weeks) {
      const end = core.addDays(w.weekStart, 6);
      sel.append(h('option', { value: w.weekStart }, `${core.formatDateJa(w.weekStart)}〜${core.formatDateJa(end)}${w.weekStart === index.current ? '（今週分）' : ''}`));
    }
    const fromUrl = new URLSearchParams(location.search).get('week');
    const initial = weeks.some((w) => w.weekStart === fromUrl) ? fromUrl : index.current;
    sel.value = initial;
    sel.addEventListener('change', () => loadWeek(sel.value).catch(showFatal));

    $('clear-purchased').addEventListener('click', () => { state.weekState.purchased = {}; saveWeekState(); rerender(); });
    $('clear-stock').addEventListener('click', () => { state.weekState.stock = {}; saveWeekState(); rerender(); });
    $('stock-staples').addEventListener('click', () => {
      for (const [id, ing] of Object.entries(state.ingredients.items)) if (ing.staple) state.weekState.stock[id] = true;
      saveWeekState(); rerender();
    });

    renderSettings();
    await loadWeek(initial);
  } catch (e) {
    showFatal(e);
  }
}

async function loadWeek(weekStart) {
  const entry = state.index.weeks.find((w) => w.weekStart === weekStart);
  if (!entry) throw new Error(`週 ${weekStart} が index.json にありません`);
  state.week = await loadJSON(entry.file);
  // 過去週（同じ料理の連続チェック用）
  const n = state.config.rules?.noRepeatWeeks ?? 0;
  const prev = state.index.weeks
    .filter((w) => w.weekStart < weekStart)
    .sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1))
    .slice(0, n);
  const loaded = await Promise.allSettled(prev.map((w) => loadJSON(w.file)));
  state.history = loaded.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  // 保存済みならそのまま使い、未保存（その週の初回表示）なら前の週から常備品の在庫ありだけを引き継いで保存する
  const ws = core.loadWeekStateWithCarryOver({
    weekStart, weekStarts: state.index.weeks.map((w) => w.weekStart),
    read: (k) => storage.get(k), ingredients: state.ingredients,
  });
  state.weekState = ws.state;
  if (ws.created) saveWeekState();
  rerender();
}

function saveSettings() {
  state.storageOk = storage.set(core.storageKeys.settings, state.settings);
}
function saveWeekState() {
  state.storageOk = storage.set(core.storageKeys.week(state.week.weekStart), state.weekState);
}

function rerender() {
  const focusId = document.activeElement?.id;
  state.plan = core.buildPlan({
    config: state.config, ingredients: state.ingredients, week: state.week,
    settings: state.settings, weekState: state.weekState, history: state.history,
  });
  renderStatus();
  if (state.plan.shopping) {
    renderBudget();
    renderPlan();
    renderShopping();
  } else {
    for (const id of ['budget-body', 'plan-body', 'shopping-body']) $(id).replaceChildren(h('p', { class: 'muted' }, 'データにエラーがあるため表示できません。'));
  }
  renderAllergenStatus();
  renderLabelChecks();
  if (focusId) $(focusId)?.focus();
}

function showFatal(e) {
  console.error(e);
  $('status').replaceChildren(h('div', { class: 'alert error' },
    h('strong', null, '献立データを読み込めませんでした。'), h('div', null, e.message),
    location.protocol === 'file:' ? h('div', null, 'ファイルを直接開くと読み込めません。`npm run serve` などでローカルサーバーから開いてください。') : null));
}

// ---------- ステータス（データ検証結果） ----------
function renderStatus() {
  const { errors, warnings } = state.plan;
  const parts = [];
  if (errors.length) parts.push(h('div', { class: 'alert error' }, h('strong', null, 'データ検証エラー（この献立は使用前に修正が必要です）'), h('ul', null, errors.map((e) => h('li', null, e)))));
  if (warnings.length) parts.push(h('div', { class: 'alert warn' }, h('strong', null, 'データの注意'), h('ul', null, warnings.map((w) => h('li', null, w)))));
  if (!state.storageOk) parts.push(h('div', { class: 'alert warn' }, 'このブラウザではチェック状態を保存できません（プライベートモード等）。'));
  $('status').replaceChildren(...parts);
}

// ---------- 予算 ----------
const STATUS_TEXT = {
  within: '概算では予算内です',
  near: '予算の上限に近づいています',
  over: '予算を超過しています',
  undetermined: '価格未設定の食材があるため、予算内かどうか確定できません',
};

function renderBudget() {
  const b = state.plan.budget;
  const groups = state.plan.shopping;
  const pct = Math.min(100, (b.plannedKnown / b.limit) * 100);
  const unsetNote = b.plannedUnset.length ? `＋価格未設定 ${b.plannedUnset.length}品` : '';
  const body = [
    h('div', { class: `budget-status ${b.status}` }, STATUS_TEXT[b.status],
      b.status === 'over' ? `（${yen(-b.remaining)} 超過）` : ''),
    h('div', { class: 'budget-grid' },
      stat('週の予算', yen(b.limit)),
      stat('購入予定額（現在の在庫・購入状態に基づく概算）', `${yen(b.plannedKnown)}${unsetNote}`),
      stat('残り予算（概算）', b.plannedUnset.length ? `最大 ${yen(b.remaining)}（未確定）` : yen(b.remaining)),
    ),
    h('div', { class: `meter ${b.status === 'over' ? 'over' : ''}`, role: 'img', 'aria-label': `予算の${Math.round(pct)}%` }, h('span', { style: `width:${pct}%` })),
    h('h3', null, '初回購入と通常週の比較'),
    h('div', { class: 'budget-grid scenarios' },
      scenarioStat('初回購入費用（常備品も含め全て購入）', b.initial, b.limit),
      scenarioStat('通常週の費用（参考値：常備品をすべて保有している場合）', b.regular, b.limit)),
    h('p', { class: 'muted' }, `通常週の費用は、常備品をすべて保有している場合の参考値です（実際の購入予定額は上の「購入予定額」）。常備品：${b.regular.stapleNames.join('、')}。初回・通常週の金額は在庫チェックに関係なく一定で、購入単位（瓶・袋など）で計算しています（使用量に応じた按分はしていません）。`),
    h('table', { class: 'subtotals' },
      h('thead', null, h('tr', null, h('th', null, 'カテゴリ'), h('th', null, '購入予定額（概算）'))),
      h('tbody', null, groups.map((g) => h('tr', null, h('td', null, g.label),
        h('td', { class: 'num' }, `${yen(g.subtotalKnown)}${g.unsetCount ? `＋未設定${g.unsetCount}品` : ''}`))))),
    h('ul', { class: 'muted' },
      h('li', null, `購入予定額は「在庫あり」を除き、購入単位（パック・袋など）に切り上げた推定価格の合計です。`),
      b.stockExcluded.length ? h('li', null, `在庫ありで除外中：${b.stockExcluded.join('、')}`) : null,
      h('li', null, 'お米（ご飯）は実家から届くため予算に含めていません。プロテイン・間食も対象外です。'),
      h('li', null, state.ingredients.priceInfo.basis),
    ),
  ];
  $('budget-body').replaceChildren(...body);
}
const SCENARIO_TEXT = { within: '予算内（概算）', near: '上限に近い（概算）', over: '予算超過（概算）', undetermined: '未確定（価格未設定あり）' };
function scenarioStat(label, sc, limit) {
  const value = sc.determined ? yen(sc.known) : `${yen(sc.known)}＋未設定${sc.unset.length}品`;
  return h('div', { class: `stat scenario ${sc.status}` },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value),
    h('div', { class: 'sub' }, sc.determined
      ? `${SCENARIO_TEXT[sc.status]}／上限との差 ${sc.known > limit ? '−' : ''}${yen(Math.abs(limit - sc.known))}`
      : `${SCENARIO_TEXT.undetermined}：${sc.unset.join('、')}。金額は確定していません`));
}
function stat(label, value) {
  return h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));
}

// ---------- 献立 ----------
function nutriText(n, incomplete) {
  if (!n) return incomplete ? '不完全（栄養値のない食材のみ）' : '—';
  const t = `${n0(n.kcal)}kcal・P${core.round(n.protein)}g・F${core.round(n.fat)}g・C${core.round(n.carbs)}g`;
  return incomplete ? `${t}【不完全：栄養値なしの食材あり・実際より少なめ】` : t;
}
/** 不完全な値は警告色で表示する */
function nutriEl(tag, cls, text, incomplete) {
  return h(tag, { class: incomplete ? `${cls} incomplete`.trim() : cls || null }, text);
}

function renderPlan() {
  const { config, week, ingredients, settings } = state;
  const items = ingredients.items;
  const nut = state.plan.nutrition;
  const people = config.people;
  $('plan-title').textContent = week.title ?? '週間献立';
  $('plan-meta').textContent = `週の購入予定額（概算・在庫ありを除く）：${yen(state.plan.budget.plannedKnown)}${state.plan.budget.plannedUnset.length ? '＋価格未設定あり' : ''}／栄養は1人あたりの目安（${ingredients.nutritionInfo.basis}）`;

  const f = people.reduce((a, p) => a + settings.mainDishFactor[p.id], 0) / people.length;

  const cards = week.days.map((day) => {
    const dn = nut.byDay[day.date] ?? {};
    const bf = h('div', { class: 'meal' },
      h('h4', null, '朝食 ', h('span', { class: 'tag' }, '個別・固定')),
      h('div', { class: 'bf-grid' }, people.map((p) => h('div', null,
        h('div', { class: 'who' }, p.label),
        h('ul', null, core.breakfastItems(config, settings, p.id).map((it) => h('li', null, `${it.label}：${core.formatQty(it.qty, it.unit)}`,
          it.provisional ? [' ', h('span', { class: 'tag warn', title: '仮の初期値です。個別設定で変更できます' }, '仮')] : null))),
        nutriEl('p', 'nutri', `目安 ${nutriText(dn[p.id]?.bySlot.breakfast, dn[p.id]?.bySlotIncomplete?.breakfast)}`, dn[p.id]?.bySlotIncomplete?.breakfast),
      ))));

    const meals = core.SLOTS.map((slot) => {
      const m = day[slot];
      return h('div', { class: 'meal' },
        h('h4', null, `${core.SLOT_LABELS[slot]} `, h('span', { class: 'tag' }, '2人分・共通')),
        m.recipes.map((rid) => recipeView(week.recipes[rid], items, f)),
        m.withRice
          ? h('p', { class: 'rice-line' }, `ご飯：${people.map((p) => `${p.label} ${settings.mealRiceGrams[p.id]}g`).join('・')}`)
          : h('p', { class: 'rice-line muted' }, 'ご飯なし'),
        nutriEl('p', 'nutri', people.map((p) => `${p.label} 目安 ${nutriText(dn[p.id]?.bySlot[slot], dn[p.id]?.bySlotIncomplete?.[slot])}`).join('　/　'),
          people.some((p) => dn[p.id]?.bySlotIncomplete?.[slot])),
      );
    });

    return h('article', { class: 'day-card', 'aria-label': core.formatDateJa(day.date) },
      h('h3', null, h('span', null, core.formatDateJa(day.date))),
      bf, meals,
      h('div', { class: people.some((p) => dn[p.id]?.incomplete) ? 'day-nutri incomplete' : 'day-nutri' }, h('strong', null, '1日の合計（目安）'), h('br'),
        people.map((p, i) => [i ? h('br') : null, `${p.label}：${nutriText(dn[p.id]?.total, dn[p.id]?.incomplete)}`])),
    );
  });

  const avg = h('div', { class: 'card' }, h('h3', null, '1日平均（目安）'),
    h('ul', null, people.map((p) => nutriEl('li', '', `${p.label}：${nutriText(nut.weekAvg[p.id], nut.weekAvgIncomplete?.[p.id])}`, nut.weekAvgIncomplete?.[p.id]))),
    h('p', { class: 'muted' }, '納豆・めかぶのたれ、調理で吸う油の量などにより実際の値は変わります。妻の朝食の「仮」の項目（卵・ソーセージ・ジャム・調理油）は仮の初期値で計算しています。'));

  $('plan-body').replaceChildren(h('div', { class: 'days' }, cards), avg);
}

function recipeView(recipe, items, factor) {
  const kindTag = { main: '主菜', side: '副菜', soup: '汁物' }[recipe.kind] ?? '';
  return h('details', { class: 'recipe' },
    h('summary', null, recipe.name, ' ', h('span', { class: 'tag est' }, kindTag)),
    h('div', { class: 'recipe-cols' },
      h('div', null, h('strong', null, '材料（2人分）'),
        h('ul', null, recipe.ingredients.map((ri) => {
          const qty = ri.main ? ri.qty * factor : ri.qty;
          return h('li', null, `${items[ri.id]?.name ?? ri.id}：${core.formatQty(qty, ri.unit)}`,
            ri.main && factor !== 1 ? h('span', { class: 'scaled' }, `（主菜倍率×${core.round(factor, 2)}）`) : null);
        }))),
      h('div', null, h('strong', null, '作り方'), h('ol', null, recipe.steps.map((s) => h('li', null, s))))));
}

// ---------- 買い物リスト ----------
function renderShopping() {
  const unitLabel = (v, unit) => `${core.formatNumber(v)}${unit}`;
  const sections = state.plan.shopping.map((g) => h('div', null,
    h('div', { class: 'shop-cat' }, h('h3', null, g.label),
      h('span', { class: 'muted' }, `小計（概算）${yen(g.subtotalKnown)}${g.unsetCount ? `＋未設定${g.unsetCount}品` : ''}`)),
    h('ul', { class: 'shop-list' }, g.items.map((it) => shopItem(it, unitLabel)))));
  const inherited = state.weekState.inheritedFrom
    ? h('p', { class: 'alert info' }, `常備品の「在庫あり」を ${core.formatDateJa(state.weekState.inheritedFrom)} からの週より引き継ぎました（この週を初めて表示したときのみ）。生鮮食品の在庫と購入済みは引き継いでいません。`)
    : null;
  $('shopping-body').replaceChildren(...[inherited, ...sections].filter(Boolean));
}

function shopItem(it, unitLabel) {
  const riceRatio = state.config.rice.cookedToRawRatio;
  const isRice = it.id === state.config.rice.ingredientId;
  let price;
  if (it.excluded) price = h('span', { class: 'tag' }, '予算対象外');
  else if (it.cost == null) price = h('span', { class: 'tag warn' }, '価格未設定');
  else price = [yen(it.cost), h('br'), h('span', { class: 'tag est' }, '推定・概算')];

  const purchase = it.excluded
    ? (it.excludedReason ?? '予算対象外')
    : it.count == null
      ? '購入単位未設定'
      : `${it.count} × ${it.purchaseLabel}${it.leftover > 0 ? `（余り約${unitLabel(it.leftover, it.unit)}）` : ''}`;

  const cls = ['shop-item', it.purchased ? 'purchased' : '', it.inStock ? 'in-stock' : ''].join(' ');
  return h('li', { class: cls },
    h('div', { class: 'name-col' },
      h('div', { class: 'name' }, it.name, ' ', it.staple ? h('span', { class: 'tag est' }, '常備品') : null, ' ', it.needsLabelCheck ? h('span', { class: 'tag warn' }, '原材料確認') : null),
      h('div', { class: 'detail' },
        h('span', null, `必要量：${unitLabel(it.need, it.unit)}`, isRice ? `（生米 約${n0(it.need * riceRatio)}g）` : ''),
        h('span', null, `購入目安：${purchase}`),
        it.unitPrice != null && !it.excluded ? h('span', { class: 'muted' }, `単価目安 ${yen(it.unitPrice)}`) : null),
      h('div', { class: 'src' }, `使用：${it.sources.join('、')}`),
      it.note ? h('div', { class: 'src' }, `※${it.note}`) : null),
    h('div', { class: 'price' }, price),
    h('div', { class: 'checks' },
      h('label', null, h('input', { type: 'checkbox', id: `buy-${it.id}`, checked: it.purchased, onchange: (e) => toggle('purchased', it.id, e.target.checked) }), '購入済み'),
      it.excluded ? null : h('label', null, h('input', { type: 'checkbox', id: `stock-${it.id}`, checked: it.inStock, onchange: (e) => toggle('stock', it.id, e.target.checked) }), '在庫あり（購入しない）')));
}

function toggle(kind, id, on) {
  if (on) state.weekState[kind][id] = true;
  else delete state.weekState[kind][id];
  saveWeekState();
  rerender();
}

/** えび・かにの3段階判定（検出／要確認／検出なし）。検出なしでも安全を保証する表現はしない */
function renderAllergenStatus() {
  const a = state.plan.allergen;
  const text = {
    error: ['tag danger', 'アレルゲン検出', `えび・かにを表す表記が ${a.errors.length}件 見つかりました。この献立は使用前に修正が必要です（上部のデータ検証エラーを参照）。`],
    warning: ['tag warn', '要確認', `えび・かにか判別できない表記が ${a.warnings.length}件 あります。上部の「データの注意」で内容を確認してください。`],
    none: ['tag est', '登録データ上で検出なし', '食材名・原材料情報・料理名・手順の登録データに、えび・かにの表記は見つかりませんでした。これは安全を保証するものではありません。'],
  }[a.status];
  $('allergen-status').replaceChildren('えび・かにの判定：', h('span', { class: text[0] }, text[1]), ' ', text[2]);
}

function renderLabelChecks() {
  const list = state.plan.allergen.labelChecks;
  const levels = state.ingredients.labelCheckRiskInfo?.levels ?? {};
  const cls = { high: 'danger', medium: 'warn', low: 'est' };
  $('label-risk-note').textContent = state.ingredients.labelCheckRiskInfo?.note ?? '';
  $('label-body').replaceChildren(...list.map((l) => h('li', null,
    h('span', { class: 'label-name' }, l.name), ' ',
    h('span', { class: `tag ${cls[l.risk] ?? 'warn'}` }, levels[l.risk] ?? '確認優先度：未設定'),
    h('div', { class: 'label-reason' }, `理由：${l.reason ?? '未設定（購入前に必ず確認）'}`),
    l.note ? h('div', { class: 'muted' }, `※${l.note}`) : null)));
}

// ---------- 個別設定 ----------
function renderSettings() {
  const { config } = state;
  const lim = config.settingsLimits;
  const s = state.settings;
  const num = (id, label, value, l, onChange, suffix) => h('label', null, label,
    h('input', { type: 'number', id, inputmode: 'decimal', min: l.min, max: l.max, step: l.step, value: String(value),
      onchange: (e) => { onChange(e.target.value); } }),
    h('span', { class: 'muted' }, `${l.min}〜${l.max}${suffix}`));

  const apply = (mutate) => {
    const focusId = document.activeElement?.id;
    const next = structuredClone(state.settings);
    mutate(next);
    state.settings = core.resolveSettings(config, next);
    saveSettings();
    renderSettings();
    rerender();
    if (focusId) $(focusId)?.focus();
  };

  const fsRice = h('fieldset', null, h('legend', null, '昼食・夕食のご飯（1食あたり）'),
    h('div', { class: 'field-row' }, config.people.map((p) =>
      num(`rice-${p.id}`, `${p.label}（g）`, s.mealRiceGrams[p.id], lim.mealRiceGrams, (v) => apply((n) => { n.mealRiceGrams[p.id] = v; }), 'g'))));
  const fsMain = h('fieldset', null, h('legend', null, '主菜の量（倍率）'),
    h('p', { class: 'muted' }, '1.0 = レシピの2人分を半分ずつ。主菜の肉・魚などの量に反映され、買い物リストも増減します。'),
    h('div', { class: 'field-row' }, config.people.map((p) =>
      num(`main-${p.id}`, `${p.label}（倍）`, s.mainDishFactor[p.id], lim.mainDishFactor, (v) => apply((n) => { n.mainDishFactor[p.id] = v; }), '倍'))));
  const bfFields = Object.entries(config.breakfasts).flatMap(([pid, bf]) => bf.items.filter((it) => it.editable).map((it) => {
    const person = config.people.find((p) => p.id === pid);
    return num(`bf-${pid}-${it.key}`, `${person?.label ?? pid}：${it.label}（${it.unit}）${it.provisional ? `※仮（初期値 ${core.formatQty(it.qty, it.unit)}）` : ''}`,
      s.breakfastQty[pid][it.key], it.editable, (v) => apply((n) => { n.breakfastQty[pid][it.key] = v; }), it.unit);
  }));
  const fsBf = h('fieldset', null, h('legend', null, '朝食の数量'), h('div', { class: 'field-row' }, bfFields));
  const actions = h('div', { class: 'form-actions' },
    h('button', { type: 'button', onclick: () => apply((n) => Object.assign(n, core.defaultSettings(config))) }, '初期値に戻す'),
    h('span', { class: 'muted' }, `初期値：ご飯 ${config.people.map((p) => `${p.label}${config.defaults.mealRiceGrams[p.id]}g`).join('・')}／主菜倍率 1.0`));
  $('settings-form').replaceChildren(fsRice, fsMain, fsBf, actions);
}

init();
