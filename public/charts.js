// Small chart kit: SVG/HTML only, no dependencies. All text goes in via textContent.
const NS = "http://www.w3.org/2000/svg";

export function s(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v === true ? "" : String(v));
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
}
export function mk(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
  return e;
}

// ---------- formatting ----------
export function fmtNum(n) {
  n = n ?? 0;
  const t = (x, u) => x.toFixed(1).replace(/\.0$/, "") + u;
  if (n < 10_000) return Math.round(n).toLocaleString("en-US");
  if (n < 1e6) return t(n / 1e3, "K");
  if (n < 1e9) return t(n / 1e6, "M");
  return t(n / 1e9, "B");
}
export function fmtUsd(n) {
  n = n ?? 0;
  if (n === 0) return "$0";
  if (n >= 100) return "$" + Math.round(n).toLocaleString("en-US");
  if (n >= 1) return "$" + n.toFixed(2);
  return "$" + n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
const DAY = 86_400_000;
export const fmtDay = (t) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
export const fmtHour = (t) => String(new Date(t).getUTCHours()).padStart(2, "0") + ":00";
export const fmtTipTime = (t, bucket) =>
  bucket < DAY
    ? `${fmtDay(t)}, ${fmtHour(t)} UTC`
    : new Date(t).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

// Round the axis max up so four even steps land on clean numbers.
function niceMax(max) {
  if (!(max > 0)) return 4;
  const raw = max / 4, pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((x) => x >= raw) ?? 10 * pow;
  return step * 4;
}

// ---------- tooltip ----------
// One tooltip element per host. rows: [{ cls, value, name }]; header is plain text.
export function makeTip(host) {
  const tip = mk("div", { class: "tip", role: "status", hidden: true });
  host.append(tip);
  return {
    show(x, y, header, rows) {
      tip.replaceChildren(
        mk("div", { class: "tip-h" }, header),
        ...rows.map((r) => mk("div", { class: "tip-r" }, r.cls ? mk("span", { class: `key ${r.cls}` }) : null, mk("strong", {}, r.value), mk("span", { class: "muted" }, r.name))),
      );
      tip.hidden = false;
      const w = tip.offsetWidth, hw = host.clientWidth;
      tip.style.left = `${Math.max(0, Math.min(x + 14, hw - w))}px`;
      tip.style.top = `${Math.max(0, y - tip.offsetHeight - 8)}px`;
    },
    hide() { tip.hidden = true; },
    el: tip,
  };
}

// ---------- sparkline ----------
export function sparkline(values, w = 96, h = 28) {
  const v = values.length ? values : [0];
  const max = Math.max(...v, 1), n = v.length;
  const x = (i) => 3 + (n === 1 ? (w - 6) / 2 : (i * (w - 6)) / (n - 1));
  const y = (val) => h - 3 - (val / max) * (h - 6);
  const d = v.map((val, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(val).toFixed(1)}`).join("");
  return s("svg", { class: "spark", width: w, height: h, viewBox: `0 0 ${w} ${h}`, "aria-hidden": "true" },
    s("path", { d, class: "spark-line" }),
    s("circle", { cx: x(n - 1), cy: y(v[n - 1]), r: 3, class: "spark-dot" }));
}

// ---------- line / area chart ----------
// series: [{ name, cls: "c1"|"c2", values, fmt }]; stacked draws series[0] at the bottom.
export function lineChart(host, { xs, series, stacked = false, fmtX, fmtTip, fmtY, label }) {
  host.classList.add("chart");
  let lastW = 0, active = -1;
  const tip = makeTip(host);

  const draw = () => {
    const W = Math.max(host.clientWidth, 280), H = 236, m = { l: 56, r: 20, t: 12, b: 30 };
    lastW = W;
    const iw = W - m.l - m.r, ih = H - m.t - m.b, n = xs.length;
    const cum = series.map((_, si) => xs.map((_, i) => (stacked ? series.slice(0, si + 1).reduce((a, q) => a + q.values[i], 0) : series[si].values[i])));
    const top = niceMax(Math.max(0, ...cum.flat()));
    const X = (i) => m.l + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
    const Y = (v) => m.t + ih - (v / top) * ih;
    const g = [];
    for (let k = 0; k <= 4; k++) {
      const v = (top / 4) * k, y = Y(v);
      g.push(s("line", { x1: m.l, x2: W - m.r, y1: y, y2: y, class: "grid" }));
      g.push(s("text", { x: m.l - 10, y: y + 4, class: "axis", "text-anchor": "end" }, fmtY(v)));
    }
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 72))));
    for (let i = 0; i < n; i += every) g.push(s("text", { x: X(i), y: H - 8, class: "axis", "text-anchor": n === 1 ? "middle" : i === 0 ? "start" : "middle" }, fmtX(xs[i])));
    const marks = series.map((q, si) => {
      const pts = cum[si].map((v, i) => [X(i), Y(v)]);
      const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
      const lower = si && stacked ? cum[si - 1].map((v, i) => [X(i), Y(v)]) : null;
      const area = line + (lower ? [...lower].reverse().map(([x, y]) => `L${x.toFixed(1)} ${y.toFixed(1)}`).join("") : `L${X(n - 1).toFixed(1)} ${Y(0)}L${X(0).toFixed(1)} ${Y(0)}`) + "Z";
      const [ex, ey] = pts[n - 1];
      return s("g", {},
        s("path", { d: area, class: `fill ${q.cls}` }),
        stacked ? s("path", { d: line, class: "gap" }) : null, // 2px surface gap under the band edge
        s("path", { d: line, class: `ln ${q.cls}` }),
        s("circle", { cx: ex, cy: ey, r: 4, class: `dot ${q.cls}` }));
    });
    const cross = s("line", { class: "cross", y1: m.t, y2: m.t + ih, hidden: true });
    const hot = cum.map(() => s("circle", { r: 4, class: "dot", hidden: true }));
    hot.forEach((c, si) => c.classList.add(series[si].cls));
    const over = s("rect", { x: m.l, y: m.t, width: iw, height: ih, class: "over" });
    const root = s("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", tabindex: "0", "aria-label": `${label}. Use the left and right arrow keys to read each point.` },
      ...g, ...marks, cross, ...hot, over);

    const at = (i) => {
      active = i;
      const x = X(i);
      cross.removeAttribute("hidden"); cross.setAttribute("x1", x); cross.setAttribute("x2", x);
      hot.forEach((c, si) => { c.removeAttribute("hidden"); c.setAttribute("cx", x); c.setAttribute("cy", Y(cum[si][i])); });
      const rows = series.map((q) => ({ cls: q.cls, value: q.fmt(q.values[i]), name: q.name })).reverse();
      tip.show(x, Y(Math.max(...cum.map((c) => c[i]))), fmtTip(xs[i]), rows);
    };
    const off = () => { active = -1; cross.setAttribute("hidden", ""); hot.forEach((c) => c.setAttribute("hidden", "")); tip.hide(); };
    over.addEventListener("pointermove", (e) => {
      const r = over.getBoundingClientRect();
      at(n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
    });
    over.addEventListener("pointerleave", off);
    root.addEventListener("blur", off);
    root.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      at(Math.max(0, Math.min(n - 1, (active < 0 ? n - 1 : active) + (e.key === "ArrowRight" ? 1 : -1))));
    });
    host.replaceChildren(root, tip.el);
  };

  draw();
  if (typeof ResizeObserver !== "undefined")
    new ResizeObserver(() => { if (Math.abs(host.clientWidth - lastW) > 1 && host.isConnected) draw(); }).observe(host);
}

// ---------- ranked horizontal bars ----------
// rows: [{ name, value, tip: [{name,value}] }]; fmt formats the value. One hue, value at the tip.
export function barList(host, rows, fmt) {
  host.classList.add("bars");
  const tip = makeTip(host);
  const max = Math.max(...rows.map((r) => r.value), 0);
  const list = mk("div", { class: "bar-rows" }, rows.map((r) => {
    const track = mk("div", { class: "bar-track" }, mk("div", { class: "bar-fill" }));
    track.firstChild.style.width = `${max > 0 ? Math.max(1.5, (r.value / max) * 100) : 0}%`;
    const row = mk("div", { class: "bar-row", tabindex: "0" }, mk("span", { class: "bar-name", title: r.name }, r.name), track, mk("span", { class: "bar-val" }, fmt(r.value)));
    const show = (e) => {
      const hb = host.getBoundingClientRect(), rb = row.getBoundingClientRect();
      tip.show(e?.clientX != null ? e.clientX - hb.left : rb.left - hb.left + 120, rb.top - hb.top, r.name, r.tip);
    };
    row.addEventListener("pointermove", show);
    row.addEventListener("focus", () => show());
    row.addEventListener("pointerleave", tip.hide);
    row.addEventListener("blur", tip.hide);
    return row;
  }));
  host.replaceChildren(list, tip.el);
}

// ---------- table twin ----------
export function tableView(heads, rows) {
  return mk("div", { class: "scroll" }, mk("table", {},
    mk("thead", {}, mk("tr", {}, heads.map((t, i) => mk("th", { scope: "col", class: i ? "num" : "" }, t)))),
    mk("tbody", {}, rows.map((r) => mk("tr", {}, r.map((c, i) => mk("td", { class: i ? "num" : "" }, String(c))))))));
}

// ---------- card with a chart/table toggle ----------
export function card(title, sub, chart, table) {
  let showTable = false;
  const body = mk("div", { class: "card-body" }, chart);
  const btn = mk("button", { type: "button", class: "ghost small", "aria-pressed": "false" }, "Table");
  btn.addEventListener("click", () => {
    showTable = !showTable;
    btn.setAttribute("aria-pressed", String(showTable));
    btn.textContent = showTable ? "Chart" : "Table";
    body.replaceChildren(showTable ? table() : chart);
  });
  return mk("section", { class: "card" }, mk("div", { class: "card-head" }, mk("div", {}, mk("h3", { class: "card-title" }, title), sub ? mk("p", { class: "card-sub" }, sub) : null), btn), body);
}
