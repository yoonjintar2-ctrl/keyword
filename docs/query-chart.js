"use strict";
function smoothPath(points) {
  let d = "",
    part = [];
  const flush = () => {
    if (!part.length) return;
    d += "M" + part[0].join(",");
    if (part.length > 1) {
      const n = part.length,
        slopes = part
          .slice(0, -1)
          .map(
            (p, i) => (part[i + 1][1] - p[1]) / (part[i + 1][0] - p[0] || 1),
          ),
        t = part.map((p, i) =>
          i === 0
            ? slopes[0]
            : i === n - 1
              ? slopes[n - 2]
              : slopes[i - 1] * slopes[i] <= 0
                ? 0
                : 2 / (1 / slopes[i - 1] + 1 / slopes[i]),
        );
      for (let i = 0; i < n - 1; i++) {
        const dx = (part[i + 1][0] - part[i][0]) / 3;
        d +=
          "C" +
          [
            part[i][0] + dx,
            part[i][1] + dx * t[i],
            part[i + 1][0] - dx,
            part[i + 1][1] - dx * t[i + 1],
            ...part[i + 1],
          ].join(",");
      }
    }
    part = [];
  };
  for (const p of points) {
    if (!p) {
      flush();
      continue;
    }
    part.push(p);
  }
  flush();
  return d;
}

function queryTotals() {
  const values = dataset.models.map((m) => estimates(m));
  return dataset.dates.map((_, i) => {
    const valid = values.map((v) => v[i]).filter((v) => v != null);
    return {
      value: valid.length ? valid.reduce((s, v) => s + v, 0) : null,
      available: valid.length,
      total: values.length,
    };
  });
}

/* 0억 · 0만 · 0천 형식의 함축 표기 */
function compactNumber(n) {
  const a = Math.abs(n),
    t = (v) => String(v >= 100 ? Math.round(v) : Math.round(v * 10) / 10);
  if (a >= 1e8) return t(n / 1e8) + "억";
  if (a >= 1e4) return t(n / 1e4) + "만";
  if (a >= 1e3) return t(n / 1e3) + "천";
  return fmt(n);
}
const shortNumber = compactNumber;

/* ---------- 보조 지표·이슈 데이터 ---------- */
let insights = null;
async function loadInsights() {
  try {
    const r = await fetch("./insights.json", { cache: "no-store" });
    insights = r.ok ? await r.json() : null;
  } catch {
    insights = null;
  }
}
function matchInsight() {
  if (!insights?.analyses || !dataset) return null;
  const ks = new Set(dataset.models.map((m) => key(m.keyword)));
  return (
    insights.analyses.find((a) => (a.keywords || []).some((k) => ks.has(key(k)))) ||
    null
  );
}

const SERIES_DEFAULT = {
  google_web: true,
  google_youtube: true,
  issues: true,
  spikes: true,
};
const seriesOn = (() => {
  try {
    return {
      ...SERIES_DEFAULT,
      ...JSON.parse(localStorage.getItem("nq-series") || "{}"),
    };
  } catch {
    return { ...SERIES_DEFAULT };
  }
})();
function saveSeries() {
  try {
    localStorage.setItem("nq-series", JSON.stringify(seriesOn));
  } catch {}
}

/* 전후 7일 중앙값 대비 15% 이상 높은 국소 최고점 */
function detectSpikes(totals) {
  const v = totals.map((t) => t.value),
    out = [];
  for (let i = 0; i < v.length; i++) {
    if (v[i] == null) continue;
    const win = [];
    for (let j = i - 7; j <= i + 7; j++)
      if (j !== i && j >= 0 && j < v.length && v[j] != null) win.push(v[j]);
    if (win.length < 6) continue;
    win.sort((a, b) => a - b);
    const med =
      win.length % 2
        ? win[(win.length - 1) / 2]
        : (win[win.length / 2 - 1] + win[win.length / 2]) / 2;
    let localMax = true;
    for (let j = i - 2; j <= i + 2; j++)
      if (j !== i && v[j] != null && v[j] > v[i]) localMax = false;
    if (localMax && med > 0 && v[i] >= med * 1.15)
      out.push({ i, pct: (v[i] / med - 1) * 100, med });
  }
  return out;
}

const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
const weekday = (d) => new Date(d + "T00:00:00Z").getUTCDay();
const md = (d) => +d.slice(5, 7) + "." + +d.slice(8, 10);

let measureCtx = null;
function textWidth(text, font = "650 11px sans-serif") {
  measureCtx ||= document.createElement("canvas").getContext("2d");
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

function seriesToggles(aux, hasIssues, hasSpikes) {
  const box = $("mainLegend");
  box.replaceChildren();
  const chip = (label, color, id, opts = {}) => {
    const b = document.createElement("button");
    b.type = "button";
    const i = document.createElement("i");
    if (opts.dot) i.className = "dot";
    b.style.setProperty("--c", color);
    b.append(i, document.createTextNode(label));
    if (opts.title) b.title = opts.title;
    if (opts.disabled) {
      b.disabled = true;
    } else if (id) {
      b.setAttribute("aria-pressed", String(seriesOn[id] !== false));
      b.onclick = () => {
        seriesOn[id] = seriesOn[id] === false;
        saveSeries();
        mainFlow();
      };
    } else {
      b.setAttribute("aria-pressed", "true");
      b.disabled = true;
      b.style.opacity = 1;
    }
    box.append(b);
  };
  chip(
    "네이버 추정 쿼리 · " + dataset.models.length + "개",
    "var(--naver)",
    null,
    { title: "메인 지표 · 전체 키워드의 일별 추정 쿼리 합계" },
  );
  for (const a of aux)
    chip(a.name, a.color, a.id, { title: a.kind + " · " + a.basis });
  chip("소셜 발화량", "var(--social)", null, {
    disabled: true,
    title: "소셜 발화량은 데이터 소스(블로그·카페 검색 API 등) 연결 후 표시됩니다.",
  });
  if (hasIssues) chip("이슈", "var(--issue)", "issues", { dot: true });
  if (hasSpikes) chip("급등일", "#9aaba0", "spikes", { dot: true });
}

let chartObserver = null,
  lastSize = "";
function watchChartSize() {
  if (chartObserver || typeof ResizeObserver === "undefined") return;
  chartObserver = new ResizeObserver(() => {
    const el = $("mainChart"),
      size = el.clientWidth + "x" + el.clientHeight;
    if (size === lastSize || !dataset?.models?.length) return;
    lastSize = size;
    requestAnimationFrame(mainFlow);
  });
  chartObserver.observe($("mainChart"));
}

function mainFlow() {
  const root = $("mainChart");
  watchChartSize();
  root.replaceChildren();
  const index = ix(),
    dates = index.map((x) => x.date);
  if (!dates.length) return;
  lastSize = root.clientWidth + "x" + root.clientHeight;
  const W = Math.max(320, root.clientWidth),
    H = Math.max(240, root.clientHeight),
    totals = queryTotals(),
    values = index.map(({ i }) => totals[i]),
    valid = values.map((v) => v.value).filter((v) => v != null),
    match = matchInsight(),
    aux = (match?.aux || [])
      .map((a) => ({ ...a, vals: dates.map((d) => a.values?.[d] ?? null) }))
      .filter((a) => a.vals.some((v) => v != null)),
    pos = new Map(dates.map((d, k) => [d, k])),
    news = (match?.issues || [])
      .filter((s) => pos.has(s.date))
      .map((s) => ({ ...s, k: pos.get(s.date), type: "news" })),
    spikeAll = detectSpikes(totals)
      .map((s) => ({ ...s, date: dataset.dates[s.i] }))
      .filter((s) => pos.has(s.date))
      .map((s) => ({ ...s, k: pos.get(s.date) }));

  // 뉴스와 ±1일 내 급등은 뉴스 마커에 합침
  const spikes = [];
  for (const s of spikeAll) {
    const near = news.find((n) => Math.abs(n.k - s.k) <= 1);
    if (near) near.spike = s;
    else spikes.push({ ...s, type: "spike" });
  }
  seriesToggles(aux, news.length > 0, spikes.length > 0);

  const markers = [
    ...(seriesOn.issues !== false ? news : []),
    ...(seriesOn.spikes !== false ? spikes : []),
  ].sort((a, b) => a.k - b.k);

  const L = 22,
    R = 22,
    B = 30,
    laneH = 26,
    pw = W - L - R,
    x = (k) => L + (k / Math.max(1, dates.length - 1)) * pw;

  // 이슈 라벨 줄 배치
  const rows = [];
  for (const m of markers) {
    m.label =
      m.type === "news" ? m.title : "급등 +" + Math.round(m.pct) + "%";
    m.w = Math.min(200, Math.ceil(textWidth(m.label, "650 11px sans-serif") * 1.08) + 26);
    let cx = Math.min(Math.max(x(m.k), L + m.w / 2), W - R - m.w / 2),
      row = rows.findIndex((right) => cx - m.w / 2 > right + 6);
    if (row < 0 && rows.length < (W < 700 ? 6 : 3)) row = rows.length;
    if (row < 0) row = rows.indexOf(Math.min(...rows));
    rows[row] = cx + m.w / 2;
    m.row = row;
    m.cx = cx;
  }
  const T = (rows.length ? rows.length * laneH + 14 : 14) + 18,
    ph = H - T - B,
    // y축은 숨기고 값 범위에 맞춰 화면을 꽉 채움(최저~최고 + 여백)
    vmin = valid.length ? Math.min(...valid) : 0,
    vmax = valid.length ? Math.max(...valid) : 1,
    pad = Math.max((vmax - vmin) * 0.12, vmax * 0.02, 1),
    lo = Math.max(0, vmin - pad),
    hi = vmax + pad * 0.6,
    // 네이버는 위쪽 띠(상단 72%), 보조 지표는 아래쪽 띠에 배치
    NAV_H = ph * 0.72,
    y = (v) => T + NAV_H - ((v - lo) / (hi - lo)) * NAV_H,
    ns = "http://www.w3.org/2000/svg",
    svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    "전체 키워드 합계 일별 추정 쿼리수와 보조 지표",
  );
  function add(tag, attrs, text, parent = svg) {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text !== undefined) el.textContent = text;
    parent.append(el);
    return el;
  }

  // x축 눈금: 화면 폭에 맞춰 일·2일·주·2주·월 단위로 촘촘하게
  const dayPx = pw / Math.max(1, dates.length - 1),
    MIN = 40,
    mode =
      dayPx >= MIN
        ? 1
        : dayPx * 2 >= MIN
          ? 2
          : dayPx * 7 >= MIN
            ? 7
            : dayPx * 14 >= MIN
              ? 14
              : 30;
  add("line", {
    x1: L,
    x2: W - R,
    y1: T + ph,
    y2: T + ph,
    stroke: "#cfdcd5",
  });
  let lastX = -1e9;
  dates.forEach((d, k) => {
    const wd = weekday(d),
      first = d.endsWith("-01"),
      px = x(k);
    if (dayPx >= 5)
      add("line", {
        x1: px,
        x2: px,
        y1: T + ph,
        y2: T + ph + (wd === 1 ? 5 : 3),
        stroke: wd === 0 ? "#e2a8a0" : "#cfdcd5",
      });
    const take =
      mode === 1
        ? true
        : mode === 2
          ? k % 2 === 0
          : mode === 7
            ? wd === 1
            : mode === 14
              ? wd === 1 && Math.floor(k / 7) % 2 === 0
              : first;
    if (!take && !(first && mode >= 7)) return;
    if (px - lastX < MIN - 6) return;
    lastX = px;
    add("line", {
      x1: px,
      x2: px,
      y1: T,
      y2: T + ph,
      stroke: first ? "#dde8e2" : "#eef3f0",
    });
    add(
      "text",
      {
        x: px,
        y: H - 10,
        "text-anchor": k === 0 ? "start" : k === dates.length - 1 ? "end" : "middle",
        fill: wd === 0 && mode <= 2 ? "#c0675b" : first ? "#3f5a50" : "#7d8e85",
        "font-size": 10.5,
        "font-weight": first ? 700 : 400,
      },
      (first && mode >= 7 ? +d.slice(5, 7) + "월 " : "") +
        (first && mode >= 7 ? "" : md(d)) +
        (mode === 1 ? "(" + WEEK[wd] + ")" : ""),
    );
  });

  // 보조 지표: 각자의 축(0~자기 최대)
  const auxShown = aux.filter((a) => seriesOn[a.id] !== false);
  for (const a of auxShown) {
    const av = a.vals.filter((v) => v != null),
      amin = Math.min(...av),
      amax = Math.max(...av),
      apad = Math.max((amax - amin) * 0.12, 1),
      alo = Math.max(0, amin - apad),
      ahi = amax + apad * 0.6,
      ay = (v) => T + ph - ((v - alo) / (ahi - alo)) * ph * 0.42;
    add("path", {
      d: smoothPath(a.vals.map((v, k) => (v == null ? null : [x(k), ay(v)]))),
      fill: "none",
      "data-aux": a.id,
      stroke: a.color,
      "stroke-width": 1.6,
      "stroke-opacity": 0.7,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    });
    a.ay = ay;
  }

  // 메인: 네이버 추정 쿼리 — 그라데이션 영역 + 굵은 선
  const defs = add("defs", {}),
    grad = add(
      "linearGradient",
      { id: "naverFill", x1: 0, y1: 0, x2: 0, y2: 1 },
      undefined,
      defs,
    );
  add("stop", { offset: "0%", "stop-color": "#138b7c", "stop-opacity": 0.32 }, undefined, grad);
  add("stop", { offset: "70%", "stop-color": "#138b7c", "stop-opacity": 0.08 }, undefined, grad);
  add("stop", { offset: "100%", "stop-color": "#138b7c", "stop-opacity": 0 }, undefined, grad);
  const pts = values.map((v, k) => (v.value == null ? null : [x(k), y(v.value)])),
    segs = [];
  let segStart = -1;
  pts.forEach((p, k) => {
    if (p && segStart < 0) segStart = k;
    if ((!p || k === pts.length - 1) && segStart >= 0) {
      const end = p ? k : k - 1;
      if (end > segStart) segs.push([segStart, end]);
      segStart = -1;
    }
  });
  for (const [a, b] of segs)
    add("path", {
      d:
        smoothPath(pts.slice(a, b + 1)) +
        `L${x(b)},${T + ph}L${x(a)},${T + ph}Z`,
      fill: "url(#naverFill)",
      stroke: "none",
    });
  // 아래 보조 지표를 영역 위로 다시 올림
  for (const el of svg.querySelectorAll("path[data-aux]")) svg.append(el);
  add("path", {
    d: smoothPath(pts),
    fill: "none",
    stroke: "#0f7f70",
    "stroke-width": 6.5,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "data-series": "query-total",
  });
  values.forEach((v, k) => {
    if (
      v.value != null &&
      (k === 0 || values[k - 1].value == null) &&
      (k === values.length - 1 || values[k + 1].value == null)
    )
      add("circle", { cx: x(k), cy: y(v.value), r: 4, fill: "#138b7c" });
  });

  // 최고점만 함축 표기
  if (valid.length) {
    const top = Math.max(...valid),
      k = values.findIndex((v) => v.value === top),
      px = x(k),
      py = y(top),
      text = "최고 " + compactNumber(top) + " · " + md(dates[k]),
      tw = textWidth(text, "700 12px sans-serif") + 14,
      onLeft = px + tw + 14 > W - R,
      bx = onLeft ? px - tw - 12 : px + 12;
    add("circle", {
      cx: px,
      cy: py,
      r: 5.5,
      fill: "#fff",
      stroke: "#138b7c",
      "stroke-width": 3,
    });
    add("rect", {
      x: bx,
      y: py - 11,
      width: tw,
      height: 22,
      rx: 11,
      fill: "#138b7c",
    });
    add(
      "text",
      {
        x: bx + tw / 2,
        y: py + 4,
        "text-anchor": "middle",
        fill: "#fff",
        "font-size": 12,
        "font-weight": 700,
      },
      text,
    );
  } else
    add(
      "text",
      {
        x: L + pw / 2,
        y: T + ph / 2,
        "text-anchor": "middle",
        fill: "#7d8e85",
        "font-size": 13,
      },
      "이 기간의 쿼리 추정치를 확보하지 못했습니다.",
    );

  // 이슈 마커: 그래프 위 동그라미 + 연결선
  for (const m of markers) {
    const v = values[m.k]?.value,
      px = x(m.k),
      py = v == null ? T + ph : y(v),
      ly = 8 + m.row * laneH + 22;
    add("path", {
      d: `M${m.cx},${ly}L${m.cx},${ly + 6}L${px},${Math.min(py - 9, ly + 18)}L${px},${py - 8}`,
      fill: "none",
      stroke: m.type === "news" ? "#d9822b" : "#9aaba0",
      "stroke-width": 1.3,
      "stroke-dasharray": m.type === "news" ? "0" : "3 3",
    });
    add("circle", {
      cx: px,
      cy: py,
      r: m.type === "news" ? 7.5 : 6,
      fill: "none",
      stroke: m.type === "news" ? "#d9822b" : "#8fa39a",
      "stroke-width": m.type === "news" ? 2.5 : 1.8,
      "stroke-dasharray": m.type === "news" ? "0" : "3 2",
    });
  }

  // 호버: 세로선 + 모든 지표 값
  const line = add("line", {
      x1: L,
      x2: L,
      y1: T,
      y2: T + ph,
      stroke: "#a0b8ad",
      "stroke-dasharray": "4 4",
      visibility: "hidden",
    }),
    dot = add("circle", {
      r: 5,
      fill: "#138b7c",
      stroke: "#fff",
      "stroke-width": 2,
      visibility: "hidden",
    }),
    overlay = add("rect", {
      x: L,
      y: T,
      width: pw,
      height: ph,
      fill: "transparent",
      tabindex: 0,
      role: "slider",
      "aria-label": "좌우 방향키 또는 마우스로 날짜별 값 확인",
      "aria-valuemin": 0,
      "aria-valuemax": dates.length - 1,
      "aria-valuenow": 0,
    }),
    tip = document.createElement("div");
  tip.className = "tooltip flow-tooltip";
  tip.hidden = true;
  let cur = 0;
  const row = (color, label, value) => {
    const r = document.createElement("div"),
      i = document.createElement("i"),
      b = document.createElement("b");
    r.className = "row";
    r.style.setProperty("--c", color);
    b.textContent = value;
    r.append(i, document.createTextNode(label), b);
    return r;
  };
  function show(k) {
    cur = Math.max(0, Math.min(dates.length - 1, k));
    const v = values[cur],
      px = x(cur);
    line.setAttribute("x1", px);
    line.setAttribute("x2", px);
    line.setAttribute("visibility", "visible");
    if (v.value != null) {
      dot.setAttribute("cx", px);
      dot.setAttribute("cy", y(v.value));
      dot.setAttribute("visibility", "visible");
    } else dot.setAttribute("visibility", "hidden");
    tip.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = dates[cur] + " (" + WEEK[weekday(dates[cur])] + ")";
    tip.append(
      title,
      row(
        "#6ed0b5",
        "네이버 추정 쿼리",
        v.value == null ? "미확보" : fmt(v.value) + "건",
      ),
    );
    if (v.available < v.total)
      tip.append(
        row("#6b8a7d", "추정 가능 키워드", v.available + " / " + v.total),
      );
    for (const a of auxShown)
      tip.append(
        row(
          a.color,
          a.name + " 지수",
          a.vals[cur] == null ? "–" : String(a.vals[cur]),
        ),
      );
    const near = markers.find((m) => m.k === cur);
    if (near) {
      const p = document.createElement("div");
      p.className = "issue-line";
      p.textContent =
        near.type === "news"
          ? "● " + near.title
          : "◌ 급등 +" + Math.round(near.pct) + "% (원인 미확인)";
      tip.append(p);
    }
    tip.hidden = false;
    const tw = tip.offsetWidth || 220,
      left = px + 16 + tw > W ? px - 16 - tw : px + 16;
    tip.style.left = Math.max(4, left) + "px";
    tip.style.top = T + 6 + "px";
    overlay.setAttribute("aria-valuenow", cur);
    overlay.setAttribute("aria-valuetext", dates[cur]);
  }
  overlay.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    show(
      Math.round(
        ((((e.clientX - r.left) / r.width) * W - L) / pw) * (dates.length - 1),
      ),
    );
  });
  const hide = () => {
    tip.hidden = true;
    line.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
  };
  overlay.addEventListener("pointerleave", hide);
  overlay.addEventListener("blur", hide);
  overlay.addEventListener("focus", () => show(cur));
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      show(cur + (e.key === "ArrowLeft" ? -1 : 1));
    }
  });
  root.append(svg, tip);

  // 이슈 라벨(HTML) + 상세 카드
  let card = null,
    hideTimer = 0;
  const closeCard = () => {
    card?.remove();
    card = null;
    root
      .querySelectorAll(".issue-label.active")
      .forEach((el) => el.classList.remove("active"));
  };
  const scheduleClose = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(closeCard, 220);
  };
  function openCard(m, labelEl) {
    clearTimeout(hideTimer);
    closeCard();
    labelEl.classList.add("active");
    card = document.createElement("div");
    card.className = "issue-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", m.label);
    const date = document.createElement("div"),
      strong = document.createElement("strong");
    date.className = "date";
    date.textContent = dates[m.k] + " (" + WEEK[weekday(dates[m.k])] + ")";
    strong.textContent = m.type === "news" ? m.title : "검색량 급등일";
    card.append(date, strong);
    const p = document.createElement("p");
    const v = values[m.k]?.value;
    if (m.type === "news") {
      p.textContent = m.summary || "";
      card.append(p);
      const meta = document.createElement("div");
      meta.className = "meta";
      if (m.spike)
        meta.append(
          "이 무렵 네이버 추정 쿼리가 전후 7일 중앙값 대비 +" +
            Math.round(m.spike.pct) +
            "%. ",
        );
      if (m.url) {
        const a = document.createElement("a");
        a.href = m.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = (m.source || "기사") + " 원문 보기 ↗";
        meta.append(a);
      } else if (m.source) meta.append(m.source);
      card.append(meta);
    } else {
      p.textContent =
        "네이버 추정 쿼리 " +
        (v == null ? "미확보" : fmt(v) + "건") +
        " · 전후 7일 중앙값(" +
        fmt(m.med) +
        "건) 대비 +" +
        Math.round(m.pct) +
        "%. 이 날짜와 맞는 보도는 아직 확인하지 못했습니다.";
      card.append(p);
    }
    root.append(card);
    const cw = card.offsetWidth,
      left = Math.min(Math.max(4, m.cx - cw / 2), W - cw - 4);
    card.style.left = left + "px";
    card.style.top = 8 + m.row * laneH + 26 + "px";
    card.addEventListener("pointerenter", () => clearTimeout(hideTimer));
    card.addEventListener("pointerleave", scheduleClose);
  }
  for (const m of markers) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "issue-label" + (m.type === "spike" ? " spike" : "");
    el.textContent = m.label;
    el.style.left = m.cx + "px";
    el.style.top = 8 + m.row * laneH + "px";
    el.style.maxWidth = m.w + "px";
    el.title = "";
    el.addEventListener("pointerenter", () => openCard(m, el));
    el.addEventListener("pointerleave", scheduleClose);
    el.addEventListener("focus", () => openCard(m, el));
    el.addEventListener("blur", scheduleClose);
    el.addEventListener("click", () => openCard(m, el));
    el.addEventListener("keydown", (e) => e.key === "Escape" && closeCard());
    root.append(el);
  }

  const basis = auxShown.map((a) => a.name + ": " + a.basis).join(" / ");
  $("flowFoot").textContent =
    "굵은 선은 네이버 전체 키워드의 일별 추정 쿼리 합계입니다. 세로 범위는 기간 내 최저~최고에 맞춰 확대되어 있으니 값은 그래프에 마우스를 올려 확인하세요." +
    (basis
      ? " 보조 지표는 각자의 축에 그린 상대 지수로 추이만 비교합니다 — " + basis + "."
      : "") +
    " 결측은 0으로 채우지 않습니다.";
}
