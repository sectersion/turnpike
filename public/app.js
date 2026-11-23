import { barList, card, fmtDay, fmtHour, fmtNum, fmtTipTime, fmtUsd, lineChart, sparkline, tableView } from "./charts.js";
// Vanilla dashboard. All API data goes in via textContent / value, never as markup.
const TOKEN_KEY = "turnpike_admin_token";
const KINDS = ["openrouter", "opencode-zen", "opencode-go", "custom-openai", "custom-anthropic", "copilot-oauth"];
const CUSTOM = ["custom-openai", "custom-anthropic"];
const SUBSCRIPTION = ["copilot-oauth", "codex-oauth"];
const app = document.getElementById("app");
const signout = document.getElementById("signout");
const nav = document.getElementById("nav");
const side = document.getElementById("side");

const getToken = () => { try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } };
const setToken = (t) => { try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch {} };

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "value" || k === "checked" || k === "disabled") e[k] = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
  return e;
}
const field = (label, input) => h("label", {}, label, input);
const err = () => h("p", { class: "err", role: "alert" });
const showErr = (el, e) => { el.className = "err"; el.textContent = e ? (e.message || String(e)) : ""; };
const showOk = (el, msg) => { el.className = "muted"; el.textContent = msg; };

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${getToken()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { setToken(""); showLogin("Admin token rejected."); throw new Error("unauthorized"); }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const m = data?.error?.message ?? (typeof data?.error === "string" ? data.error : "");
    throw new Error(m || `${res.status} ${res.statusText}`);
  }
  return { status: res.status, data };
}
const get = async (p) => (await api("GET", p)).data;

function table(heads, rows, numCols = []) {
  return h("div", { class: "scroll" }, h("table", {},
    h("thead", {}, h("tr", {}, heads.map((t, i) => h("th", { scope: "col", class: numCols.includes(i) ? "num" : "" }, t)))),
    h("tbody", {}, rows)));
}
const row = (cells, numCols = []) => h("tr", {}, cells.map((c, i) => h("td", { class: numCols.includes(i) ? "num" : "" }, c)));
const usd = (n) => `$${(n ?? 0).toFixed(4)}`;
const lim = (n) => (n == null ? "none" : String(n));

// ---------- login ----------
function showLogin(msg = "") {
  signout.hidden = true;
  side.hidden = true;
  app.className = "center";
  stopPoll();
  const e = err();
  e.textContent = msg;
  const input = h("input", { id: "tok", type: "password", autocomplete: "off", required: true });
  app.replaceChildren(h("div", { class: "login" },
    h("div", { class: "brand" }, h("span", { class: "logo", "aria-hidden": "true" }, "T"), "Turnpike"),
    h("h2", {}, "Admin sign-in"),
    h("form", { onsubmit: (ev) => { ev.preventDefault(); setToken(input.value.trim()); start(); } },
      field("Admin token", input), e, h("button", { class: "primary", type: "submit" }, "Continue"))));
  input.focus();
}
signout.addEventListener("click", () => { setToken(""); showLogin(); });

// ---------- shell ----------
const TABS = { Accounts: accountsTab, Keys: keysTab, Combos: combosTab, Usage: usageTab };
const SUBS = {
  Accounts: "Upstream providers. Models are fetched from each provider automatically.",
  Keys: "Router keys you hand out, with spend caps and account allow-lists.",
  Combos: "Ordered fallback lists. Request a combo by name as the model.",
  Usage: "Requests, tokens and spend per key and per account.",
};
function start() {
  if (!getToken()) return showLogin();
  signout.hidden = false;
  side.hidden = false;
  app.className = "";
  const panel = h("section", { role: "tabpanel" });
  const tabs = nav;
  tabs.replaceChildren();
  const select = (name) => {
    stopPoll();
    for (const b of tabs.children) b.setAttribute("aria-selected", String(b.textContent === name));
    panel.replaceChildren(h("h1", {}, name), h("p", { class: "sub" }, SUBS[name]));
    TABS[name](panel);
  };
  for (const name of Object.keys(TABS)) tabs.append(h("button", { role: "tab", type: "button", onclick: () => select(name) }, name));
  app.replaceChildren(panel);
  select("Accounts");
}

// ---------- accounts ----------
let pollTimer = 0;
const stopPoll = () => { clearTimeout(pollTimer); pollTimer = 0; };

async function accountsTab(root) {
  const e = err();
  const list = h("div");
  const load = async () => {
    try {
      const [accts, models] = await Promise.all([get("/admin/accounts"), get("/admin/models")]);
      const count = {};
      for (const m of models) count[m.accountId] = (count[m.accountId] ?? 0) + 1;
      list.replaceChildren(table(["Name", "Kind", "Enabled", "Models", "RPM", "TPM", "Monthly USD", "Actions"], accts.map((a) => accountRow(a, load, e, count[a.id] ?? 0)), [3]));
      showErr(e, null);
    } catch (x) { showErr(e, x); }
  };
  root.append(e, list, h("h2", {}, "Add account"), addAccountForm(load));
  load();
}

function accountRow(a, reload, e, nModels) {
  const num = (v, label) => h("input", { type: "number", min: "0", step: "any", value: v ?? "", placeholder: "none", "aria-label": `${label} for ${a.name}` });
  const rpm = num(a.rpm, "RPM"), tpm = num(a.tpm, "TPM"), usdI = num(a.monthlyUsd, "Monthly USD");
  const val = (i) => (i.value.trim() === "" ? null : Number(i.value));
  const patch = async (b) => { try { await api("PATCH", `/admin/accounts/${encodeURIComponent(a.id)}`, b); await reload(); } catch (x) { showErr(e, x); } };
  return row([
    a.name, a.kind,
    h("button", { type: "button", "aria-pressed": String(a.enabled), onclick: () => patch({ enabled: !a.enabled }) }, a.enabled ? "Enabled" : "Disabled"),
    h("span", { class: "row" }, String(nModels),
      h("button", { type: "button", class: "ghost", title: "Fetch the model list from the provider", onclick: async () => {
        try { await api("POST", `/admin/accounts/${encodeURIComponent(a.id)}/models/refresh`); await reload(); } catch (x) { showErr(e, x); }
      } }, "Refresh")),
    rpm, tpm, usdI,
    h("span", { class: "row" },
      h("button", { type: "button", onclick: () => patch({ rpm: val(rpm), tpm: val(tpm), monthlyUsd: val(usdI) }) }, "Save limits"),
      h("button", { type: "button", class: "danger", onclick: async () => {
        if (!confirm(`Delete account "${a.name}"?`)) return;
        try { await api("DELETE", `/admin/accounts/${encodeURIComponent(a.id)}`); await reload(); } catch (x) { showErr(e, x); }
      } }, "Delete")),
  ]);
}

function addAccountForm(reload) {
  const kind = h("select", { id: "kind" }, KINDS.map((k) => h("option", { value: k }, k)));
  const e = err();
  const body = h("div");
  const draw = () => {
    stopPoll();
    showErr(e, null);
    if (kind.value === "copilot-oauth") return body.replaceChildren(copilotForm(reload, e));
    const custom = CUSTOM.includes(kind.value);
    const name = h("input", { required: true }), key = h("input", { type: "password", autocomplete: "off", required: !custom });
    const url = h("input", { type: "url", placeholder: "https://", required: custom });
    body.replaceChildren(h("form", { onsubmit: async (ev) => {
      ev.preventDefault();
      const b = { kind: kind.value, name: name.value, authType: "apikey", secret: key.value };
      if (url.value) b.baseUrl = url.value;
      try { await api("POST", "/admin/accounts", b); key.value = ""; name.value = ""; url.value = ""; showErr(e, null); await reload(); } catch (x) { showErr(e, x); }
    } }, field("Name", name), field(custom ? "API key (optional)" : "API key", key),
      field(custom ? "Base URL (required)" : "Base URL (optional)", url), h("button", { class: "primary", type: "submit" }, "Add account")));
  };
  kind.addEventListener("change", draw);
  draw();
  return h("div", {}, h("div", { class: "row" }, field("Kind", kind)), body, e);
}

function copilotForm(reload, e) {
  const name = h("input", { value: "copilot" });
  const out = h("div", { "aria-live": "polite" });
  const btn = h("button", { class: "primary", type: "button" }, "Sign in with GitHub");
  btn.addEventListener("click", async () => {
    stopPoll();
    showErr(e, null);
    try {
      const { data: s } = await api("POST", "/admin/oauth/copilot-oauth/start");
      const link = typeof s.verifyUrl === "string" && s.verifyUrl.startsWith("https://")
        ? h("a", { href: s.verifyUrl, target: "_blank", rel: "noopener noreferrer" }, s.verifyUrl) : h("span", {}, String(s.verifyUrl));
      out.replaceChildren(h("p", {}, "Open ", link, " and enter this code:"), h("p", {}, h("strong", {}, String(s.userCode))), h("p", { class: "muted" }, "Waiting for approval..."));
      const deadline = Date.now() + 10 * 60 * 1000;
      const poll = async () => {
        if (Date.now() > deadline) { out.replaceChildren(); return showErr(e, new Error("Sign-in timed out.")); }
        try {
          const r = await api("POST", "/admin/oauth/copilot-oauth/complete", { state: s.state, name: name.value || "copilot" });
          if (r.status === 202) { pollTimer = setTimeout(poll, 5000); return; }
          out.replaceChildren();
          pollTimer = 0;
          await reload();
        } catch (x) { out.replaceChildren(); showErr(e, x); }
      };
      pollTimer = setTimeout(poll, 5000);
    } catch (x) { showErr(e, x); }
  });
  return h("div", {}, h("div", { class: "row" }, field("Account name", name), btn), out);
}

// ---------- keys ----------
async function keysTab(root) {
  const e = err();
  const list = h("div");
  const secretBox = h("div", { "aria-live": "polite" });
  let accts = [];
  const load = async () => {
    try {
      const keys = await get("/admin/keys");
      const names = Object.fromEntries(accts.map((a) => [a.id, a.name]));
      list.replaceChildren(table(["Name", "Daily USD", "Monthly USD", "RPM", "In flight", "Allowed accounts", "Status", "Actions"], keys.map((k) => row([
        k.name,
        k.dailyUsd == null && k.monthlyUsd == null ? h("span", { class: "badge warn" }, "UNCAPPED") : lim(k.dailyUsd), lim(k.monthlyUsd),
        lim(k.rpm), lim(k.maxInFlight),
        k.allowedAccountIds ? k.allowedAccountIds.map((i) => names[i] ?? i).join(", ") || "none" : "all",
        h("span", { class: k.revoked ? "badge bad" : "badge ok" }, k.revoked ? "Revoked" : "Active"),
        k.revoked ? "" : h("button", { type: "button", class: "danger", onclick: async () => {
          if (!confirm(`Revoke key "${k.name}"? This cannot be undone.`)) return;
          try { await api("DELETE", `/admin/keys/${encodeURIComponent(k.id)}`); await load(); } catch (x) { showErr(e, x); }
        } }, "Revoke"),
      ]))));
      showErr(e, null);
    } catch (x) { showErr(e, x); }
  };
  try { accts = await get("/admin/accounts"); } catch (x) { showErr(e, x); }

  const name = h("input", { required: true });
  const daily = h("input", { type: "number", min: "0", step: "any" });
  const monthly = h("input", { type: "number", min: "0", step: "any" });
  const unlimited = h("input", { type: "checkbox" });
  // Safe defaults; clear a field for no limit.
  const rpmI = h("input", { type: "number", min: "0", step: "1", value: "30", placeholder: "none" });
  const inflight = h("input", { type: "number", min: "0", step: "1", value: "4", placeholder: "none" });
  // Nothing is ticked by default. "All API-key accounts" ticks the current non-subscription accounts;
  // subscription (Copilot) accounts must be ticked one by one. The key gets an explicit list, never "all".
  const all = h("input", { type: "checkbox" });
  const boxes = accts.map((a) => [a, h("input", { type: "checkbox" })]);
  all.addEventListener("change", () => boxes.forEach(([a, b]) => { if (!SUBSCRIPTION.includes(a.kind)) b.checked = all.checked; }));
  const form = h("form", { onsubmit: async (ev) => {
    ev.preventDefault();
    const b = { name: name.value };
    if (daily.value !== "") b.dailyUsd = Number(daily.value);
    if (monthly.value !== "") b.monthlyUsd = Number(monthly.value);
    if (b.dailyUsd === undefined && b.monthlyUsd === undefined && !unlimited.checked)
      return showErr(e, new Error("Set a daily or monthly USD cap, or tick \"No USD cap\"."));
    b.rpm = rpmI.value === "" ? null : Number(rpmI.value);
    b.maxInFlight = inflight.value === "" ? null : Number(inflight.value);
    b.allowedAccountIds = boxes.filter(([, c]) => c.checked).map(([a]) => a.id);
    if (!b.allowedAccountIds.length) return showErr(e, new Error("Tick at least one account."));
    try {
      const { data } = await api("POST", "/admin/keys", b);
      const copy = h("button", { type: "button", onclick: async () => {
        try { await navigator.clipboard.writeText(data.secret); copy.textContent = "Copied"; } catch { copy.textContent = "Copy failed: select the text"; }
      } }, "Copy");
      secretBox.replaceChildren(h("div", { class: "secret", role: "status" },
        h("strong", {}, "New key secret"), h("code", {}, data.secret), copy,
        h("p", {}, "Copy it now. It will not be shown again.")));
      name.value = "";
      daily.value = "";
      monthly.value = "";
      unlimited.checked = false;
      showErr(e, null);
      await load();
    } catch (x) { showErr(e, x); }
  } }, field("Name", name), field("Daily USD cap", daily), field("Monthly USD cap", monthly),
    h("label", { class: "inline" }, unlimited, "No USD cap (unlimited spend)"),
    field("Requests per minute (blank: unlimited)", rpmI), field("Max in flight (blank: unlimited)", inflight),
    h("fieldset", {}, h("legend", {}, "Allowed accounts"),
      h("label", { class: "inline" }, all, "All API-key accounts (not subscriptions)"),
      boxes.map(([a, b]) => h("label", { class: "inline" }, b, SUBSCRIPTION.includes(a.kind) ? `${a.name} (subscription)` : a.name))),
    h("button", { class: "primary", type: "submit" }, "Create key"));
  root.append(e, secretBox, list, h("h2", {}, "Create key"), form);
  load();
}

// ---------- combos ----------
async function combosTab(root) {
  const e = err();
  const box = h("div");
  let accts = [];
  const modelsBy = {};
  const load = async () => {
    try {
      let combos, models;
      [accts, combos, models] = await Promise.all([get("/admin/accounts"), get("/admin/combos"), get("/admin/models")]);
      for (const k of Object.keys(modelsBy)) delete modelsBy[k];
      for (const m of models) (modelsBy[m.accountId] ??= []).push(m.model);
      box.replaceChildren(...combos.map(comboEditor), newCombo());
      showErr(e, null);
    } catch (x) { showErr(e, x); }
  };
  const comboEditor = (c) => {
    const targets = c.targets.map((t) => ({ ...t }));
    const out = h("div");
    const msg = err();
    const draw = () => {
      out.replaceChildren(table(["#", "Account", "Model", "Order"], targets.map((t, i) => {
        const sel = h("select", { "aria-label": `Account for target ${i + 1} of ${c.name}` }, accts.map((a) => h("option", { value: a.id }, a.name)));
        if (!accts.some((a) => a.id === t.accountId)) sel.prepend(h("option", { value: t.accountId }, `(missing) ${t.accountId}`));
        sel.value = t.accountId;
        const dl = h("datalist", { id: `dl-${c.name}-${i}` });
        const fill = () => dl.replaceChildren(...(modelsBy[t.accountId] ?? []).map((m) => h("option", { value: m })));
        fill();
        sel.addEventListener("change", () => { t.accountId = sel.value; fill(); });
        const model = h("input", { value: t.model, list: dl.id, placeholder: "start typing to search models", size: "36", "aria-label": `Model for target ${i + 1} of ${c.name}` });
        model.addEventListener("input", () => { t.model = model.value; });
        const mv = (d) => () => { [targets[i], targets[i + d]] = [targets[i + d], targets[i]]; draw(); };
        return row([String(i + 1), sel, h("span", {}, model, dl), h("span", { class: "row" },
          h("button", { type: "button", disabled: i === 0, onclick: mv(-1), "aria-label": `Move target ${i + 1} up` }, "Up"),
          h("button", { type: "button", disabled: i === targets.length - 1, onclick: mv(1), "aria-label": `Move target ${i + 1} down` }, "Down"),
          h("button", { type: "button", class: "danger", onclick: () => { targets.splice(i, 1); draw(); }, "aria-label": `Remove target ${i + 1}` }, "Remove"))]);
      })));
    };
    draw();
    return h("section", {}, h("h3", {}, c.name), out, msg, h("div", { class: "row" },
      h("button", { type: "button", disabled: !accts.length, onclick: () => { targets.push({ accountId: accts[0].id, model: "" }); draw(); } }, "Add target"),
      h("button", { type: "button", class: "primary", onclick: async () => {
        try {
          if (!targets.length) throw new Error("Add at least one target first.");
          await api("PUT", "/admin/combos", { name: c.name, targets });
          showOk(msg, "Saved.");
        }
        catch (x) { showErr(msg, x); }
      } }, "Save combo")));
  };
  const newCombo = () => {
    const name = h("input", { required: true });
    const m = err();
    return h("form", { onsubmit: async (ev) => {
      ev.preventDefault();
      box.insertBefore(comboEditor({ name: name.value, targets: [] }), ev.target);
      name.value = "";
    } }, h("h2", {}, "New combo"), field("Combo name", name), h("button", { class: "primary", type: "submit" }, "Create combo"), m);
  };
  root.append(e, box);
  load();
}

// ---------- usage ----------
const HOUR = 3_600_000, DAYMS = 86_400_000;
const PERIODS = {
  "Today": { since: () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }, bucket: HOUR },
  "Last 7 days": { since: () => Date.now() - 7 * DAYMS, bucket: DAYMS },
  "Last 30 days": { since: () => Date.now() - 30 * DAYMS, bucket: DAYMS },
  "This month": { since: () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }, bucket: DAYMS },
};
const METRICS = {
  Requests: { f: (r) => r.requests, fmt: fmtNum },
  Tokens: { f: (r) => (r.inTokens ?? 0) + (r.outTokens ?? 0), fmt: fmtNum },
  Spend: { f: (r) => r.costUsd ?? 0, fmt: fmtUsd },
};
// Zero-filled series over [since, end): the API omits empty buckets.
const fill = (rows, since, end, b) => {
  const by = new Map(rows.map((r) => [r.t, r]));
  const out = [];
  for (let t = since; t < end; t += b) out.push(by.get(t) ?? { t, requests: 0, inTokens: 0, outTokens: 0, costUsd: 0 });
  return out;
};
const sum = (a, k) => a.reduce((x, r) => x + (r[k] ?? 0), 0);
const delta = (cur, prev) => (prev > 0 ? `${cur >= prev ? "▲" : "▼"} ${Math.abs(Math.round(((cur - prev) / prev) * 100))}% vs prior period` : cur > 0 ? "new this period" : "no change");

async function usageTab(root) {
  const e = err();
  const out = h("div", { class: "frame" });
  const period = h("select", { id: "period", "aria-label": "Period" }, Object.keys(PERIODS).map((p) => h("option", { value: p }, p)));
  period.value = "Last 7 days";
  let metric = "Requests";
  let data = null;

  const render = () => {
    const { cur, prev, u, b, names } = data;
    const xs = cur.map((r) => r.t);
    const total = (k) => sum(cur, k), ptotal = (k) => sum(prev, k);
    if (!total("requests")) return out.replaceChildren(h("div", { class: "card empty" }, h("strong", {}, "No requests in this period"), "Usage appears here once a router key makes a request."));
    const tile = (label, k, fmt) => h("div", { class: "tile" }, h("span", { class: "lab" }, label), h("span", { class: "val" }, fmt(total(k))),
      h("div", { class: "row2" }, h("span", { class: "delta" }, delta(total(k), ptotal(k))), sparkline(cur.slice(-12).map((r) => r[k] ?? 0))));
    const fmtX = b < DAYMS ? fmtHour : fmtDay;
    const single = (title, sub, k, fmt, nm) => {
      const host = h("div");
      lineChart(host, { xs, series: [{ name: nm, cls: "c1", values: cur.map((r) => r[k] ?? 0), fmt }], fmtX, fmtTip: (t) => fmtTipTime(t, b), fmtY: fmt, label: `${title} over time` });
      return card(title, sub, host, () => tableView(["Time (UTC)", nm], cur.map((r) => [fmtTipTime(r.t, b), fmt(r[k] ?? 0)])));
    };
    const tokHost = h("div");
    const tokChart = h("div", {}, h("div", { class: "legend" }, h("span", {}, h("i", { class: "key c1" }), "Input"), h("span", {}, h("i", { class: "key c2" }), "Output")), tokHost);
    lineChart(tokHost, { xs, stacked: true, series: [{ name: "Input", cls: "c1", values: cur.map((r) => r.inTokens), fmt: fmtNum }, { name: "Output", cls: "c2", values: cur.map((r) => r.outTokens), fmt: fmtNum }],
      fmtX, fmtTip: (t) => fmtTipTime(t, b), fmtY: fmtNum, label: "Tokens over time, input and output" });
    const tokens = card("Tokens", "Input and output, stacked", tokChart, () => tableView(["Time (UTC)", "Input", "Output"], cur.map((r) => [fmtTipTime(r.t, b), fmtNum(r.inTokens), fmtNum(r.outTokens)])));

    const M = METRICS[metric];
    const ranked = (rows, name) => {
      const all = rows.map((r) => ({ name: name(r.id), value: M.f(r), r })).filter((r) => r.value > 0).sort((a, z) => z.value - a.value);
      const top = all.slice(0, 8), rest = all.slice(8);
      if (rest.length) {
        const rr = rest.map((q) => q.r);
        top.push({ name: `Other (${rest.length})`, value: rest.reduce((x, r) => x + r.value, 0), r: { requests: sum(rr, "requests"), inTokens: sum(rr, "inTokens"), outTokens: sum(rr, "outTokens"), costUsd: sum(rr, "costUsd") } });
      }
      return top.map((x) => ({ name: x.name, value: x.value, tip: [{ value: fmtNum(x.r.requests), name: "requests" }, { value: fmtNum((x.r.inTokens ?? 0) + (x.r.outTokens ?? 0)), name: "tokens" }, { value: fmtUsd(x.r.costUsd), name: "spend" }] }));
    };
    const bars = (title, rows, name) => {
      const host = h("div"), rk = ranked(rows, name);
      if (!rk.length) host.append(h("p", { class: "muted" }, "Nothing to show."));
      else barList(host, rk, M.fmt);
      return card(title, `By ${metric.toLowerCase()}`, host, () => tableView(["Name", "Requests", "Tokens", "Spend"], rows.map((r) => [name(r.id), fmtNum(r.requests), fmtNum(METRICS.Tokens.f(r)), fmtUsd(r.costUsd)])));
    };
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Rank by" }, Object.keys(METRICS).map((m) =>
      h("button", { type: "button", "aria-pressed": String(m === metric), onclick: () => { metric = m; render(); } }, m)));
    out.replaceChildren(
      h("div", { class: "kpis" }, tile("Requests", "requests", fmtNum), tile("Input tokens", "inTokens", fmtNum), tile("Output tokens", "outTokens", fmtNum), tile("Spend", "costUsd", fmtUsd)),
      h("div", { class: "grid2" }, single("Requests", "Per " + (b < DAYMS ? "hour" : "day") + ", UTC", "requests", fmtNum, "Requests"), single("Spend", "Priced models only; unpriced count as $0", "costUsd", fmtUsd, "Spend")),
      h("div", { class: "grid1" }, tokens),
      h("div", { class: "row" }, h("h2", {}, "Breakdown"), seg),
      h("div", { class: "grid3" }, bars("Models", u.byModel, (id) => id), bars("Keys", u.byKey, (id) => names.keys[id] ?? id), bars("Accounts", u.byAccount, (id) => names.accounts[id] ?? id)));
  };

  const load = async () => {
    out.classList.add("loading");
    try {
      const P = PERIODS[period.value], b = P.bucket, now = Date.now();
      const s0 = P.since(), since = s0 - (s0 % b), end = Math.ceil((now + 1) / b) * b, span = end - since;
      const q = (a, z) => get(`/admin/usage/series?since=${a}&until=${z}&bucket=${b}`);
      const [curRows, prevRows, u, keys, accts] = await Promise.all([q(since, end), q(since - span, since), get(`/admin/usage?since=${since}`), get("/admin/keys"), get("/admin/accounts")]);
      data = { cur: fill(curRows, since, end, b), prev: fill(prevRows, since - span, since, b), u, b,
        names: { keys: Object.fromEntries(keys.map((k) => [k.id, k.name])), accounts: Object.fromEntries(accts.map((a) => [a.id, a.name])) } };
      showErr(e, null);
      render();
    } catch (x) { showErr(e, x); }
    out.classList.remove("loading");
  };
  period.addEventListener("change", load);

  const model = h("input", { required: true, placeholder: "exact model string" });
  const inP = h("input", { type: "number", min: "0", step: "any", required: true });
  const outP = h("input", { type: "number", min: "0", step: "any", required: true });
  const pm = err();
  const form = h("form", { onsubmit: async (ev) => {
    ev.preventDefault();
    try { await api("PUT", "/admin/prices", { model: model.value, inPerM: Number(inP.value), outPerM: Number(outP.value) }); showOk(pm, "Saved. New requests use this price."); }
    catch (x) { showErr(pm, x); }
  } }, field("Model", model), field("USD per 1M input tokens", inP), field("USD per 1M output tokens", outP),
    h("button", { class: "primary", type: "submit" }, "Set price"));
  root.append(h("div", { class: "filters" }, field("Period", period), h("span", { class: "muted" }, "Times are UTC; deltas compare with the previous period of the same length. The latest bucket is still filling.")), e, out,
    h("h2", {}, "Price override"), form, pm);
  load();
}

start();
