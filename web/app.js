"use strict";
const $ = (id) => document.getElementById(id),
  key = (v) => String(v).normalize("NFKC").replace(/\s+/g, "").toUpperCase(),
  fmt = (n) => Math.round(n).toLocaleString("ko-KR"),
  colors = [
    "#238a7e",
    "#627fd0",
    "#d28a54",
    "#9e79b9",
    "#be728e",
    "#84a15e",
    "#658d9c",
    "#b6a05f",
  ];
let dataset = null,
  groups = [],
  selected = new Set(),
  days = 0,
  busy = false,
  recommending = false,
  suggestUndo = null,
  currentJob = null,
  pendingAction = null,
  quota = null,
  trendFocus = "",
  valueCache = new Map();
function toast(message) {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 7000);
}
async function api(path, body) {
  const base = (window.NAVER_API_BASE || "").replace(/\/$/, "");
  let res = await fetch(
      base + path,
      body === undefined
        ? { cache: "no-store", credentials: "omit" }
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            credentials: "omit",
          },
    ),
    d;
  try {
    d = await res.json();
  } catch {
    throw Error("서버 응답을 읽지 못했습니다. 잠시 후 다시 시도하세요.");
  }
  if (!res.ok) throw Error(d.error || "요청 실패");
  return d;
}
function words(value) {
  return [
    ...new Map(
      String(value)
        .split(/[,\n]+/)
        .map((s) => s.normalize("NFKC").replace(/\s+/g, ""))
        .filter(Boolean)
        .map((s) => [key(s), s]),
    ).values(),
  ];
}
function cleanDraft() {
  const ws = words($("keywords").value);
  return ws.length
    ? [
        {
          id: "analysis",
          name: $("brandName").value.trim() || "전체 키워드",
          keywords: ws,
          color: colors[0],
        },
      ]
    : [];
}
function draftValid() {
  const gs = cleanDraft(),
    n = new Set(gs.flatMap((g) => g.keywords.map(key))).size,
    a = $("startDate").value,
    b = $("endDate").value,
    len = Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1,
    today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }),
    valid =
      gs.length > 0 &&
      gs.length <= 20 &&
      gs.every((g) => g.name && g.name.length <= 40 && g.keywords.length) &&
      n > 0 &&
      n <= 100 &&
      a >= "2016-01-01" &&
      b < today &&
      len >= 1 &&
      len <= 366;
  return { gs, n, a, b, len, valid, cost: Math.ceil(n / 5) * 23 };
}
function estimateBudget() {
  const v = draftValid();
  $("inputCount").textContent = v.n + "개 키워드 · 중복 제외";
  $("expectedBudget").textContent = v.valid
    ? "Budget " + v.cost + "건 사용 예상"
    : "그룹·키워드와 올바른 날짜를 입력하세요.";
  $("extract").disabled = busy || recommending || !v.valid;
  $("recommendKeywords").disabled =
    busy || recommending || !$("brandName").value.trim();
  $("dateHint").textContent =
    Number.isFinite(v.len) && v.a && v.b
      ? v.len + "일 선택 · 최대 366일 · 종료일은 어제까지"
      : "종료일은 어제까지 · 최대 366일";
  $("dateHint").classList.toggle(
    "error",
    !!v.a && !!v.b && (v.len < 1 || v.len > 366),
  );
  return v;
}
function setDraft(gs) {
  suggestUndo = null;
  $("undoRecommend").hidden = true;
  $("recommendStatus").textContent =
    "네이버 연관 키워드 최대 30개 · 추천 후 직접 수정할 수 있습니다.";
  $("brandName").value = gs.length === 1 ? gs[0].name : "전체 키워드";
  $("keywords").value = [...new Set(gs.flatMap((g) => g.keywords))].join("\n");
  estimateBudget();
}
function normalized(v = []) {
  const max = v.reduce((a, b) => Math.max(a, b ?? 0), 0);
  return v.map((x) => (x == null ? null : max ? (x / max) * 100 : 0));
}
function anchorEnd(m, data = dataset) {
  if (m.calibration?.end_date) return m.calibration.end_date;
  if (m.collected_at) {
    const t = new Date(m.collected_at);
    if (!Number.isNaN(+t))
      return new Date(
        Date.parse(t.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" })) -
          86400000,
      )
        .toISOString()
        .slice(0, 10);
  }
  return data.calibration?.anchor_end || data.end_date;
}
function deviceEstimates(m, data = dataset) {
  let c = m.calibration,
    pc = c?.pc,
    mo = c?.mo;
  if (!c) {
    const end = anchorEnd(m, data),
      ix = data.dates
        .map((d, i) => ({ d, i }))
        .filter((x) => x.d <= end)
        .slice(-30);
    pc = ix.map((x) => m.series?.pc?.[x.i] ?? null);
    mo = ix.map((x) => m.series?.mo?.[x.i] ?? null);
  }
  const sum = (a) => (a || []).reduce((s, v) => s + (v ?? 0), 0),
    ps = sum(pc),
    ms = sum(mo),
    valid =
      pc?.length === 30 &&
      mo?.length === 30 &&
      !pc.some((v) => v == null) &&
      !mo.some((v) => v == null) &&
      ps > 0 &&
      ms > 0 &&
      typeof m.pc === "number" &&
      typeof m.mobile === "number";
  return data.dates.map((_, i) =>
    valid && m.series?.pc?.[i] != null && m.series?.mo?.[i] != null
      ? {
          pc: (m.series.pc[i] / ps) * m.pc,
          mo: (m.series.mo[i] / ms) * m.mobile,
        }
      : null,
  );
}
function estimates(m, data = dataset) {
  if (data === dataset && valueCache.has(key(m.keyword)))
    return valueCache.get(key(m.keyword));
  const v = deviceEstimates(m, data).map((x) => (x ? x.pc + x.mo : null));
  if (data === dataset) valueCache.set(key(m.keyword), v);
  return v;
}
function chosen() {
  return dataset?.models.filter((m) => selected.has(key(m.keyword))) || [];
}
function subset(g, onlySelected = true) {
  const set = new Set(g.keywords.map(key));
  return (onlySelected ? chosen() : dataset.models).filter((m) =>
    set.has(key(m.keyword)),
  );
}
function ix() {
  let a = dataset.dates.map((date, i) => ({ date, i }));
  return days ? a.slice(-days) : a;
}
function button(text, action, active = false) {
  let b = document.createElement("button");
  b.textContent = text;
  b.classList.toggle("active", active);
  b.setAttribute("aria-pressed", String(active));
  b.onclick = action;
  return b;
}
function legend(id, series) {
  $(id).replaceChildren();
  series.forEach((s) => {
    let span = document.createElement("span"),
      dot = document.createElement("i");
    dot.className = "dot";
    dot.style.background = s.color;
    span.append(dot, document.createTextNode(s.name));
    $(id).append(span);
  });
}
function adopt(data, gs, label = "현재 결과") {
  dataset = {
    ...data,
    analysis: { brand: data.analysis?.brand || "전체 키워드" },
  };
  groups = [
    {
      id: "analysis",
      name:
        data.analysis?.brand || (gs.length === 1 ? gs[0].name : "전체 키워드"),
      color: colors[0],
      keywords: data.models.map((m) => m.keyword),
    },
  ];
  gs = groups;
  valueCache.clear();
  selected = new Set(data.models.map((m) => key(m.keyword)));
  trendFocus = groups[0]?.id || "";
  days = 0;
  setDraft(gs);
  $("startDate").value = data.start_date;
  $("endDate").value = data.end_date;
  estimateBudget();
  $("results").hidden = !data.models.length;
  $("empty").hidden = !!data.models.length;
  $("resultBadge").textContent = label;
  render();
}
function filters() {
  $("selectionRows").replaceChildren();
  const rows = [...groups],
    grouped = new Set(rows.flatMap((g) => g.keywords.map(key))),
    others = dataset.models.filter((m) => !grouped.has(key(m.keyword)));
  if (others.length)
    rows.push({
      id: "ungrouped",
      name: "미분류",
      keywords: others.map((m) => m.keyword),
      color: "#9aaba0",
    });
  rows.forEach((g) => {
    const members = subset(g, false),
      tr = document.createElement("tr"),
      th = document.createElement("th"),
      td = document.createElement("td"),
      on =
        members.length > 0 &&
        members.every((m) => selected.has(key(m.keyword))),
      groupButton = button(
        g.name,
        () => {
          for (const m of members)
            on ? selected.delete(key(m.keyword)) : selected.add(key(m.keyword));
          if (g.id !== "ungrouped") {
            trendFocus = g.id;
          }
          render();
        },
        on,
      );
    groupButton.className = "group-select" + (on ? " active" : "");
    groupButton.style.setProperty("--group-color", g.color);
    let small = document.createElement("small");
    small.textContent = members.length + "개 키워드";
    groupButton.append(small);
    th.append(groupButton);
    let pills = document.createElement("div");
    pills.className = "pills";
    members.forEach((m) =>
      pills.append(
        button(
          m.keyword,
          () => {
            selected.has(key(m.keyword))
              ? selected.delete(key(m.keyword))
              : selected.add(key(m.keyword));
            if (g.id !== "ungrouped") trendFocus = g.id;
            render();
          },
          selected.has(key(m.keyword)),
        ),
      ),
    );
    td.append(pills);
    tr.append(th, td);
    $("selectionRows").append(tr);
  });
  $("filterSummary").textContent =
    selected.size +
    " / " +
    dataset.models.length +
    "개 키워드 선택 · " +
    groups.length +
    "개 그룹";
  $("selectionHint").textContent =
    selected.size +
    "개 키워드 선택 · 세부 그래프에 반영 · 메인 일별 흐름은 전체 키워드 합계";
}
function deviceColumns() {
  const el = $("deviceColumns");
  el.replaceChildren();
  const index = ix(),
    ms = chosen().map((m) => {
      const values = deviceEstimates(m).filter(
        (v, i) => index.some((x) => x.i === i) && v,
      );
      return {
        ...m,
        pc: values.length ? values.reduce((s, v) => s + v.pc, 0) : null,
        mobile: values.length ? values.reduce((s, v) => s + v.mo, 0) : null,
      };
    }),
    max = Math.max(1, ...ms.map((m) => (m.pc == null ? 0 : m.pc + m.mobile)));
  for (const m of ms) {
    const col = document.createElement("div"),
      zone = document.createElement("div"),
      stack = document.createElement("div"),
      pc = document.createElement("div"),
      mo = document.createElement("div"),
      total = document.createElement("span"),
      label = document.createElement("div"),
      n = m.pc == null ? null : m.pc + m.mobile,
      height = n == null ? 0 : (n / max) * 195;
    col.className = "device-column";
    zone.className = "stack-zone";
    stack.className = "stack";
    stack.style.height = height + "px";
    pc.className = "pc";
    mo.className = "mo";
    pc.style.height = (n ? (m.pc / n) * 100 : 0) + "%";
    mo.style.height = (n ? (m.mobile / n) * 100 : 0) + "%";
    stack.title =
      "기간 추정 PC " +
      (m.pc == null ? "미확보" : fmt(m.pc)) +
      " · MO " +
      (m.mobile == null ? "미확보" : fmt(m.mobile));
    stack.append(pc, mo);
    total.className = "column-total";
    total.style.bottom = height + 5 + "px";
    total.textContent = n == null ? "미확보" : fmt(n);
    label.className = "column-label";
    label.textContent = m.keyword;
    zone.append(stack, total);
    col.append(zone, label);
    el.append(col);
  }
  if (!ms.length) el.textContent = "키워드를 선택하세요.";
}
function setOptions(id, items, current) {
  $(id).replaceChildren();
  items.forEach((o) => {
    let el = document.createElement("option");
    el.value = o.value;
    el.textContent = o.text;
    $(id).append(el);
  });
  $(id).value = items.some((i) => i.value === current)
    ? current
    : items[0]?.value || "";
  return $(id).value;
}
function render() {
  if (!dataset?.models.length) return;
  filters();
  deviceColumns();
  $("resultDate").textContent =
    dataset.start_date +
    " ~ " +
    dataset.end_date +
    " · " +
    dataset.models.length +
    "개 키워드 · " +
    new Date(dataset.collected_at).toLocaleString("ko-KR", {
      timeZone: "Asia/Seoul",
      hour12: false,
    }) +
    " 저장";
  document
    .querySelectorAll("#periods button")
    .forEach((b) =>
      b.classList.toggle("active", Number(b.dataset.days) === days),
    );
  mainFlow();
  trendChart();
}
function trendChart() {
  if (!dataset) return;
  const members = chosen(),
    index = ix(),
    series = members.map((m, j) => ({
      name: m.keyword,
      color: colors[j % colors.length],
      values: index.map(({ i }) => estimates(m)[i]),
    }));
  legend("trendLegend", series);
  plot(
    "trendChart",
    index.map((x) => x.date),
    series,
    "건",
  );
  $("trendFoot").textContent =
    "선택 키워드의 일별 환산 추정 쿼리수 · 증감률이나 차분을 사용하지 않습니다.";
}
function plot(id, dates, series, unit) {
  let root = $(id);
  root.replaceChildren();
  const vals = series
    .flatMap((s) => s.values)
    .filter((v) => v != null && Number.isFinite(v));
  if (!vals.length) {
    let e = document.createElement("div");
    e.className = "empty";
    e.textContent = "선택한 대상·기간에 표시할 데이터가 없습니다.";
    root.append(e);
    return;
  }
  const W = 800,
    H = 260,
    L = 53,
    R = 18,
    T = 23,
    B = 33,
    pw = W - L - R,
    ph = H - T - B,
    rawMin = Math.min(0, ...vals),
    rawMax = Math.max(1, ...vals),
    scale = 10 ** Math.floor(Math.log10((rawMax - rawMin) / 4)),
    step = Math.ceil((rawMax - rawMin) / 4 / scale) * scale,
    min = Math.floor(rawMin / step) * step,
    max = Math.ceil(rawMax / step) * step || 1,
    x = (i) => L + (i / Math.max(1, dates.length - 1)) * pw,
    y = (v) => T + ((max - v) / (max - min)) * ph,
    ns = "http://www.w3.org/2000/svg",
    svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    unit === "지수" ? "일별 상대 관심지수" : "일별 추정 쿼리수",
  );
  function add(tag, attrs, text) {
    let el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text !== undefined) el.textContent = text;
    svg.append(el);
    return el;
  }
  const ticks = Math.round((max - min) / step);
  for (let j = 0; j <= ticks; j++) {
    let v = min + j * step;
    add("line", {
      x1: L,
      x2: W - R,
      y1: y(v),
      y2: y(v),
      stroke: v === 0 ? "#a4bdb0" : "#e4ece6",
      "stroke-dasharray": v === 0 ? "0" : "3 5",
    });
    add(
      "text",
      {
        x: L - 8,
        y: y(v) + 4,
        "text-anchor": "end",
        fill: "#81958a",
        "font-size": 10,
      },
      Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + "k" : fmt(v),
    );
  }
  for (let j = 0; j < 5; j++) {
    let i = Math.round((j / 4) * (dates.length - 1));
    add(
      "text",
      {
        x: x(i),
        y: H - 9,
        "text-anchor": j === 0 ? "start" : j === 4 ? "end" : "middle",
        fill: "#81958a",
        "font-size": 10,
      },
      dates[i]?.slice(5).replace("-", "."),
    );
  }
  series.forEach((s) => {
    const d = smoothPath(
      s.values.map((v, i) => (v == null ? null : [x(i), y(v)])),
    );
    add("path", {
      d,
      fill: "none",
      stroke: s.color,
      "stroke-width": 3,
      "stroke-linejoin": "round",
      "vector-effect": "non-scaling-stroke",
    });
  });
  let line = add("line", {
      x1: L,
      x2: L,
      y1: T,
      y2: H - B,
      stroke: "#94b4a1",
      "stroke-dasharray": "3 3",
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
      "aria-label": "좌우 방향키 또는 터치로 날짜별 값 확인",
      "aria-valuemin": 0,
      "aria-valuemax": dates.length - 1,
      "aria-valuenow": 0,
    }),
    tip = document.createElement("div");
  tip.className = "tooltip";
  tip.hidden = true;
  let pos = 0;
  function show(i) {
    pos = Math.max(0, Math.min(dates.length - 1, i));
    line.setAttribute("x1", x(pos));
    line.setAttribute("x2", x(pos));
    line.setAttribute("visibility", "visible");
    tip.replaceChildren();
    let title = document.createElement("strong");
    title.textContent = dates[pos];
    tip.append(title);
    series.forEach((s) => {
      let el = document.createElement("div");
      el.textContent =
        s.name +
        "  " +
        (s.values[pos] == null
          ? "미확보"
          : unit === "지수"
            ? s.values[pos].toFixed(2)
            : fmt(s.values[pos]) + "건");
      tip.append(el);
    });
    tip.style.top = "20px";
    tip.style.left =
      Math.min(
        Math.max(5, (x(pos) / W) * root.clientWidth + 8),
        Math.max(5, root.clientWidth - 240),
      ) + "px";
    tip.hidden = false;
    overlay.setAttribute("aria-valuenow", pos);
    overlay.setAttribute("aria-valuetext", dates[pos]);
  }
  overlay.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    show(
      Math.round(
        ((((e.clientX - r.left) / r.width) * W - L) / pw) * (dates.length - 1),
      ),
    );
  });
  overlay.addEventListener("focus", () => show(pos));
  const hide = () => {
    tip.hidden = true;
    line.setAttribute("visibility", "hidden");
  };
  overlay.addEventListener("pointerleave", hide);
  overlay.addEventListener("blur", hide);
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      show(pos + (e.key === "ArrowLeft" ? -1 : 1));
    }
  });
  root.append(svg, tip);
}
function drawQuota() {
  if (!quota) return;
  $("quotaRemain").textContent =
    "약 " +
    fmt(quota.remaining_month) +
    " / " +
    fmt(quota.monthly_limit) +
    "회";
  $("quotaDaily").textContent =
    quota.daily_limit == null
      ? "일간 한도 없음"
      : "일간 " + fmt(quota.daily_limit) + "회";
  $("quotaBar").style.width =
    Math.min(100, (quota.month_used / quota.monthly_limit) * 100) + "%";
}
async function loadQuota() {
  try {
    quota = await api("/api/quota");
    drawQuota();
  } catch {
    $("quotaRemain").textContent = "사용량 확인 실패";
  }
}
function beforeReplace(action, description) {
  if (busy) return;
  pendingAction = action;
  $("replaceDetail").textContent = description || "";
  if (dataset?.models?.length) $("replaceDialog").showModal();
  else {
    pendingAction = null;
    action();
  }
}
let extractionFocus = null;
function extractionProgress(value) {
  const n = Math.min(100, Math.max(0, Math.round(value)));
  $("extractionFill").style.width = n + "%";
  $("extractionPercent").textContent = n + "%";
  $("extractionGauge").setAttribute("aria-valuenow", String(n));
  $("extractionGauge").setAttribute("aria-valuetext", n + "%");
}
function setExtracting(active) {
  if (active && !busy) extractionFocus = document.activeElement;
  busy = active;
  $("appSurface").inert = active;
  $("appSurface").setAttribute("aria-busy", String(active));
  $("extractionOverlay").hidden = !active;
  document.body.classList.toggle("extracting", active);
  $("importExcel").disabled = active;
  estimateBudget();
  if (active) $("extractionGauge").focus?.();
  else extractionFocus?.focus?.();
}
$("extractionGauge").addEventListener("keydown", (e) => {
  if (e.key === "Tab") e.preventDefault();
});
async function execute(job, started = false) {
  if (busy && !started) return;
  setExtracting(true);
  currentJob = job;
  $("runProgress").hidden = true;
  $("retryJob").hidden = true;
  extractionProgress(0);
  try {
    for (let i = 0; i < job.steps.length; i++) {
      const step = job.steps[i];
      await api("/api/jobs/" + job.id + "/step?name=" + step, {});
      extractionProgress(((i + 1) / job.steps.length) * 98);
      if (i % 6 === 0) await loadQuota();
    }
    const [data, config] = await Promise.all([
      api("/api/data"),
      api("/api/groups"),
    ]);
    adopt(data, config.groups, "새 추출 완료");
    extractionProgress(100);
    currentJob = null;
    await loadQuota();
    toast(data.models.length + "개 키워드 추출을 완료했습니다.");
  } catch (e) {
    $("runProgress").hidden = false;
    $("runTitle").textContent = "추출을 완료하지 못했습니다.";
    $("runDetail").textContent = e.message + " 기존 결과는 유지됩니다.";
    $("retryJob").hidden = false;
    toast(e.message);
  } finally {
    setExtracting(false);
  }
}
$("extract").onclick = () => {
  const v = estimateBudget();
  if (!v.valid || busy || recommending) return;
  beforeReplace(
    async () => {
      setExtracting(true);
      extractionProgress(0);
      $("runProgress").hidden = true;
      try {
        const job = await api("/api/jobs", {
          groups: v.gs,
          start_date: v.a,
          end_date: v.b,
        });
        await execute(job, true);
      } catch (e) {
        toast(e.message);
      } finally {
        if (busy) setExtracting(false);
      }
    },
    v.n +
      "개 키워드 · " +
      v.a +
      " ~ " +
      v.b +
      " · Budget " +
      v.cost +
      "건 사용 예상",
  );
};
$("confirmReplace").onclick = () => {
  const action = pendingAction;
  pendingAction = null;
  $("replaceDialog").close();
  action?.();
};
$("cancelReplace").onclick = () => {
  pendingAction = null;
  $("replaceDialog").close();
};
$("replaceDialog").addEventListener("cancel", () => (pendingAction = null));
$("retryJob").onclick = () => currentJob && execute(currentJob);
["keywords", "brandName", "startDate", "endDate"].forEach(
  (id) => ($(id).oninput = estimateBudget),
);
$("selectAll").onclick = () => {
  selected = new Set(dataset.models.map((m) => key(m.keyword)));
  render();
};
$("selectNone").onclick = () => {
  selected.clear();
  render();
};
$("periods").onclick = (e) => {
  const b = e.target.closest("button[data-days]");
  if (b) {
    days = Number(b.dataset.days);
    render();
  }
};
$("toggleFilters").onclick = () => {
  const open = $("filterPanel").hidden;
  $("filterPanel").hidden = !open;
  $("toggleFilters").setAttribute("aria-expanded", String(open));
};
async function recommendKeywords() {
  if (busy || recommending) return;
  const brand = $("brandName").value.trim(),
    before = $("keywords").value;
  if (!brand) return;
  recommending = true;
  $("recommendKeywords").textContent = "조회 중…";
  $("recommendStatus").textContent = "네이버 연관 키워드를 조회하고 있습니다…";
  $("recommendStatus").classList.remove("error");
  estimateBudget();
  try {
    const data = await api("/api/keywords/suggest", { brand });
    if (
      $("brandName").value.trim() !== brand ||
      $("keywords").value !== before
    ) {
      $("recommendStatus").textContent =
        "입력이 변경되어 추천을 자동 적용하지 않았습니다. 다시 눌러주세요.";
      return;
    }
    if (!data.keywords?.length) {
      $("recommendStatus").textContent =
        "추천된 연관 키워드가 없습니다. 기존 입력을 유지합니다.";
      return;
    }
    suggestUndo = before;
    $("keywords").value = words(data.keywords.join("\n")).join("\n");
    $("undoRecommend").hidden = false;
    $("recommendStatus").textContent =
      data.keywords.length +
      "개 키워드를 입력했습니다. 원하는 대로 수정한 뒤 검색하세요.";
    estimateBudget();
  } catch (e) {
    $("recommendStatus").textContent =
      "추천 실패 · " + e.message + " 기존 입력은 유지됩니다.";
    $("recommendStatus").classList.add("error");
  } finally {
    recommending = false;
    $("recommendKeywords").textContent = "자동";
    estimateBudget();
  }
}
$("recommendKeywords").onclick = recommendKeywords;
$("undoRecommend").onclick = () => {
  if (suggestUndo === null || busy || recommending) return;
  $("keywords").value = suggestUndo;
  suggestUndo = null;
  $("undoRecommend").hidden = true;
  $("recommendStatus").textContent = "추천 전 입력으로 되돌렸습니다.";
  estimateBudget();
};
$("downloadAll").onclick = async () => {
  if (busy) return toast("추출이 끝난 뒤 엑셀을 저장하세요.");
  if (!dataset?.models?.length) return toast("저장할 결과가 없습니다.");
  $("downloadAll").disabled = true;
  try {
    const blob = buildXlsx(exportWorkbook({ data: dataset, groups })),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download =
      "네이버쿼리추정기_" +
      dataset.start_date +
      "_" +
      dataset.end_date +
      ".xlsx";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(
      "엑셀 다운로드를 시작했습니다. 날짜·지수 복원 정보도 함께 저장됩니다.",
    );
  } catch (e) {
    toast(e.message);
  } finally {
    $("downloadAll").disabled = false;
  }
};
$("importExcel").onclick = () => {
  if (!busy && !recommending) $("excelFile").click();
};
$("excelFile").onchange = async () => {
  if (busy) return;
  const file = $("excelFile").files?.[0];
  if (!file) return toast("불러올 .xlsx 파일을 선택하세요.");
  if (!/\.xlsx$/i.test(file.name) || file.size > 30000000)
    return toast("30MB 이하의 .xlsx 파일을 선택하세요.");
  $("importExcel").disabled = true;
  $("importStatus").textContent = "엑셀을 읽고 있습니다…";
  try {
    const payload = await readEstimatorXlsx(await file.arrayBuffer());
    $("importStatus").textContent =
      payload.data.models.length +
      "개 키워드 · " +
      payload.data.start_date +
      " ~ " +
      payload.data.end_date +
      " · 복원 가능";
    beforeReplace(
      async () => {
        try {
          const restored = await api("/api/import", payload);
          adopt(restored.data, restored.groups, "엑셀에서 복원");
          $("importStatus").textContent =
            "복원을 완료했습니다. API 사용량은 차감되지 않았습니다.";
        } catch (e) {
          toast(e.message);
        }
      },
      "엑셀의 " +
        payload.data.models.length +
        "개 키워드로 현재 결과를 교체합니다. API 호출은 없습니다.",
    );
  } catch (e) {
    $("importStatus").textContent = e.message;
    toast(e.message);
  } finally {
    $("importExcel").disabled = false;
    $("excelFile").value = "";
  }
};
async function reloadData() {
  if (busy) return;
  try {
    const [data, config] = await Promise.all([
      api("/api/data"),
      api("/api/groups"),
    ]);
    adopt(data, config.groups, "서버에 저장된 결과");
    await loadQuota();
  } catch (e) {
    toast(e.message);
    $("empty").textContent =
      "서버 연결을 확인하지 못했습니다. 결과 새로고침을 눌러 주세요.";
  }
}
$("reloadData").onclick = reloadData;
function setPanel(open) {
  $("panelBody").hidden = !open;
  $("panelToggle").setAttribute("aria-expanded", String(open));
  if (open) $("brandName").focus({ preventScroll: true });
}
$("panelToggle").onclick = () => setPanel($("panelBody").hidden);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("panelBody").hidden && !busy) {
    setPanel(false);
    $("panelToggle").focus();
  }
});
document.addEventListener("pointerdown", (e) => {
  if (
    !$("panelBody").hidden &&
    !busy &&
    !$("queryPanel").contains(e.target) &&
    !$("replaceDialog").open
  )
    setPanel(false);
});
async function init() {
  const today = new Date().toLocaleDateString("sv-SE", {
      timeZone: "Asia/Seoul",
    }),
    end = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10),
    start = new Date(Date.parse(end) - 364 * 86400000)
      .toISOString()
      .slice(0, 10);
  $("startDate").value = start;
  $("endDate").value = end;
  $("startDate").max = end;
  $("endDate").max = end;
  setDraft([
    { id: "analysis", name: "BMW", keywords: ["BMW", "BMWX3", "BMWX5"] },
  ]);
  await Promise.allSettled([
    loadInsights().then(() => dataset?.models?.length && mainFlow()),
    reloadData(),
    (async () => {
      try {
        const status = await api("/api/status");
        if (status.job) {
          currentJob = status.job;
          $("runProgress").hidden = false;
          $("runTitle").textContent = "완료되지 않은 추출이 있습니다.";
          $("runDetail").textContent =
            "진행 중인 추출을 이어서 실행할 수 있습니다.";
          $("retryJob").hidden = false;
        }
      } catch {}
    })(),
  ]);
}
init();
