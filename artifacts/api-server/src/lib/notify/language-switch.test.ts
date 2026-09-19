/**
 * Language switching tests.
 *
 * The point of /language is that a change takes effect WITHOUT a restart. That
 * means the resolution order must be exercisable at runtime, not baked in at
 * boot — so these tests drive it the same way the bot does: pick a language,
 * resolve it, render a message, then confirm the rendered text actually changed.
 *
 * Also covers precedence, because a chat command appearing to succeed while an
 * environment variable silently overrides it is the failure mode worth catching.
 */
import {
  resolveLanguage,
  normaliseLanguage,
  LANGUAGE_OVERRIDE_KEY,
  type Language,
} from "./i18n.js";
import { formatApproaching } from "./formatters.js";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ FAIL: ${label}`); }
}

/** Simulates the key-value store the bot writes to. */
function fakeStore(initial: string | null = null) {
  let value = initial;
  return {
    read: () => value,
    write: (v: string) => { value = v; },
    key: LANGUAGE_OVERRIDE_KEY,
  };
}

const alert = {
  symbol: "BTCUSDT", timeframe: "4h", side: "BSL" as const, level: 81435.09,
  currentPrice: 81181.8, distancePct: 0.31, source: "2 次觸及｜london",
};

console.log("─".repeat(60));
console.log("優先序：環境變數 > 使用者設定 > config");

{
  delete process.env.NOTIFICATION_LANGUAGE;
  const store = fakeStore(null);

  const a = resolveLanguage("zh-TW", store.read);
  ok(a.language === "zh-TW" && a.source === "config", "沒人設定時 → 用 config 預設");

  store.write("en");
  const b = resolveLanguage("zh-TW", store.read);
  ok(b.language === "en" && b.source === "user", "使用者用 /language 設定後 → 蓋過 config");

  process.env.NOTIFICATION_LANGUAGE = "zh-CN";
  const c = resolveLanguage("zh-TW", store.read);
  ok(c.language === "zh-CN" && c.source === "env", "環境變數 → 蓋過使用者設定");

  // 使用者設定仍保留在 store 中，環境變數移除後應恢復
  delete process.env.NOTIFICATION_LANGUAGE;
  const d = resolveLanguage("zh-TW", store.read);
  ok(d.language === "en" && d.source === "user", "環境變數移除後 → 回到使用者設定");
}

console.log("─".repeat(60));
console.log("壞值不會覆蓋成預設（避免靜默降級）");

{
  delete process.env.NOTIFICATION_LANGUAGE;
  const store = fakeStore("klingon");
  const r = resolveLanguage("zh-TW", store.read);
  ok(r.language === "zh-TW" && r.source === "config", "store 內是壞值 → 退回 config，不是 crash");

  process.env.NOTIFICATION_LANGUAGE = "not-a-language";
  const r2 = resolveLanguage("zh-TW", store.read);
  ok(r2.language === "zh-TW" && r2.source === "config", "環境變數是壞值 → 退回下一層");
  delete process.env.NOTIFICATION_LANGUAGE;
}

console.log("─".repeat(60));
console.log("切換後訊息真的改變（不需重啟）");

{
  delete process.env.NOTIFICATION_LANGUAGE;
  const store = fakeStore(null);
  const configLang: Language = "zh-TW";

  const before = formatApproaching(alert, resolveLanguage(configLang, store.read).language);
  ok(before.includes("【流動性接近】"), "切換前：繁中");
  ok(before.includes("買方流動性"), "切換前：繁中用「買方流動性」");

  // 模擬使用者下 /language zh-CN
  store.write("zh-CN");
  const afterCn = formatApproaching(alert, resolveLanguage(configLang, store.read).language);
  ok(afterCn.includes("【流动性接近】"), "切換後：簡中標題");
  ok(afterCn.includes("买方流动性"), "切換後：簡中用「买方流动性」");
  ok(!afterCn.includes("流動性接近"), "切換後：不再出現繁中字樣");

  // 再切英文
  store.write("en");
  const afterEn = formatApproaching(alert, resolveLanguage(configLang, store.read).language);
  ok(afterEn.includes("[Liquidity Approaching]"), "再切換：英文標題");
  ok(afterEn.includes("Buy-Side Liquidity (BSL)"), "再切換：英文用 Buy-Side Liquidity");
  ok(!afterEn.includes("流動性"), "再切換：不再出現中文");

  // 三種語言的實際輸出都不一樣
  ok(before !== afterCn && afterCn !== afterEn && before !== afterEn,
    "三種語言產出三種不同訊息");
}

console.log("─".repeat(60));
console.log("環境變數釘住時，切換必須誠實告知不生效");

{
  process.env.NOTIFICATION_LANGUAGE = "en";
  const store = fakeStore(null);
  store.write("zh-CN");
  const r = resolveLanguage("zh-TW", store.read);
  ok(r.language === "en" && r.source === "env",
    "環境變數優先：使用者切換被覆蓋（bot 會據此提示使用者）");
  delete process.env.NOTIFICATION_LANGUAGE;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
