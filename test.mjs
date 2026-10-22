// 写経道場の小さなテスト。依存なし: `node test.mjs`
// 各 HTML の <script> を、最小限の偽 DOM の上で動かして確かめる。
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const PAGES = ["index.html", "ts.html", "py.html"];
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log("ok   " + name); }
  catch (e) { failed++; console.log("FAIL " + name + "\n     " + (e.stack || e).toString().split("\n").slice(0, 3).join("\n     ")); }
}

/* ---- 偽 DOM ---- */
function fakeEl(tag) {
  const cls = new Set();
  return {
    tag, textContent: "", className: "", style: {}, srcdoc: "", children: [], handlers: {},
    set innerHTML(v) { this._html = v; this.children = []; }, get innerHTML() { return this._html || ""; },
    classList: { add: (...a) => a.forEach(x => cls.add(x)), remove: (...a) => a.forEach(x => cls.delete(x)),
      toggle: (x, f) => (f ? cls.add(x) : cls.delete(x)), contains: x => cls.has(x) },
    focus() {}, querySelector() { return null },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, f) { this.handlers[t] = f; },
    get text() { return this.textContent + this.children.map(c => c.text ?? c.textContent).join(""); },
  };
}

function boot(file, { store = {}, storage, globals = {} } = {}) {
  const html = fs.readFileSync(new URL(file, import.meta.url), "utf8");
  const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const els = {};
  const document = {
    getElementById: id => (els[id] ??= fakeEl("#" + id)),
    createElement: t => fakeEl(t),
    head: fakeEl("head"), body: fakeEl("body"),
  };
  const localStorage = storage || {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  const ctx = vm.createContext({ document, localStorage, setTimeout: () => 0, console, Date, ...globals });
  const expose = ["model", "pos", "completed", "LESSONS", "load", "L"]
    .concat(src.includes("function stripTypes") ? ["stripTypes"] : [])
    .concat(src.includes("bootState") ? ["bootState", "run"] : []);
  vm.runInContext(src + "\n;globalThis.__t = {" + expose.map(k => `get ${k}(){ return ${k}; }`).join(",") + "};", ctx);
  const t = ctx.__t;
  const key = (k, mods = {}) => {
    let prevented = false;
    els.code.handlers.keydown({ key: k, preventDefault() { prevented = true; }, ...mods });
    return prevented;
  };
  // お手本どおりに最後まで打つ（自動で進む文字は飛ばされている前提）
  const typeAll = () => {
    let n = 0;
    while (t.pos < t.model.length) {
      const c = t.model[t.pos];
      key(c === "\n" ? "Enter" : c);
      if (++n > 10000) throw new Error("終わらない: pos=" + t.pos);
    }
  };
  return { t, els, key, typeAll, store, document, html, ctx };
}

/* ---- 写経の判定 ---- */
for (const page of PAGES) {
  await test(`${page}: 全課題をお手本どおりに打つと完成する`, () => {
    const { t, typeAll } = boot(page);
    for (const les of t.LESSONS) {
      t.load(les);
      typeAll();
      assert.equal(t.completed, true, les.id);
    }
  });

  await test(`${page}: 違う文字では進まない / 改行は Enter で打つ`, () => {
    const { t, key } = boot(page);
    t.load(t.LESSONS[0]);
    const p = t.pos;
    key("\u0000"); key("Tab"); key("ArrowRight");
    assert.equal(t.pos, p);
    // 1行目の最後まで打つと、改行の手前で止まる
    while (t.model[t.pos] !== "\n") key(t.model[t.pos]);
    const nl = t.pos;
    key(" ");
    assert.equal(t.pos, nl, "スペースでは改行を越えない");
    key("Enter");
    assert.ok(t.pos > nl);
    assert.notEqual(t.model[t.pos], " ", "行頭インデントは自動で飛ぶ");
  });

  await test(`${page}: 完成後に Backspace で消しても、また打てる`, () => {
    const { t, key, typeAll, els } = boot(page);
    t.load(t.LESSONS[0]);
    typeAll();
    assert.equal(t.completed, true);
    key("Backspace");
    assert.equal(t.completed, false);
    assert.equal(els.code.classList.contains("completed"), false);
    key(t.model[t.pos]);
    assert.equal(t.completed, true);
  });

  await test(`${page}: Ctrl/Cmd のショートカットは横取りしない、AltGr の記号は受け付ける`, () => {
    const { t, key } = boot(page);
    t.load(t.LESSONS[0]);
    const want = t.model[t.pos];
    assert.equal(key(want, { ctrlKey: true }), false);
    assert.equal(key(want, { metaKey: true }), false);
    const p = t.pos;
    key(want, { ctrlKey: true, altKey: true }); // Windows の AltGr
    assert.equal(t.pos > p, true);
  });

  await test(`${page}: 課題チップのタイトルは文字として表示される`, () => {
    const { t, els } = boot(page);
    const chips = els.chips.children.map(c => c.text);
    for (const les of t.LESSONS) assert.ok(chips.some(c => c.startsWith(les.title)), les.title);
  });

  await test(`${page}: localStorage が壊れていても・使えなくても起動して進捗を扱える`, () => {
    for (const bad of ["{oops", "null", "123"]) {
      const store = {};
      const b0 = boot(page, { store });
      const saveKey = () => Object.keys(store)[0];
      b0.typeAll(); // 保存キーを知るために一度完成させる
      const k = saveKey();
      assert.ok(k, "完成すると保存される");
      assert.deepEqual(JSON.parse(store[k]), { [b0.t.LESSONS[0].id]: true });
      const b = boot(page, { store: { [k]: bad } });
      b.typeAll();
      assert.equal(b.t.completed, true, bad);
    }
    const throwing = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceeded"); } };
    const b = boot(page, { storage: throwing });
    b.typeAll();
    assert.equal(b.t.completed, true);
  });
}

/* ---- JS / TS: 実行用 iframe ---- */
for (const page of ["index.html", "ts.html"]) {
  await test(`${page}: 実行用 iframe は sandbox されている（README の記述どおり）`, () => {
    const { html } = boot(page);
    assert.match(html, /<iframe id="frame" sandbox="allow-scripts"/);
  });
}

/* ---- TS: 型除去の結果が JS として動く ---- */
await test("ts.html: 全課題の stripTypes() 結果が実行でき、期待どおりの表示になる", () => {
  const { t } = boot("ts.html");
  const expected = {
    greet: "こんにちは、写経人さん",
    point: "",
    mood: "アゲ ↑",
    generic: "写経 / 7",
    enum: "日ようび月ようび火ようび水ようび木ようび金ようび土ようび",
  };
  for (const les of t.LESSONS) {
    const js = t.stripTypes(les.code);
    assert.doesNotMatch(js, /\binterface\b|\bas [A-Z]|: (string|number|void|Mood|Point)\b|<T>/, les.id);
    const app = fakeEl("#app");
    const document = {
      body: { style: {} },
      getElementById: id => (id === "app" ? app : { width: 320, height: 240, getContext: () => ({ arc() {}, fill() {}, beginPath() {} }) }),
      createElement: t => fakeEl(t),
    };
    vm.runInNewContext(js, { document });
    assert.equal(app.text, expected[les.id], les.id);
  }
});

/* ---- Python: 起動に失敗しても、次の実行で起動をやり直す ---- */
await test("py.html: Pyodide の起動に失敗しても「起動中…」で止まらず再挑戦する", async () => {
  let calls = 0;
  const fakePy = { version: "0", setStdout(o) { this.out = o; }, setStderr() {}, runPython() { this.out.batched("hi"); } };
  const { t, els, document, typeAll, ctx } = boot("py.html");
  const sc = document.head.children[0];          // 起動時の先読みで差し込まれた <script>
  assert.ok(sc && sc.src.includes("pyodide"));
  ctx.loadPyodide = async () => { if (++calls === 1) throw new Error("boom"); return fakePy; }; // <script> が読み込まれた体
  await sc.onload();                               // 1回目: loadPyodide が失敗
  assert.equal(t.bootState, "idle");
  typeAll();                                       // 完成 → run() → 起動をやり直す
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 2);
  assert.equal(t.bootState, "ready");
  assert.equal(els.out.textContent, "hi");
});

console.log(failed ? `\n${failed} 件失敗` : "\nすべて成功");
process.exit(failed ? 1 : 0);
