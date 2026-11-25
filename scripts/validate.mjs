// 献立データの検証 CLI（依存なし）。GitHub Actions・手元の両方で使う。
//   node scripts/validate.mjs                 … index.json に載っている全週を検証
//   node scripts/validate.mjs --file <path>   … 未登録の週データ（更新候補）を追加で検証
// 終了コード: 0 = 問題なし / 1 = エラーあり
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../meals/lib/plan-core.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA = join(ROOT, 'data', 'meals');

async function readJSON(path) {
  const text = await readFile(path, 'utf8');
  try { return JSON.parse(text); } catch (e) { throw new Error(`${path}: JSONとして読み込めません (${e.message})`); }
}

/** 予算ゲート：常備品（調味料・ジャムなど）が在庫にある「通常週」でも上限を超える週はエラー */
export function budgetGate(budget, config) {
  const errors = [];
  const warnings = [];
  const limit = config.budget.weeklyLimitYen;
  const { initial, regular } = budget;
  if (regular.known > limit) errors.push(`通常週（常備品は在庫あり）の概算でも予算超過です（${core.formatYen(regular.known)} > ${core.formatYen(limit)}）`);
  if (regular.unset.length) warnings.push(`価格未設定の食材があります：${regular.unset.join('、')}（予算は未確定）`);
  if (initial.known > limit) warnings.push(`初回購入（常備品も全て購入）は ${core.formatYen(initial.known)} で予算超過です（在庫の常備品は画面で「在庫あり」にしてください）`);
  return { errors, warnings };
}

export async function validateAll({ extraFiles = [] } = {}) {
  const errors = [];
  const warnings = [];
  const config = await readJSON(join(DATA, 'config.json'));
  const ingredients = await readJSON(join(DATA, 'ingredients.json'));
  const index = await readJSON(join(DATA, 'index.json'));

  const weeks = [];
  const seen = new Set();
  for (const w of index.weeks ?? []) {
    if (seen.has(w.weekStart)) errors.push(`index.json: ${w.weekStart} が重複しています`);
    seen.add(w.weekStart);
    const p = join(DATA, w.file);
    if (!existsSync(p)) { errors.push(`index.json: ${w.file} が存在しません`); continue; }
    const doc = await readJSON(p);
    if (doc.weekStart !== w.weekStart) errors.push(`index.json: ${w.file} の weekStart（${doc.weekStart}）が一覧（${w.weekStart}）と一致しません`);
    weeks.push({ label: w.file, doc });
  }
  if (!seen.has(index.current)) errors.push(`index.json: current（${index.current}）が weeks にありません`);
  for (const f of extraFiles) weeks.push({ label: f, doc: await readJSON(resolve(f)) });

  const allDocs = weeks.map((w) => w.doc);
  const reports = [];
  for (const { label, doc } of weeks) {
    const history = allDocs.filter((d) => d !== doc);
    const plan = core.buildPlan({ config, ingredients, week: doc, history });
    const gate = plan.budget ? budgetGate(plan.budget, config) : { errors: [], warnings: [] };
    const e = [...plan.errors, ...gate.errors];
    const w = [...plan.warnings, ...gate.warnings];
    errors.push(...e.map((m) => `[${label}] ${m}`));
    warnings.push(...w.map((m) => `[${label}] ${m}`));
    reports.push({ label, plan });
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)], reports, config };
}

async function main() {
  const args = process.argv.slice(2);
  const extraFiles = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--file') extraFiles.push(args[++i]);
  const { errors, warnings, reports, config } = await validateAll({ extraFiles });
  for (const { label, plan } of reports) {
    if (!plan.budget) { console.log(`■ ${label}: 計算できません`); continue; }
    const b = plan.budget;
    console.log(`■ ${label}`);
    console.log(`  概算 初回購入 ${core.formatYen(b.initial.known)}${b.initial.determined ? '' : '（未確定）'} / 通常週 ${core.formatYen(b.regular.known)}${b.regular.determined ? '' : '（未確定）'} / 上限 ${core.formatYen(config.budget.weeklyLimitYen)}`);
    for (const p of config.people) {
      const n = plan.nutrition.weekAvg[p.id];
      console.log(`  ${p.label} 1日平均（目安） ${Math.round(n.kcal)}kcal P${core.round(n.protein)} F${core.round(n.fat)} C${core.round(n.carbs)}`);
    }
    console.log(`  原材料確認が必要な食材 ${plan.allergen.labelChecks.length}品`);
  }
  for (const w of warnings) console.log(`WARN  ${w}`);
  for (const e of errors) console.log(`ERROR ${e}`);
  console.log(errors.length ? `検証失敗：エラー ${errors.length}件` : `検証OK（警告 ${warnings.length}件）`);
  process.exitCode = errors.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`ERROR ${e.message}`); process.exitCode = 1; });
}
