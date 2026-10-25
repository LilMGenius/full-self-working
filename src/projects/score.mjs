// Deterministic judgement of 크몽 엔터프라이즈 projects: which catalog service a project is, whether the
// operator can take it at all, and how it ranks against the others. Every project judged is remembered
// in the ledger as a thread of kind project, keyed by its page version, so it is judged once unless the
// client changes the page.
import { costFloor } from '../economics/pricing.mjs';
import { armWeight } from '../economics/priority.mjs';
import { dayKey } from '../core/clock.mjs';
import catalog from '../economics/services.json' with { type: 'json' };

// Enterprise sub categories (ids from the list page's category data, 2026-10-25) and the catalog
// services each can hold, the likelier first. An empty list is a category the catalog cannot serve
// (native apps, hardware, games, infrastructure); a sub category missing here is judged by keywords.
export const SUB_SERVICES = {
  94: ['web_app_dev', 'landing_page_web', 'ai_automation_chatbot'],
  42: ['landing_page_web', 'web_app_dev'],
  44: [],
  46: ['web_app_dev', 'ai_automation_chatbot', 'data_crawling', 'excel_macro'],
  99: [], 48: [], 101: [], 103: [], 49: [], 100: [], 105: [],
  102: ['ai_automation_chatbot', 'web_app_dev', 'data_crawling'],
  104: [],
  4: ['landing_page_web', 'detail_page_design'],
  1: ['logo_brand'],
  106: ['thumbnail_banner'],
  89: ['thumbnail_banner', 'detail_page_design'],
  107: [], 108: [], 21: [], 7: [], 11: [], 14: [],
  18: ['ppt_card_news'],
  111: ['blog_writing', 'copywriting'],
  113: ['ai_automation_chatbot', 'data_crawling'],
  119: ['video_editing'], 95: ['video_editing'], 121: ['video_editing'], 122: ['video_editing'],
  97: [], 96: [], 120: [], 123: [], 124: [],
  98: [], 93: [],
};

// Root category of each sub category above, so the supervisor lists only the tabs that can hold a
// service the profile fits.
export const SUB_ROOT = {
  6: [94, 42, 44, 46, 99, 48, 101, 102, 103, 104, 49, 100, 105],
  1: [4, 1, 106, 89, 107, 108, 21, 18, 7, 11, 14],
  2: [23, 109, 110, 111, 112, 24, 113, 114, 115, 116, 117, 118],
  7: [119, 95, 97, 96, 120, 121, 122, 123, 124],
  11: [98, 93],
};

export const SERVICE_KEYWORDS = {
  web_app_dev: ['웹', '관리자', '어드민', '대시보드', '플랫폼', '시스템', '백엔드', 'API', '데이터베이스', 'DB', '로그인', '회원', '예약', 'CMS', '웹앱', 'SaaS'],
  landing_page_web: ['랜딩', '홈페이지', '반응형', '소개 페이지', '브랜드 사이트', '리뉴얼', '개편', '퍼블리싱'],
  ai_automation_chatbot: ['AI', '인공지능', '챗봇', 'GPT', 'LLM', 'RAG', '생성형', '에이전트', '자동화', '자연어', '프롬프트'],
  data_crawling: ['크롤링', '스크래핑', '크롤러', '데이터 수집'],
  excel_macro: ['엑셀', '매크로', 'VBA', '스프레드시트', '구글 시트'],
  detail_page_design: ['상세페이지', '상세 페이지'],
  logo_brand: ['로고', 'BI', 'CI', '브랜딩'],
  thumbnail_banner: ['배너', '썸네일', '광고 소재'],
  ppt_card_news: ['PPT', '프레젠테이션', '카드뉴스', '인포그래픽'],
  video_editing: ['영상', '편집', '유튜브', '숏폼'],
  blog_writing: ['블로그', '원고', '포스팅'],
  copywriting: ['카피', '문구', '슬로건'],
  translation_ko_en: ['번역', '영문'],
};

// Work the operator cannot deliver from one desk: on-site presence, hardware, manufacturing, and native
// mobile apps, which no profile project backs.
export const OFFLINE_RE = /상주|오프라인\s*(?:근무|미팅|교육|행사|매장\s*운영)|현장\s*(?:근무|방문|설치|상주|촬영)|출장|하드웨어|펌웨어|임베디드|회로|PCB|아두이노|제조|양산|금형|시제품|생산\s*라인|시공|인테리어|설치\s*공사/i;
export const NATIVE_APP_RE = /앱\s*스토어|앱스토어|플레이\s*스토어|구글\s*플레이|iOS|안드로이드|Android|Flutter|플러터|React\s*Native|리액트\s*네이티브|네이티브\s*앱/i;

export const FIT_RANK = { none: 0, some: 1, strong: 2 };
export const FIT_FACTOR = { some: 0.6, strong: 1 };

const ascii = /^[A-Za-z]+$/;
const keywordRe = (k) => (ascii.test(k) ? new RegExp('(?<![A-Za-z])' + k + '(?![A-Za-z])', 'i') : new RegExp(k.replace(/\s+/g, '\\s*')));

export function keywordHits(text, service) {
  return (SERVICE_KEYWORDS[service] ?? []).filter((k) => keywordRe(k).test(text)).length;
}

// The fee schedule of an enterprise contract as a descriptor the fee functions read: one flat rate on
// the contract amount, VAT included, no payment network share.
export function enterpriseFees(descriptor) {
  const rate = descriptor?.enterprise?.feeRate;
  if (!(typeof rate === 'number' && rate > 0 && rate < 1)) throw Object.assign(new Error('descriptor ' + descriptor?.id + ' has no enterprise.feeRate'), { code: 'FSW_DESCRIPTOR_INVALID' });
  return { id: descriptor.id + '-enterprise', fees: { seller: rate, paymentNetworkRate: 0, vatOnFees: 0 } };
}

// A project is at least the size of the catalog's premium package, so its floor is the premium agent
// hours plus operator minutes scaled from the standard package by the same factor, net of the
// enterprise fee.
export function projectFloorKRW(service, { config, descriptor, services = catalog }) {
  const def = services[service];
  if (!def) throw new RangeError('no catalog service ' + service);
  const ratio = def.agentHours.premium / def.agentHours.standard;
  return costFloor({
    agentHours: def.agentHours.premium,
    humanMinutes: def.humanMinutes.standard * ratio,
    agentHourCostKRW: config?.yield?.agentHourCostKRW,
    humanHourValueKRW: config?.yield?.humanHourValueKRW,
    descriptor: enterpriseFees(descriptor),
  });
}

// Catalog services a project can be, with keyword hits. A mapped sub category decides the set and the
// keywords order it; an unmapped one takes every service with two or more keyword hits.
export function candidateServices(project, services = catalog) {
  const text = project.title + '\n' + project.description;
  const ids = Object.keys(services).filter((k) => !k.startsWith('_'));
  const mapped = SUB_SERVICES[project.sub?.id];
  const pool = mapped ?? ids.filter((s) => keywordHits(text, s) >= 2);
  return pool.filter((s) => services[s]).map((service, order) => ({ service, hits: keywordHits(text, service), order }));
}

// Weight of an arm relative to the strongest kmong arm, as a factor in [0.5, 1.5]; 1 without an
// allocation.
export function weightFactor(allocation, service) {
  const w = armWeight(allocation, 'kmong', service);
  if (w === null) return { weight: null, factor: 1 };
  const max = Math.max(0, ...allocation.weights.filter((x) => x.platform === 'kmong').map((x) => x.weight));
  return { weight: w, factor: max > 0 ? 0.5 + w / max : 1 };
}

const drop = (project, reason, extra = {}) => ({ id: project.id, keep: false, reason, score: 0, ...extra });

export function scoreProject(project, { profile, config, descriptor, allocation = null, minFit = null, now = new Date(), services = catalog }) {
  if (project.status && project.status !== 'APPROVAL') return drop(project, 'the platform shows it as ' + project.status);
  if (project.deadlineAt && project.deadlineAt < dayKey(now).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')) return drop(project, 'deadline ' + project.deadlineAt + ' passed');
  if (Number.isInteger(project.deadlineDays) && project.deadlineDays < 0) return drop(project, 'deadline passed');
  if (project.projectType && project.projectType !== 'OUTSOURCING') return drop(project, 'not outsourcing work (' + project.projectType + ')');
  const text = project.title + '\n' + project.description;
  const offline = text.match(OFFLINE_RE);
  if (offline) return drop(project, 'offline, hardware or manufacturing work (' + offline[0] + ')');
  const native = text.match(NATIVE_APP_RE);
  if (native) return drop(project, 'native mobile app work (' + native[0] + ')');
  const candidates = candidateServices(project, services).map((c) => ({ ...c, fit: profile?.serviceFit?.[c.service]?.strength ?? 'none' }));
  if (!candidates.length) return drop(project, 'no catalog service for ' + (project.sub?.name ?? 'this category'));
  // What the project is comes first (keyword hits), then how well the profile fits it, then the
  // category's own order.
  const best = [...candidates].sort((a, b) => b.hits - a.hits || FIT_RANK[b.fit] - FIT_RANK[a.fit] || a.order - b.order)[0];
  const fitting = best.fit !== 'none' ? best : [...candidates].filter((c) => c.fit !== 'none').sort((a, b) => FIT_RANK[b.fit] - FIT_RANK[a.fit] || b.hits - a.hits)[0];
  if (!fitting) return drop(project, 'profile serviceFit is none for ' + candidates.map((c) => c.service).join(', '), { candidates });
  const pick = best.fit !== 'none' ? best : fitting;
  if (minFit && FIT_RANK[pick.fit] < FIT_RANK[minFit]) return drop(project, 'fit ' + pick.fit + ' for ' + pick.service + ' is below ' + minFit, { service: pick.service, fit: pick.fit, candidates });
  const floorKRW = projectFloorKRW(pick.service, { config, descriptor, services });
  if (!Number.isFinite(project.amountKRW) || project.amountKRW < floorKRW) {
    return drop(project, 'budget ' + (project.amountKRW ?? 'unknown') + ' KRW is under the cost floor ' + floorKRW + ' KRW for ' + pick.service, { service: pick.service, fit: pick.fit, floorKRW, candidates });
  }
  const { weight, factor } = weightFactor(allocation, pick.service);
  const score = FIT_FACTOR[pick.fit] * Math.log2(project.amountKRW / floorKRW + 1) * factor;
  return { id: project.id, keep: true, reason: null, service: pick.service, fit: pick.fit, hits: pick.hits, floorKRW, weight, score: Math.round(score * 1000) / 1000, candidates };
}

// Kept projects by score, highest first; ties by budget, then id.
export function rankProjects(projects, ctx) {
  const judged = projects.map((p) => ({ project: p, verdict: scoreProject(p, ctx) }));
  const kept = judged.filter((j) => j.verdict.keep).sort((a, b) => b.verdict.score - a.verdict.score || b.project.amountKRW - a.project.amountKRW || a.project.id - b.project.id);
  return { kept, dropped: judged.filter((j) => !j.verdict.keep) };
}

// ---- ledger memory ----

export const projectRef = (id) => 'project:' + id;

export function projectThread(ledger, id) {
  return ledger.listThreads({ platform: 'kmong' }).find((t) => t.kind === 'project' && t.externalId === projectRef(id)) ?? null;
}

export function needsJudgement(ledger, project) {
  return projectThread(ledger, project.id)?.meta?.judgement?.hash !== project.hash;
}

// States a later judgement of a changed page must not undo.
const SETTLED = new Set(['queued', 'proposed', 'unobserved', 'meeting', 'selected', 'closed']);

export function rememberJudgement(ledger, project, verdict, now = new Date()) {
  const row = projectThread(ledger, project.id);
  const judgement = {
    hash: project.hash, at: now.toISOString(), keep: verdict.keep, reason: verdict.reason, service: verdict.service ?? null, fit: verdict.fit ?? null,
    score: verdict.score, floorKRW: verdict.floorKRW ?? null, amountKRW: project.amountKRW, deadlineAt: project.deadlineAt, title: project.title,
  };
  const status = row && SETTLED.has(row.status) ? row.status : verdict.keep ? 'candidate' : 'dropped';
  return ledger.upsertThread({ platform: 'kmong', externalId: projectRef(project.id), kind: 'project', service: verdict.service ?? undefined, status, meta: { ...(row?.meta ?? {}), judgement } });
}

export function markProject(ledger, id, status, patch = {}) {
  const row = projectThread(ledger, id);
  if (!row) throw new Error('project ' + id + ' was never judged');
  return ledger.upsertThread({ platform: 'kmong', externalId: projectRef(id), kind: 'project', status, meta: { ...row.meta, ...patch } });
}

