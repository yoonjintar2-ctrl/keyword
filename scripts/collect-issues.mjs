// 새 분석이 생기면 해당 키워드의 이슈를 뉴스·소셜에서 찾아 web/insights.json에 추가한다.
// 실행: node scripts/collect-issues.mjs  (GitHub Actions에서 30분마다)
// 필수 없음. 선택 환경변수:
//   NAVER_CLIENT_ID / NAVER_CLIENT_SECRET  네이버 검색 API(뉴스·블로그) — 소셜 발화량과 블로그 화제글
//   YOUTUBE_API_KEY                         유튜브 Data API — 급등일 인기 영상
//   API_BASE                                쿼리 추정기 서버 주소
//   FORCE=1                                 이미 수집한 분석도 다시 수집
import fs from "node:fs";

const API_BASE = (
  process.env.API_BASE || "https://auto-search-pulse.yoonjintar0.chatgpt.site"
).replace(/\/$/, "");
const FILE = process.env.INSIGHTS_FILE || "web/insights.json";
const NAVER_ID = process.env.NAVER_CLIENT_ID,
  NAVER_SECRET = process.env.NAVER_CLIENT_SECRET,
  YT_KEY = process.env.YOUTUBE_API_KEY;
const UA = "Mozilla/5.0 (keyword.jintar.co.kr issue collector)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[collect]", ...a);

/* ---------- 날짜 유틸 (KST) ---------- */
const DAY = 86400000;
const addDays = (d, n) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);
const kstDate = (t) => new Date(+new Date(t) + 9 * 3600000).toISOString().slice(0, 10);

/* ---------- 쿼리 추정 (프런트와 같은 식) ---------- */
export function estimates(m, data) {
  let c = m.calibration,
    pc = c?.pc,
    mo = c?.mo;
  if (!c) {
    const end = data.calibration?.anchor_end || data.end_date,
      ix = data.dates.map((d, i) => ({ d, i })).filter((x) => x.d <= end).slice(-30);
    pc = ix.map((x) => m.series?.pc?.[x.i] ?? null);
    mo = ix.map((x) => m.series?.mo?.[x.i] ?? null);
  }
  const sum = (a) => (a || []).reduce((s, v) => s + (v ?? 0), 0),
    ps = sum(pc),
    ms = sum(mo),
    ok =
      pc?.length === 30 && mo?.length === 30 && !pc.includes(null) && !mo.includes(null) &&
      ps > 0 && ms > 0 && typeof m.pc === "number" && typeof m.mobile === "number";
  return data.dates.map((_, i) =>
    ok && m.series?.pc?.[i] != null && m.series?.mo?.[i] != null
      ? (m.series.pc[i] / ps) * m.pc + (m.series.mo[i] / ms) * m.mobile
      : null,
  );
}
export function totals(data) {
  const vs = data.models.map((m) => estimates(m, data));
  return data.dates.map((_, i) => {
    const v = vs.map((x) => x[i]).filter((x) => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) : null;
  });
}
export function detectSpikes(v) {
  const out = [];
  for (let i = 0; i < v.length; i++) {
    if (v[i] == null) continue;
    const win = [];
    for (let j = i - 7; j <= i + 7; j++) if (j !== i && v[j] != null) win.push(v[j]);
    if (win.length < 6) continue;
    win.sort((a, b) => a - b);
    const med = win.length % 2 ? win[(win.length - 1) / 2] : (win[win.length / 2 - 1] + win[win.length / 2]) / 2;
    let peak = true;
    for (let j = i - 2; j <= i + 2; j++) if (j !== i && v[j] != null && v[j] > v[i]) peak = false;
    if (peak && med > 0 && v[i] >= med * 1.15) out.push({ i, pct: (v[i] / med - 1) * 100 });
  }
  return out;
}


/* ---------- 급등 유형(데이터로 역추적) ----------
   기기·성·연령·키워드·요일 상승 패턴으로 어떤 경로의 노출인지 분류해 검색 방향을 정한다.
   - 대중 노출형: 모바일만 오르고 PC는 그대로/하락, 전 연령 고르게 상승 → TV·영상·SNS 확산·광고
   - 뉴스형: 평일에 PC가 함께 상승 → 언론 보도·발표
   - 관심층형: 특정 연령·성별만 상승 → 리뷰·커뮤니티·유튜버 */
const SEG_AGES = ["age19_29", "age30_39", "age40_49", "age50_59", "age60plus"];
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
export function spikeSignature(data, i) {
  const lift = (arr) => {
    if (!arr || arr[i] == null) return null;
    const w = [];
    for (let j = i - 7; j <= i + 7; j++) if (j !== i && arr[j] != null) w.push(arr[j]);
    const m = median(w);
    return m ? arr[i] / m : null;
  };
  const acc = {},
    drivers = [];
  for (const m of data.models) {
    const wt = (typeof m.pc === "number" ? m.pc : 0) + (typeof m.mobile === "number" ? m.mobile : 0);
    if (!wt || !m.series) continue;
    for (const k of ["pc", "mo", "male", "female", "under19", ...SEG_AGES]) {
      const l = lift(m.series[k]);
      if (l == null) continue;
      (acc[k] ||= { s: 0, w: 0 }).s += l * wt;
      acc[k].w += wt;
    }
    const a = lift(m.series.all);
    if (a != null) drivers.push({ keyword: m.keyword, lift: a, contrib: (a - 1) * wt });
  }
  const r = (k) => (acc[k]?.w ? acc[k].s / acc[k].w : null),
    ages = SEG_AGES.map((k) => ({ k, v: r(k) })).filter((x) => x.v != null),
    agesV = ages.map((x) => x.v),
    meanA = agesV.reduce((a, b) => a + b, 0) / (agesV.length || 1),
    cv = agesV.length ? Math.sqrt(agesV.reduce((a, b) => a + (b - meanA) ** 2, 0) / agesV.length) / meanA : null,
    wd = new Date(data.dates[i] + "T00:00:00Z").getUTCDay(),
    weekend = wd === 0 || wd === 6,
    mo = r("mo"),
    pc = r("pc"),
    male = r("male"),
    female = r("female");
  drivers.sort((a, b) => b.contrib - a.contrib);
  let type = "혼합형",
    why = [];
  if (mo != null && pc != null && mo >= 1.2 && pc <= 1.05 && cv != null && cv < 0.2) {
    type = "대중 노출형";
    why.push(pc < 0.9 ? "모바일만 상승(PC는 감소)" : "모바일만 상승(PC 변화 없음)", "전 연령 고르게 상승");
  } else if (pc != null && pc >= 1.2 && !weekend) {
    type = "뉴스형";
    why.push("평일 PC 동반 상승");
  } else if (cv != null && cv >= 0.2) {
    type = "관심층형";
    const top = [...ages].sort((a, b) => b.v - a.v).slice(0, 2).map((x) => x.k);
    why.push("특정 연령 집중: " + top.join(", "));
  }
  if (weekend) why.push("주말");
  if (female && male && female / male >= 1.25) why.push("여성 상승이 더 큼");
  if (female && male && male / female >= 1.25) why.push("남성 상승이 더 큼");
  const f = (x) => (x == null ? null : Math.round(x * 100) / 100);
  return {
    type,
    why,
    mo: f(mo),
    pc: f(pc),
    male: f(male),
    female: f(female),
    age_cv: f(cv),
    weekday: ["일", "월", "화", "수", "목", "금", "토"][wd],
    driver: drivers[0]?.keyword || null,
  };
}
/* 유형별로 붙이는 검색어 */
export function querySuffix(type) {
  if (type === "대중 노출형") return ["드라마", "예능", "방송", "광고", "연예인", "PPL", "유튜브"];
  if (type === "관심층형") return ["시승기", "리뷰", "유튜버", "커뮤니티"];
  if (type === "뉴스형") return ["출시", "발표", "가격", "리콜"];
  return [];
}

/* ---------- 검색어 만들기 ---------- */
const BRANDS = ["BMW", "MINI", "KIA", "AUDI", "GV", "SKT", "KT", "LG", "SK"];
export const spaced = (k) => {
  let s = k.replace(/^([A-Z]{2,})(?=[a-z])/, "$1 ").replace(/([가-힣])(?=[A-Za-z0-9])/, "$1 ");
  for (const b of BRANDS)
    if (s.toUpperCase().startsWith(b) && /^[A-Za-z]\d/.test(s.slice(b.length))) s = s.slice(0, b.length) + " " + s.slice(b.length);
  return s.replace(/\s+/g, " ").trim();
};
export function searchTerms(data) {
  const brand = data.analysis?.brand && data.analysis.brand !== "전체 키워드" ? data.analysis.brand : "";
  const ranked = [...data.models]
    .filter((m) => typeof m.total === "number")
    .sort((a, b) => b.total - a.total)
    .slice(0, 4)
    .map((m) => spaced(m.keyword));
  const terms = [...new Set([...ranked, brand].filter(Boolean))];
  return terms.length ? terms : data.models.slice(0, 3).map((m) => spaced(m.keyword));
}

/* ---------- 텍스트 ---------- */
const decode = (s) =>
  String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
const tokens = (t) =>
  new Set(
    t.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").toLowerCase().split(/[^0-9a-z가-힣]+/).filter((w) => w.length >= 2),
  );
const overlap = (a, b) => {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.max(1, Math.min(a.size, b.size));
};
// 같은 날 기사들 중 다른 기사와 가장 많이 겹치는 제목 = 대표 이슈
function representative(items) {
  const tk = items.map((it) => tokens(it.title));
  let best = 0,
    bestScore = -1;
  tk.forEach((a, i) => {
    const s = tk.reduce((acc, b, j) => acc + (i === j ? 0 : overlap(a, b)), 0);
    if (s > bestScore) (bestScore = s), (best = i);
  });
  const cluster = items.filter((_, j) => j === best || overlap(tk[best], tk[j]) >= 0.34);
  return { lead: items[best], cluster };
}
const shortTitle = (t, n = 24) => {
  const s = t.replace(/\s*[-|]\s*[^-|]+$/, "").replace(/^\[[^\]]+\]\s*/, "").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

/* ---------- 소스: 구글 뉴스 RSS (키 불필요) ---------- */
async function googleNews(terms, from, to, extra = []) {
  const base = terms.map((t) => `"${t}"`).join(" OR "),
    q =
      (extra.length ? `(${base}) (${extra.join(" OR ")})` : base) +
      ` after:${addDays(from, -1)} before:${addDays(to, 1)}`;
  const url = "https://news.google.com/rss/search?hl=ko&gl=KR&ceid=KR:ko&q=" + encodeURIComponent(q);
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw Error("google news " + r.status);
  const xml = await r.text(),
    out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const g = (tag) => decode((m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1]);
    const pub = g("pubDate");
    if (!pub) continue;
    out.push({ title: g("title"), url: g("link"), source: g("source") || "구글 뉴스", date: kstDate(pub), kind: "뉴스" });
  }
  return out;
}

/* ---------- 소스: 네이버 검색 API (키 있을 때) ---------- */
async function naver(kind, query, pages = 10) {
  const out = [];
  for (let p = 0; p < pages; p++) {
    const url = `https://openapi.naver.com/v1/search/${kind}.json?display=100&sort=date&start=${p * 100 + 1}&query=${encodeURIComponent(query)}`;
    const r = await fetch(url, { headers: { "X-Naver-Client-Id": NAVER_ID, "X-Naver-Client-Secret": NAVER_SECRET } });
    if (!r.ok) throw Error(`naver ${kind} ${r.status}`);
    const d = await r.json();
    for (const it of d.items || []) {
      const date =
        kind === "blog" && it.postdate
          ? `${it.postdate.slice(0, 4)}-${it.postdate.slice(4, 6)}-${it.postdate.slice(6, 8)}`
          : it.pubDate
            ? kstDate(it.pubDate)
            : null;
      out.push({
        title: decode(it.title),
        url: it.originallink || it.link,
        source: kind === "blog" ? it.bloggername || "네이버 블로그" : "네이버 뉴스",
        date,
        kind: kind === "blog" ? "블로그" : "뉴스",
      });
    }
    if ((d.items || []).length < 100 || p * 100 + 100 >= (d.total || 0)) break;
    await sleep(120);
  }
  return out;
}

/* ---------- 소스: 유튜브 (키 있을 때) ---------- */
async function youtube(terms, from, to) {
  const url =
    "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=5&regionCode=KR&relevanceLanguage=ko" +
    `&publishedAfter=${addDays(from, 0)}T00:00:00%2B09:00&publishedBefore=${addDays(to, 1)}T00:00:00%2B09:00` +
    `&q=${encodeURIComponent(terms.join("|"))}&key=${YT_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw Error("youtube " + r.status);
  const d = await r.json();
  return (d.items || []).map((it) => ({
    title: decode(it.snippet.title),
    url: "https://www.youtube.com/watch?v=" + it.id.videoId,
    source: it.snippet.channelTitle,
    date: kstDate(it.snippet.publishedAt),
    kind: "유튜브",
  }));
}

/* ---------- 메인 ---------- */
export async function collect(data, { now = new Date() } = {}) {
  const terms = searchTerms(data),
    v = totals(data),
    dates = data.dates,
    notes = [];
  log("검색어:", terms.join(", "));

  // 1) 기간 전체 뉴스: 2주 단위로 모아 날짜별 보도량 집계
  const news = [];
  for (let s = 0; s < dates.length; s += 14) {
    const from = dates[s],
      to = dates[Math.min(dates.length - 1, s + 13)];
    try {
      news.push(...(await googleNews(terms, from, to)));
    } catch (e) {
      notes.push("구글 뉴스 수집 실패(" + from + "): " + e.message);
    }
    await sleep(800);
  }
  let blog = [];
  if (NAVER_ID && NAVER_SECRET) {
    for (const t of terms.slice(0, 3)) {
      try {
        news.push(...(await naver("news", t, 5)));
        blog.push(...(await naver("blog", t, 10)));
      } catch (e) {
        notes.push("네이버 검색 API 실패: " + e.message);
      }
    }
  } else notes.push("네이버 검색 API 키 없음 — 블로그 발화량·화제글 미수집");

  const inRange = (it) => it.date && it.date >= dates[0] && it.date <= dates.at(-1);
  const uniq = (arr) => [...new Map(arr.filter(inRange).map((it) => [it.title, it])).values()];
  const newsU = uniq(news),
    blogU = uniq(blog);
  const byDay = (arr) => arr.reduce((m, it) => (m.get(it.date)?.push(it) || m.set(it.date, [it]), m), new Map());
  const newsDay = byDay(newsU),
    blogDay = byDay(blogU);

  // 2) 큰 이슈 = 보도량이 많은 날(상위, 최소 3건)의 대표 기사
  const counts = dates.map((d) => (newsDay.get(d) || []).length).sort((a, b) => a - b),
    med = counts.length ? counts[Math.floor(counts.length / 2)] : 0,
    issues = [...newsDay.entries()]
      .filter(([, a]) => a.length >= Math.max(3, med * 2))
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 6)
      .map(([date, a]) => {
        const { lead, cluster } = representative(a);
        return {
          date,
          title: shortTitle(lead.title),
          summary: `이날 관련 보도 ${a.length}건. 대표 기사: ${lead.title}`,
          source: lead.source,
          url: lead.url,
          related: cluster.slice(0, 5).map((it) => ({ title: it.title, url: it.url, source: it.source })),
          auto: true,
        };
      })
      .sort((a, b) => (a.date < b.date ? -1 : 1));

  // 3) 급등일별 원인 후보: ±2일 뉴스·블로그·유튜브
  const spike_notes = {};
  const spikes = detectSpikes(v).sort((a, b) => b.pct - a.pct).slice(0, 8);
  for (const s of spikes) {
    const d = dates[s.i],
      win = [-3, -2, -1, 0, 1].map((k) => addDays(d, k)),
      pick = (m, kind) =>
        win.flatMap((w) => (m.get(w) || []).map((it) => ({ ...it, kind })));
    const sig = spikeSignature(data, s.i),
      focus = sig.driver ? [spaced(sig.driver)] : terms;
    let cands = [...pick(newsDay, "뉴스"), ...pick(blogDay, "블로그")];
    // 유형별 표적 검색: 대중 노출형이면 방송·광고·연예 키워드를 붙여 다시 찾는다
    const extra = querySuffix(sig.type);
    if (extra.length) {
      try {
        const hits = await googleNews(focus, addDays(d, -3), addDays(d, 1), extra);
        cands.push(...hits.filter((it) => win.includes(it.date)).map((it) => ({ ...it, kind: "뉴스(" + sig.type + " 표적)" })));
      } catch (e) {
        notes.push("표적 검색 실패(" + d + "): " + e.message);
      }
      await sleep(600);
    }
    if (YT_KEY) {
      try {
        cands.push(...(await youtube(focus, addDays(d, -3), d)));
      } catch (e) {
        notes.push("유튜브 실패: " + e.message);
      }
    }
    // 같은 주제끼리 묶어 많이 언급된 순
    const groups = [];
    for (const it of cands) {
      const tk = tokens(it.title),
        g = groups.find((g) => overlap(g.tk, tk) >= 0.34);
      g ? g.items.push(it) : groups.push({ tk, items: [it] });
    }
    groups.sort((a, b) => b.items.length - a.items.length);
    const top = groups.slice(0, 4).map((g) => {
      const it = g.items[0],
        kinds = [...new Set(g.items.map((x) => x.kind))].join("·");
      return {
        title: shortTitle(it.title, 40),
        date: it.date,
        source: it.source + (g.items.length > 1 ? ` 외 ${g.items.length - 1}건` : ""),
        url: it.url,
        relevance: g.items.length >= 3 ? "중" : "약",
        kind: kinds,
      };
    });
    spike_notes[d] = {
      signature: sig,
      summary: top.length
        ? `급등일 전후(−3~+1일) 뉴스·${NAVER_ID ? "블로그·" : ""}${YT_KEY ? "유튜브·" : ""}게시물 중 많이 언급된 주제입니다. 상관관계일 뿐 원인은 확정되지 않았습니다.`
        : "급등일 전후로 검색어와 맞는 게시물을 찾지 못했습니다.",
      candidates: top,
      auto: true,
    };
  }

  // 4) 소셜 발화량: 블로그 일별 게시물 수 (수집 범위 밖은 결측)
  const aux = [];
  if (blogU.length) {
    const oldest = blogU.reduce((m, it) => (it.date < m ? it.date : m), "9999");
    const values = {};
    for (const d of dates) values[d] = d < oldest ? null : (blogDay.get(d) || []).length;
    aux.push({
      id: "social_blog",
      name: "소셜 발화량",
      kind: "네이버 블로그 일별 게시물 수",
      basis: `검색어 ${terms.slice(0, 3).join(", ")} · 최신 1,000건 한도라 ${oldest} 이전은 미수집`,
      color: "#9a6fc9",
      values,
    });
  }
  return {
    job_id: data.job_id || null,
    collected_from: data.collected_at,
    keywords: data.models.map((m) => m.keyword),
    start_date: dates[0],
    end_date: dates.at(-1),
    collected_at: now.toISOString(),
    auto: true,
    sources: ["구글 뉴스", ...(NAVER_ID ? ["네이버 뉴스", "네이버 블로그"] : []), ...(YT_KEY ? ["유튜브"] : [])],
    search_terms: terms,
    notes,
    aux,
    issues,
    spike_notes,
  };
}

async function main() {
  let data;
  if (process.env.DATA_URL) {
    // 점검용: 다른 분석 파일로 수집만 시험(저장하지 않음)
    const j = await (await fetch(process.env.DATA_URL)).json();
    const e = await collect(j.data || j);
    log("점검 결과:", JSON.stringify({ issues: e.issues.map((i) => i.date + " " + i.title), spikes: Object.entries(e.spike_notes).map(([d, n]) => d + " 후보 " + n.candidates.length), notes: e.notes }));
    return;
  }
  const r = await fetch(API_BASE + "/api/data", { headers: { "User-Agent": UA }, cache: "no-store" });
  const text = await r.text();
  if (!r.ok || !text.trim().startsWith("{")) throw Error("분석 데이터 응답 오류 " + r.status + " " + text.slice(0, 120));
  data = JSON.parse(text);
  if (!data.models?.length) return log("분석 없음");
  const store = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : { version: 1, analyses: [] };
  const id = data.job_id || data.collected_at;
  const done = store.analyses.find((a) => (a.job_id || a.collected_from) === id);
  if (done && !process.env.FORCE) return log("이미 수집됨:", id);
  if (done?.manual) return log("수동 정리된 분석은 덮어쓰지 않음:", id);
  const entry = await collect(data);
  store.analyses = [entry, ...store.analyses.filter((a) => (a.job_id || a.collected_from) !== id)].slice(0, 30);
  fs.writeFileSync(FILE, JSON.stringify(store, null, 1) + "\n");
  log(`저장: 이슈 ${entry.issues.length}건, 급등일 ${Object.keys(entry.spike_notes).length}개, 보조지표 ${entry.aux.length}개`);
  for (const n of entry.notes) log("참고:", n);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("[collect] 실패:", e.message);
    process.exit(1);
  });
}
