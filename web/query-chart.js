"use strict";
/* ============================================================
   일별 흐름 메인 그래프
   - 네이버 추정 쿼리(굵은 선+그라데이션) / 보조 지표(구글·유튜브, 별도 축)
   - 이슈 마커(무채색 점선) / 성·연령 분리 / 30일 보기 좌우 이동
   ============================================================ */
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
          .map((p, i) => (part[i + 1][1] - p[1]) / (part[i + 1][0] - p[0] || 1)),
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

/* 필터로 선택한 키워드의 일별 추정 쿼리 합계 */
function queryTotals() {
  const values = chosen().map((m) => estimates(m));
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
  const byJob =
    dataset.job_id && insights.analyses.find((a) => a.job_id === dataset.job_id);
  if (byJob) return byJob;
  const ks = new Set(dataset.models.map((m) => key(m.keyword)));
  return (
    insights.analyses.find((a) => a.collected_from === dataset.collected_at) ||
    insights.analyses.find(
      (a) => a.manual && (a.keywords || []).some((k) => ks.has(key(k))),
    ) ||
    null
  );
}

const SERIES_DEFAULT = { google_web: true, google_youtube: true, issues: true };
const seriesOn = (() => {
  try {
    return { ...SERIES_DEFAULT, ...JSON.parse(localStorage.getItem("nq-series") || "{}") };
  } catch {
    return { ...SERIES_DEFAULT };
  }
})();
function saveSeries() {
  try {
    localStorage.setItem("nq-series", JSON.stringify(seriesOn));
  } catch {}
}

/* 보조 지표 스타일: 네이버와 같은 굵기, 반투명 */
const AUX_STYLE = {
  google_web: { color: "#8b949a", opacity: 0.32, band: 0.34 },
  google_youtube: { color: "#e0574f", opacity: 0.3, band: null }, // 네이버 선에 살짝 닿도록 동적 계산
  social_blog: { color: "#9a6fc9", opacity: 0.3, band: 0.3 },
};

/* ---------- 성·연령 ---------- */
let segMode = "all"; // all | gender | age
const SEGMENTS = {
  gender: [
    { id: "male", name: "남성", color: "#3f7fd6" },
    { id: "female", name: "여성", color: "#e0688b" },
  ],
  age: [
    // 같은 색상(청록)에서 명도·채도만 단계적으로
    { id: "under19", name: "18세 이하", color: "#d6ebe6", line: "#7fb3a7" },
    { id: "age19_29", name: "19~29세", color: "#b0d9cf", line: "#5a9d8e" },
    { id: "age30_39", name: "30대", color: "#82c2b4", line: "#3c8574" },
    { id: "age40_49", name: "40대", color: "#52a593", line: "#1f6a5b" },
    { id: "age50_59", name: "50대", color: "#2d8573", line: "#0e4d41" },
    { id: "age60plus", name: "60세 이상", color: "#155f51", line: "#062e27" },
  ],
};
/* 집단별 상대 추이: 키워드별 지수를 기간 평균으로 나눠 월간 검색수로 가중 합산.
   네이버가 집단마다 지수를 따로 정규화하므로 실제 집단별 건수가 아니라 추이 비교용이다. */
function segmentSeries(segId) {
  const n = dataset.dates.length,
    out = new Array(n).fill(null);
  for (const m of chosen()) {
    const s = m.series?.[segId];
    if (!s) continue;
    const ok = s.filter((v) => v != null);
    if (ok.length < n * 0.8) continue;
    const mean = ok.reduce((a, b) => a + b, 0) / ok.length,
      w = (typeof m.pc === "number" ? m.pc : 0) + (typeof m.mobile === "number" ? m.mobile : 0);
    if (!mean || !w) continue;
    s.forEach((v, i) => {
      if (v == null) return;
      out[i] = (out[i] || 0) + (v / mean) * w;
    });
  }
  return out;
}

const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
const weekday = (d) => new Date(d + "T00:00:00Z").getUTCDay();
const md = (d) => +d.slice(5, 7) + "." + +d.slice(8, 10);

let measureCtx = null;
function textWidth(text, font = "600 11px sans-serif") {
  measureCtx ||= document.createElement("canvas").getContext("2d");
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}
const reduceMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- 범례·토글 ---------- */
function seriesToggles(aux, hasIssues, segList) {
  const box = $("mainLegend");
  box.replaceChildren();
  const chip = (label, color, id, opts = {}) => {
    const b = document.createElement("button");
    b.type = "button";
    const i = document.createElement("i");
    if (opts.dot) i.className = "dot";
    if (opts.soft) i.style.opacity = 0.55;
    b.style.setProperty("--c", color);
    b.append(i, document.createTextNode(label));
    if (opts.title) b.title = opts.title;
    if (opts.disabled) b.disabled = true;
    else if (id) {
      b.setAttribute("aria-pressed", String(seriesOn[id] !== false));
      b.onclick = () => {
        seriesOn[id] = seriesOn[id] === false;
        saveSeries();
        mainFlow({ animate: true });
      };
    } else {
      b.setAttribute("aria-pressed", "true");
      b.disabled = true;
      b.style.opacity = 1;
    }
    box.append(b);
  };
  if (segList) {
    for (const s of segList) chip(s.name, s.color, null, { title: "집단 내 상대 추이" });
    if (segMode === "age") {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "share-btn";
      b.textContent = getShares("age").provided ? "연령 비율 수정" : "연령 비율 입력";
      b.onclick = () => openSharePop(b);
      box.append(b);
    }
  } else {
    chip("네이버 추정 쿼리 · " + chosen().length + "개", "var(--naver)", null, {
      title: "메인 지표 · 선택한 키워드의 일별 추정 쿼리 합계",
    });
    for (const a of aux)
      chip(a.name, a.color, a.id, { soft: true, title: a.kind + " · " + a.basis });
    if (!aux.some((a) => a.id === "social_blog"))
      chip("소셜 발화량", "var(--social)", null, {
        disabled: true,
        title: "네이버 검색 API 키를 등록하면 블로그 일별 게시물 수가 자동 수집됩니다.",
      });
  }
  if (hasIssues && !segList) chip("이슈", "#7a8388", "issues", { dot: true });
}

/* ---------- 상태 ---------- */
let chartObserver = null,
  lastSize = "",
  panStart = null, // 30일 보기의 첫 날짜 인덱스
  panTimer = 0,
  lastNaverYs = null;

function watchChartSize() {
  if (chartObserver || typeof ResizeObserver === "undefined") return;
  chartObserver = new ResizeObserver(() => {
    const el = $("mainChart"),
      size = el.clientWidth + "x" + el.clientHeight;
    if (size === lastSize || !dataset?.models?.length) return;
    lastSize = size;
    requestAnimationFrame(() => mainFlow({ animate: false }));
  });
  chartObserver.observe($("mainChart"));
}

function resetPan() {
  panStart = null;
}

/* ============================================================ */
function mainFlow(opts = {}) {
  const animate = opts.animate !== false && !reduceMotion(),
    root = $("mainChart");
  watchChartSize();
  root.replaceChildren();
  if (!dataset?.dates?.length) return;
  lastSize = root.clientWidth + "x" + root.clientHeight;

  const dates = dataset.dates,
    n = dates.length,
    windowed = days > 0 && n > days,
    W = Math.max(320, root.clientWidth),
    H = Math.max(260, root.clientHeight),
    L = 24,
    R = 24,
    B = 30,
    pw = W - L - R;
  if (windowed) {
    if (panStart == null) panStart = n - days;
    panStart = Math.max(0, Math.min(n - days, panStart));
  }
  const vis0 = windowed ? panStart : 0,
    vis1 = windowed ? panStart + days - 1 : n - 1,
    dayW = pw / Math.max(1, (windowed ? days : n) - 1),
    cx = (k) => L + k * dayW, // 콘텐츠 좌표
    shift = windowed ? -panStart * dayW : 0,
    sx = (k) => cx(k) + shift; // 화면 좌표

  const totals = queryTotals(),
    values = totals.map((t) => t.value),
    visVals = values.slice(vis0, vis1 + 1).filter((v) => v != null),
    allVals = values.filter((v) => v != null),
    match = matchInsight(),
    segList = segMode === "all" ? null : SEGMENTS[segMode],
    aux = segList
      ? []
      : (match?.aux || [])
          .map((a) => ({
            ...a,
            ...(AUX_STYLE[a.id] || { color: a.color, opacity: 0.3, band: 0.3 }),
            vals: dates.map((d) => a.values?.[d] ?? null),
          }))
          .filter((a) => a.vals.some((v) => v != null)),
    pos = new Map(dates.map((d, k) => [d, k])),
    issues = (match?.issues || [])
      .filter((s) => pos.has(s.date))
      .map((s) => ({ ...s, k: pos.get(s.date) }));
  // 급등일 중 관련성 '중' 이상 후보가 있는 날만 이슈로 표시(추정)
  for (const [date, note] of Object.entries(match?.spike_notes || {})) {
    const c = (note.candidates || []).find((x) => /^(강|중)/.test(x.relevance || ""));
    if (!c || !pos.has(date) || issues.some((x) => x.date === date)) continue;
    issues.push({
      date,
      k: pos.get(date),
      title: note.label || c.title.replace(/\s*\(\d+\/\d+\)$/, "").slice(0, 20) + " 여파(추정)",
      summary: note.summary,
      signature: note.signature,
      related: note.candidates.map((x) => ({ title: x.title + " · " + (x.source || ""), url: x.url })),
      url: c.url,
      source: c.source,
    });
  }
  seriesToggles(aux, issues.length > 0, segList);
  const markers = seriesOn.issues !== false && !segList ? issues.sort((a, b) => a.k - b.k) : [];

  // 이슈 라벨 줄 배치(콘텐츠 좌표)
  const laneTop = 68,
    laneH = 27,
    rows = [];
  for (const m of markers) {
    m.label = m.title;
    m.w = Math.min(210, Math.ceil(textWidth(m.label) * 1.06) + 24);
    const minX = windowed ? -1e9 : L + m.w / 2,
      maxX = windowed ? 1e9 : W - R - m.w / 2;
    m.cx = Math.min(Math.max(cx(m.k), minX), maxX);
    let row = rows.findIndex((right) => m.cx - m.w / 2 > right + 8);
    if (row < 0 && rows.length < (W < 700 ? 6 : 4)) row = rows.length;
    if (row < 0) row = rows.indexOf(Math.min(...rows));
    rows[row] = m.cx + m.w / 2;
    m.row = row;
    m.ly = laneTop + row * laneH;
  }
  const T = laneTop + Math.max(1, rows.length) * laneH + 22,
    ph = H - T - B,
    NAV_TOP = T + ph * 0.16,
    NAV_BOT = T + ph * 0.8;

  // 네이버 y: 전체 기간 범위 고정(30일 이동 시에도 높이가 흔들리지 않게)
  const vmin = allVals.length ? Math.min(...allVals) : 0,
    vmax = allVals.length ? Math.max(...allVals) : 1,
    span = Math.max(vmax - vmin, vmax * 0.05, 1),
    lo = vmin - span * 0.04,
    hi = vmax,
    y = (v) => NAV_BOT - ((v - lo) / (hi - lo)) * (NAV_BOT - NAV_TOP);

  const ns = "http://www.w3.org/2000/svg",
    svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "선택 키워드 일별 추정 쿼리수와 보조 지표");
  function add(tag, attrs = {}, text, parent = svg) {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text !== undefined) el.textContent = text;
    parent.append(el);
    return el;
  }
  const defs = add("defs"),
    clip = add("clipPath", { id: "plotClip" }, undefined, defs);
  add("rect", { x: L - 14, y: 0, width: pw + 28, height: H }, undefined, clip);
  const grad = add("linearGradient", { id: "naverFill", x1: 0, y1: 0, x2: 0, y2: 1 }, undefined, defs);
  add("stop", { offset: "0%", "stop-color": "#138b7c", "stop-opacity": 0.22 }, undefined, grad);
  add("stop", { offset: "65%", "stop-color": "#138b7c", "stop-opacity": 0.07 }, undefined, grad);
  add("stop", { offset: "100%", "stop-color": "#138b7c", "stop-opacity": 0 }, undefined, grad);

  const view = add("g", { "clip-path": "url(#plotClip)" }),
    content = add("g", { class: "pan-layer", transform: `translate(${shift},0)` }, undefined, view);
  const g = (cls) => add("g", { class: cls }, undefined, content);
  const gGrid = g("grid"),
    gArea = g("area"),
    gAux = g("aux"),
    gMain = g("main"),
    gIssue = g("issues"),
    gPeak = g("peak");

  /* --- x축 --- */
  const MIN = 40,
    mode = dayW >= MIN ? 1 : dayW * 2 >= MIN ? 2 : dayW * 7 >= MIN ? 7 : dayW * 14 >= MIN ? 14 : 30;
  add("line", { x1: L, x2: W - R, y1: T + ph, y2: T + ph, stroke: "#d5e0da" });
  let lastX = -1e9;
  dates.forEach((d, k) => {
    const wd = weekday(d),
      first = d.endsWith("-01"),
      px = cx(k);
    if (dayW >= 5)
      add("line", { x1: px, x2: px, y1: T + ph, y2: T + ph + (wd === 1 ? 5 : 3), stroke: wd === 0 ? "#e2a8a0" : "#d5e0da" }, undefined, gGrid);
    const take =
      mode === 1 ? true : mode === 2 ? k % 2 === 0 : mode === 7 ? wd === 1 : mode === 14 ? wd === 1 && Math.floor(k / 7) % 2 === 0 : first;
    if (!take && !(first && mode >= 7)) return;
    if (px - lastX < MIN - 6) return;
    lastX = px;
    add("line", { x1: px, x2: px, y1: T, y2: T + ph, stroke: first ? "#e1eae5" : "#f0f4f2" }, undefined, gGrid);
    add(
      "text",
      {
        x: px,
        y: H - 10,
        "text-anchor": !windowed && k === 0 ? "start" : !windowed && k === n - 1 ? "end" : "middle",
        fill: wd === 0 && mode <= 2 ? "#c0675b" : first ? "#3f5a50" : "#7d8e85",
        "font-size": 10.5,
        "font-weight": first ? 700 : 400,
      },
      (first && mode >= 7 ? +d.slice(5, 7) + "월" : md(d)) + (mode === 1 ? "(" + WEEK[wd] + ")" : ""),
      gGrid,
    );
  });

  /* --- 보조 지표: 굵은 반투명 선, 아래쪽 띠 --- */
  const auxShown = aux.filter((a) => seriesOn[a.id] !== false);
  for (const a of auxShown) {
    const av = a.vals.filter((v) => v != null),
      amin = Math.min(...av),
      amax = Math.max(...av),
      apad = Math.max((amax - amin) * 0.06, 1),
      alo = Math.max(0, amin - apad),
      bot = T + ph - 6;
    let top = bot - ph * (a.band || 0.34);
    if (a.id === "google_youtube") {
      // 유튜브 최대일의 값이 네이버 선에 살짝 닿도록
      const km = a.vals.indexOf(amax),
        nv = values[km] ?? hi;
      top = Math.min(y(nv) + 3, bot - ph * 0.3);
    }
    a.ay = (v) => bot - ((v - alo) / (amax - alo || 1)) * (bot - top);
    const path = add(
      "path",
      {
        d: smoothPath(a.vals.map((v, k) => (v == null ? null : [cx(k), a.ay(v)]))),
        fill: "none",
        stroke: a.color,
        "stroke-width": 6.5,
        "stroke-opacity": a.opacity,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        class: animate ? "draw" : "",
      },
      undefined,
      gAux,
    );
    if (animate) drawIn(path, 1100, 120);
  }

  /* --- 메인: 네이버 또는 성·연령 --- */
  const naverPts = values.map((v, k) => (v == null ? null : [cx(k), y(v)]));
  let segLines = null;
  if (!segList) {
    // 그라데이션 영역
    let s0 = -1;
    naverPts.forEach((p, k) => {
      if (p && s0 < 0) s0 = k;
      if ((!p || k === n - 1) && s0 >= 0) {
        const e = p ? k : k - 1;
        if (e > s0) {
          const area = add(
            "path",
            { d: smoothPath(naverPts.slice(s0, e + 1)) + `L${cx(e)},${T + ph}L${cx(s0)},${T + ph}Z`, fill: "url(#naverFill)" },
            undefined,
            gArea,
          );
          if (animate) area.classList.add("fade-in");
        }
        s0 = -1;
      }
    });
    const line = add(
      "path",
      { d: smoothPath(naverPts), fill: "none", stroke: "#0f7f70", "stroke-width": 6.5, "stroke-opacity": 0.82, "stroke-linecap": "round", "stroke-linejoin": "round" },
      undefined,
      gMain,
    );
    const naverYs = values.map((v) => (v == null ? null : y(v)));
    if (animate && prevSeg) mergeInto(prevSeg, naverYs, line, gMain, gArea, cx);
    else if (animate) drawIn(line, 1000, 0);
    prevSeg = null;
  } else {
    const baseYs = values.map((v) => (v == null ? null : y(v))); // 갈라지는 출발점 = 네이버 선
    const sers = segList.map((s) => ({ ...s, vals: segmentSeries(s.id) }));
    for (const se of sers) {
      const ok = se.vals.filter((v) => v != null);
      se.mean = ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : 0;
      se.rel = se.vals.map((v) => (v == null || !se.mean ? null : v / se.mean));
      se.max = ok.length ? Math.max(...ok) : 1;
    }
    if (!sers.some((se) => se.mean))
      add("text", { x: L + pw / 2, y: T + ph / 2, "text-anchor": "middle", fill: "#7d8e85", "font-size": 13 }, "선택한 키워드에 성·연령 지수가 충분하지 않습니다.");
    if (segMode === "gender") {
      // 성별: 공통 축의 두 선
      const sv = sers.flatMap((se) => se.rel).filter((v) => v != null),
        smin = Math.min(...sv),
        smax = Math.max(...sv),
        sy = (v) => NAV_BOT - ((v - smin) / (smax - smin || 1)) * (NAV_BOT - NAV_TOP);
      segLines = sers.map((se) => {
        const to = se.rel.map((v) => (v == null ? null : sy(v))),
          path = add("path", { fill: "none", stroke: se.color, "stroke-width": 5.5, "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-opacity": 0.9 }, undefined, gMain);
        morphPath(path, cx, animate ? baseYs : null, to, animate ? 850 : 0);
        return { ...se, to };
      });
      prevSeg = { mode: "gender", lines: segLines.map((l) => ({ color: l.color, ys: l.to })) };
    } else {
      // 연령: 하루 추정 쿼리를 집단 비율×집단별 상대 추이로 나눈 누적 막대
      const share = getShares("age"),
        tot = values.map((v) => v ?? 0),
        maxTot = Math.max(1, ...values.slice(vis0, vis1 + 1).filter((v) => v != null)),
        maxAll = Math.max(1, ...values.filter((v) => v != null)),
        yz = (v) => T + ph - (v / maxAll) * (T + ph - NAV_TOP),
        bw = Math.max(2, Math.min(30, dayW * 0.78)),
        rects = [];
      segLines = sers.map((se) => ({ ...se, parts: new Array(n).fill(null) }));
      for (let k = 0; k < n; k++) {
        if (values[k] == null) continue;
        const wts = segLines.map((se) => (se.rel[k] == null ? 0 : share.v[se.id] * se.rel[k])),
          sum = wts.reduce((a, b) => a + b, 0);
        if (!sum) continue;
        let acc = 0;
        segLines.forEach((se, j) => {
          const part = (tot[k] * wts[j]) / sum;
          se.parts[k] = part;
          const bot = yz(acc),
            top = yz(acc + part);
          acc += part;
          const r = add("rect", { x: cx(k) - bw / 2, width: bw, y: top, height: Math.max(0, bot - top), fill: se.color, "shape-rendering": "crispEdges" }, undefined, gMain);
          (se.mid ||= new Array(n).fill(null))[k] = (top + bot) / 2;
          rects.push({ el: r, k, color: se.color, x: cx(k) - bw / 2, w: bw, top, bot, fromTop: baseYs[k] ?? top, fromBot: baseYs[k] ?? bot });
        });
      }
      segLines.share = share;
      if (animate) tweenRects(rects, "split", 900);
      // 연령별 추세선: 각 칸의 가운데 높이를 얇게 이음
      const trendLines = segLines.map((se) => {
        const ys = se.mid || new Array(n).fill(null),
          path = add("path", { fill: "none", stroke: se.line, "stroke-width": 1.6, "stroke-opacity": 0.9, "stroke-linejoin": "round", "stroke-linecap": "round" }, undefined, gMain);
        morphPath(path, cx, animate ? baseYs : null, ys, animate ? 900 : 0);
        return { color: se.line, ys, width: 1.6 };
      });
      prevSeg = { mode: "age", lines: trendLines, rects: rects.map((r) => ({ k: r.k, x: r.x, w: r.w, color: r.color, top: r.top, bot: r.bot })) };
      void maxTot;
    }
  }

  /* --- 최고점(보이는 구간의 네이버 최대값만, 함축 표기) --- */
  if (!segList && visVals.length) {
    const top = Math.max(...visVals),
      k = values.findIndex((v, i) => i >= vis0 && i <= vis1 && v === top),
      px = cx(k),
      py = y(top),
      text = "최고 " + compactNumber(top) + " · " + md(dates[k]),
      tw = textWidth(text, "700 12px sans-serif") + 16,
      screenX = px + shift,
      bx = screenX + tw + 16 > W - R ? px - tw - 12 : px + 12;
    add("circle", { cx: px, cy: py, r: 6, fill: "#fff", stroke: "#0f7f70", "stroke-width": 3 }, undefined, gPeak);
    add("rect", { x: bx, y: py - 12, width: tw, height: 24, rx: 12, fill: "#0f7f70" }, undefined, gPeak);
    add("text", { x: bx + tw / 2, y: py + 4.5, "text-anchor": "middle", fill: "#fff", "font-size": 12, "font-weight": 700 }, text, gPeak);
    if (animate) gPeak.classList.add("pop-in");
  } else if (!segList && !allVals.length)
    add("text", { x: L + pw / 2, y: T + ph / 2, "text-anchor": "middle", fill: "#7d8e85", "font-size": 13 }, chosen().length ? "이 기간의 쿼리 추정치를 확보하지 못했습니다." : "필터에서 키워드를 하나 이상 선택하세요.");

  /* --- 이슈 마커: 무채색 점선 --- */
  markers.forEach((m, idx) => {
    const v = segList ? null : values[m.k],
      px = cx(m.k),
      py = v == null ? T + ph * 0.5 : y(v),
      gm = add("g", { class: "issue-marker" + (animate ? " drop-in" : ""), style: animate ? `animation-delay:${450 + idx * 90}ms` : "" }, undefined, gIssue),
      bottom = m.ly + 22;
    add("path", { d: `M${m.cx},${bottom}L${m.cx},${bottom + 6}L${px},${Math.min(py - 12, bottom + 20)}L${px},${py - 10}`, fill: "none", stroke: "#9aa3a8", "stroke-width": 1.3, "stroke-dasharray": "3 3" }, undefined, gm);
    if (v != null)
      add("circle", { cx: px, cy: py, r: 8, fill: "rgba(255,255,255,.6)", stroke: "#7a8388", "stroke-width": 1.8, "stroke-dasharray": "3 2" }, undefined, gm);
    const pill = add("g", { class: "issue-pill", tabindex: 0, role: "button", "aria-label": m.label }, undefined, gm);
    add("rect", { x: m.cx - m.w / 2, y: m.ly, width: m.w, height: 22, rx: 11 }, undefined, pill);
    add("text", { x: m.cx, y: m.ly + 15, "text-anchor": "middle" }, m.label.length > 26 ? m.label.slice(0, 25) + "…" : m.label, pill);
    m.el = pill;
  });

  /* --- 호버 --- */
  const line = add("line", { x1: 0, x2: 0, y1: T, y2: T + ph, stroke: "#a0b8ad", "stroke-dasharray": "4 4", visibility: "hidden" }),
    dot = add("circle", { r: 5.5, fill: "#0f7f70", stroke: "#fff", "stroke-width": 2, visibility: "hidden" }),
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
      "aria-valuemax": n - 1,
    }),
    tip = document.createElement("div");
  tip.className = "tooltip flow-tooltip";
  tip.hidden = true;
  // 이슈 라벨이 호버 영역 위에 오도록
  svg.append(view, line, dot);
  line.style.pointerEvents = dot.style.pointerEvents = "none";
  let cur = vis1;
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
    cur = Math.max(vis0, Math.min(vis1, k));
    const px = sx(cur);
    line.setAttribute("x1", px);
    line.setAttribute("x2", px);
    line.setAttribute("visibility", "visible");
    tip.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = dates[cur] + " (" + WEEK[weekday(dates[cur])] + ")";
    tip.append(title);
    if (segList) {
      dot.setAttribute("visibility", "hidden");
      const note = document.createElement("div");
      note.className = "issue-line";
      if (segMode === "age") {
        const sumP = segLines.reduce((a, se) => a + (se.parts[cur] || 0), 0);
        for (const se of [...segLines].reverse()) {
          const p = se.parts[cur];
          tip.append(
            row(se.color, se.name, p == null ? "–" : segLines.share.provided ? "약 " + fmt(p) + "건" : Math.round((p / sumP) * 100) + "%"),
          );
        }
        note.textContent = segLines.share.provided
          ? "입력한 연령 비율 × 연령별 상대 추이로 나눈 추정치"
          : "연령 비율 미입력: 같은 비율 가정 · 그날의 상대 비중";
      } else {
        for (const se of segLines) {
          const v = se.rel[cur];
          tip.append(row(se.color, se.name, v == null ? "–" : "평소의 " + Math.round(v * 100) + "%"));
        }
        note.textContent = "집단별 기간 평균=100% 기준 상대 추이";
      }
      tip.append(note);
    } else {
      const v = values[cur];
      if (v != null) {
        dot.setAttribute("cx", px);
        dot.setAttribute("cy", y(v));
        dot.setAttribute("visibility", "visible");
      } else dot.setAttribute("visibility", "hidden");
      tip.append(row("#6ed0b5", "네이버 추정 쿼리", v == null ? "미확보" : fmt(v) + "건"));
      for (const a of auxShown) tip.append(row(a.color, a.name + " 지수", a.vals[cur] == null ? "–" : String(a.vals[cur])));
    }
    const near = markers.find((m) => m.k === cur);
    if (near) {
      const p = document.createElement("div");
      p.className = "issue-line";
      p.textContent = "● " + near.title;
      tip.append(p);
    }
    tip.hidden = false;
    const tw = tip.offsetWidth || 220;
    tip.style.left = Math.max(4, px + 16 + tw > W ? px - 16 - tw : px + 16) + "px";
    tip.style.top = T + 6 + "px";
    overlay.setAttribute("aria-valuenow", cur);
    overlay.setAttribute("aria-valuetext", dates[cur]);
  }
  const hide = () => {
    tip.hidden = true;
    line.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
  };
  overlay.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect(),
      px = ((e.clientX - r.left) / r.width) * W;
    show(Math.round((px - L - shift) / dayW));
  });
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

  /* --- 이슈 상세 카드 --- */
  let card = null,
    hideTimer = 0;
  const closeCard = () => {
    card?.remove();
    card = null;
    root.querySelectorAll(".issue-pill.active").forEach((el) => el.classList.remove("active"));
  };
  const scheduleClose = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(closeCard, 220);
  };
  function link(href, text) {
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = text;
    return a;
  }
  function openCard(m) {
    clearTimeout(hideTimer);
    closeCard();
    m.el.classList.add("active");
    card = document.createElement("div");
    card.className = "issue-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", m.title);
    const date = document.createElement("div"),
      strong = document.createElement("strong"),
      p = document.createElement("p"),
      meta = document.createElement("div");
    date.className = "date";
    date.textContent = dates[m.k] + " (" + WEEK[weekday(dates[m.k])] + ")";
    strong.textContent = m.title;
    p.textContent = m.summary || "";
    meta.className = "meta";
    if (m.url) meta.append(link(m.url, (m.source || "기사") + " 원문 보기 ↗"));
    else if (m.source) meta.append(m.source);
    card.append(date, strong, p);
    if (m.signature) {
      const sg = document.createElement("div"),
        sgv = m.signature;
      sg.className = "sig";
      sg.textContent =
        "급등 유형 · " + sgv.type + " — 같은 요일 대비 모바일 ×" + sgv.mo + " · PC ×" + sgv.pc + " · 남 ×" + sgv.male + " · 여 ×" + sgv.female;
      card.append(sg);
    }
    card.append(meta);
    const rel = (m.related || []).filter((r) => r.url !== m.url);
    if (rel.length) {
      const ul = document.createElement("ul");
      ul.className = "cands";
      for (const r of rel.slice(0, 4)) {
        const li = document.createElement("li");
        li.append(link(r.url, r.title));
        ul.append(li);
      }
      card.append(ul);
    }
    root.append(card);
    const cw = card.offsetWidth,
      mx = m.cx + shift;
    card.style.left = Math.min(Math.max(4, mx - cw / 2), W - cw - 4) + "px";
    card.style.top = m.ly + 28 + "px";
    card.addEventListener("pointerenter", () => clearTimeout(hideTimer));
    card.addEventListener("pointerleave", scheduleClose);
  }
  for (const m of markers) {
    m.el.addEventListener("pointerenter", () => openCard(m));
    m.el.addEventListener("pointerleave", scheduleClose);
    m.el.addEventListener("focus", () => openCard(m));
    m.el.addEventListener("blur", scheduleClose);
    m.el.addEventListener("click", () => openCard(m));
    m.el.addEventListener("keydown", (e) => e.key === "Escape" && closeCard());
  }

  /* --- 30일 보기: 휠·화살표로 좌우 이동 --- */
  if (windowed) {
    const mk = (dir) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pan-btn " + (dir < 0 ? "left" : "right");
      b.textContent = dir < 0 ? "‹" : "›";
      b.setAttribute("aria-label", dir < 0 ? "이전 기간으로 이동" : "다음 기간으로 이동");
      b.disabled = dir < 0 ? panStart <= 0 : panStart >= n - days;
      b.style.top = T + ph / 2 + "px";
      b.onclick = () => panBy(dir * 7);
      root.append(b);
    };
    mk(-1);
    mk(1);
    let wheelAcc = 0;
    root.onwheel = (e) => {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d) return;
      const atEdge = (d < 0 && panStart <= 0) || (d > 0 && panStart >= n - days);
      if (atEdge) return; // 끝에 닿으면 페이지 스크롤 허용
      e.preventDefault();
      wheelAcc += d;
      const step = Math.trunc(wheelAcc / 60);
      if (step) {
        wheelAcc -= step * 60;
        panBy(step * 2, true);
      }
    };
  } else root.onwheel = null;

  function panBy(dd, quick = false) {
    const next = Math.max(0, Math.min(n - days, panStart + dd));
    if (next === panStart) return;
    panStart = next;
    hide();
    closeCard();
    const t = -panStart * dayW;
    content.style.transition = reduceMotion() ? "none" : `transform ${quick ? 220 : 420}ms cubic-bezier(.22,.8,.3,1)`;
    content.style.transform = `translate(${t}px,0)`;
    root.querySelectorAll(".pan-btn").forEach((b) => {
      b.disabled = b.classList.contains("left") ? panStart <= 0 : panStart >= n - days;
    });
    clearTimeout(panTimer);
    panTimer = setTimeout(() => mainFlow({ animate: false }), quick ? 260 : 460);
  }

  /* --- 하단 설명 --- */
  const basis = auxShown.map((a) => a.name + ": " + a.basis).join(" / "),
    status = !insights
      ? ""
      : !match
        ? " 이 분석의 이슈·보조 지표는 자동 수집 대기 중입니다(새 분석 후 최대 30분)."
        : " 이슈 출처: " + (match.sources || []).join(", ") + ".";
  $("flowFoot").textContent = segMode === "age"
    ? (getShares("age").provided
        ? "연령별 막대는 입력한 연령 비율과 연령별 상대 추이로 하루 추정 쿼리를 나눈 추정치입니다."
        : "연령 비율을 입력하지 않아 6개 집단을 같은 비율로 가정하고, 집단별 상대 추이로 하루 추정 쿼리를 나눈 모양입니다. 실제 연령 구성이 아니며, 범례의 '연령 비율 입력'에 광고시스템 키워드 도구의 비율을 넣으면 추정 건수로 바뀝니다.")
    : segList
    ? "성·연령별 선은 네이버가 집단마다 따로 정규화한 지수를 키워드 월간 검색수로 가중 합산한 상대 추이입니다. 집단별 실제 검색 건수가 아니며, 같은 축에서 오르내림의 크기만 비교하세요."
    : "굵은 선은 선택한 키워드의 일별 추정 쿼리 합계입니다. 세로 범위는 기간 최저~최고에 맞춰 확대되어 있으니 값은 그래프에 마우스를 올려 확인하세요." +
      (basis ? " 보조 지표는 각자의 축에 그린 상대 지수로 추이만 비교합니다 — " + basis + "." : "") +
      (windowed ? " 30일 보기에서는 마우스 휠이나 좌우 버튼으로 기간을 옮길 수 있습니다." : "") +
      status;
}

/* ---------- 연령 비율(광고시스템 키워드 도구 값 입력) ---------- */
let prevSeg = null;
const shareKey = () => "nq-share-" + (dataset?.job_id || dataset?.collected_at || "");
function getShares(mode) {
  const list = SEGMENTS[mode],
    eq = Object.fromEntries(list.map((s) => [s.id, 1 / list.length]));
  try {
    const saved = JSON.parse(localStorage.getItem(shareKey()) || "{}")[mode];
    if (saved) {
      const sum = list.reduce((a, s) => a + (+saved[s.id] || 0), 0);
      if (sum > 0)
        return { provided: true, v: Object.fromEntries(list.map((s) => [s.id, (+saved[s.id] || 0) / sum])) };
    }
  } catch {}
  return { provided: false, v: eq };
}
function openSharePop(anchor) {
  document.querySelector(".share-pop")?.remove();
  const pop = document.createElement("div"),
    list = SEGMENTS.age,
    cur = getShares("age");
  pop.className = "share-pop card";
  pop.innerHTML =
    "<strong>연령 비율(%)</strong><p class='hint'>네이버 광고시스템 › 키워드 도구에서 이 키워드들의 연령별 비율을 입력하세요. 합계는 자동으로 100%로 맞춥니다.</p>";
  for (const s of list) {
    const l = document.createElement("label"),
      i = document.createElement("input");
    i.type = "number";
    i.min = 0;
    i.step = 0.1;
    i.name = s.id;
    i.value = cur.provided ? Math.round(cur.v[s.id] * 1000) / 10 : "";
    i.placeholder = "%";
    l.append(s.name, i);
    pop.append(l);
  }
  const act = document.createElement("div"),
    reset = document.createElement("button"),
    save = document.createElement("button");
  act.className = "actions";
  reset.className = "text-button";
  reset.textContent = "초기화(같은 비율)";
  save.className = "primary";
  save.textContent = "적용";
  act.append(reset, save);
  pop.append(act);
  const store = (val) => {
    try {
      const all = JSON.parse(localStorage.getItem(shareKey()) || "{}");
      if (val) all.age = val;
      else delete all.age;
      localStorage.setItem(shareKey(), JSON.stringify(all));
    } catch {}
    pop.remove();
    mainFlow({ animate: true });
  };
  reset.onclick = () => store(null);
  save.onclick = () => {
    const val = {};
    pop.querySelectorAll("input").forEach((i) => (val[i.name] = +i.value || 0));
    store(Object.values(val).some((v) => v > 0) ? val : null);
  };
  anchor.closest(".head-tools").append(pop);
  pop.querySelector("input")?.focus();
  const off = (e) => {
    if (!pop.contains(e.target) && e.target !== anchor) {
      pop.remove();
      document.removeEventListener("pointerdown", off);
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", off), 0);
}

/* 성·연령 → 합계: 선/막대가 네이버 선으로 합쳐짐 */
function mergeInto(prev, naverYs, line, gMain, gArea, cx) {
  const ns = "http://www.w3.org/2000/svg",
    tmp = document.createElementNS(ns, "g");
  gMain.insertBefore(tmp, line);
  line.style.opacity = 0;
  gArea.style.opacity = 0;
  const done = () => {
    tmp.remove();
    line.style.transition = "opacity .35s ease";
    gArea.style.transition = "opacity .6s ease";
    line.style.opacity = 1;
    gArea.style.opacity = 1;
  };
  if (prev.mode === "gender") {
    prev.lines.forEach((l, i) => {
      const p = document.createElementNS(ns, "path");
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", l.color);
      p.setAttribute("stroke-width", 5.5);
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-opacity", 0.9);
      tmp.append(p);
      morphPath(p, cx, l.ys, naverYs, 750, i === 0 ? done : null);
    });
  } else {
    const rects = prev.rects.map((r) => {
      const el = document.createElementNS(ns, "rect");
      el.setAttribute("x", r.x);
      el.setAttribute("width", r.w);
      el.setAttribute("fill", r.color);
      el.setAttribute("shape-rendering", "crispEdges");
      el.setAttribute("y", r.top);
      el.setAttribute("height", Math.max(0, r.bot - r.top));
      tmp.append(el);
      const ny = naverYs[r.k] ?? r.top;
      return { el, fromTop: ny, fromBot: ny, top: r.top, bot: r.bot };
    });
    for (const l of prev.lines || []) {
      const p = document.createElementNS(ns, "path");
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", l.color);
      p.setAttribute("stroke-width", l.width || 1.6);
      tmp.append(p);
      morphPath(p, cx, l.ys, naverYs, 750);
    }
    tweenRects(rects, "merge", 750, done);
  }
}
/* 누적 막대 갈라짐(split: 선 위치 → 막대) / 합쳐짐(merge: 막대 → 선 위치) */
function tweenRects(rects, dir, ms, done) {
  const t0 = performance.now(),
    ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const apply = (e) => {
    for (const r of rects) {
      const a = dir === "split" ? e : 1 - e,
        top = r.fromTop + (r.top - r.fromTop) * a,
        bot = r.fromBot + (r.bot - r.fromBot) * a;
      r.el.setAttribute("y", Math.min(top, bot));
      r.el.setAttribute("height", Math.abs(bot - top));
    }
  };
  apply(0);
  const frame = (now) => {
    if (!rects[0]?.el.isConnected) return done?.();
    const t = Math.min(1, (now - t0) / ms);
    apply(ease(t));
    if (t < 1) requestAnimationFrame(frame);
    else done?.();
  };
  requestAnimationFrame(frame);
}

/* ---------- 애니메이션 ---------- */
function drawIn(path, ms, delay) {
  try {
    const len = path.getTotalLength();
    if (!len) return;
    path.style.strokeDasharray = len;
    path.style.strokeDashoffset = len;
    path.getBoundingClientRect();
    path.style.transition = `stroke-dashoffset ${ms}ms cubic-bezier(.45,.05,.2,1) ${delay}ms`;
    requestAnimationFrame(() => (path.style.strokeDashoffset = 0));
    setTimeout(() => {
      path.style.strokeDasharray = "";
      path.style.transition = "";
    }, ms + delay + 50);
  } catch {}
}
/* from(y 배열) → to(y 배열)로 선 모양을 보간 */
function morphPath(path, cx, from, to, ms, done) {
  const build = (ys) => smoothPath(ys.map((v, k) => (v == null ? null : [cx(k), v])));
  if (!ms || !from) {
    path.setAttribute("d", build(to));
    if (ms) drawIn(path, ms, 0);
    done?.();
    return;
  }
  const t0 = performance.now(),
    ease = (t) => 1 - Math.pow(1 - t, 3);
  const frame = (now) => {
    if (!path.isConnected) return;
    const t = Math.min(1, (now - t0) / ms),
      e = ease(t);
    path.setAttribute(
      "d",
      build(to.map((v, k) => (v == null ? null : from[k] == null ? v : from[k] + (v - from[k]) * e))),
    );
    if (t < 1) requestAnimationFrame(frame);
    else done?.();
  };
  requestAnimationFrame(frame);
}
