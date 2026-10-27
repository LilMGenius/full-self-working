// The review list the operator reads before `fsw profile accept`: what the draft says and where each
// claim came from, what was dropped for lack of a source, where sources disagreed, and what still needs a
// person. Written in English or Korean (--lang ko).
const T = {
  en: {
    title: 'Profile draft review',
    intro: 'Read every line. Nothing here is live until you run fsw profile accept. Edit profile.draft.json first if a claim is wrong; accept only checks that the file is a valid profile.',
    claims: 'Claims and their sources',
    dropped: 'Left out because the sources do not state them',
    conflicts: 'Sources disagreed; the lower value was chosen',
    notes: 'Inputs not fully read',
    todo: 'Still needs you',
    none: 'none',
    chosen: 'chosen',
    todoItems: [
      'Check every approved claim: the outbound gate lets a number about experience through only when it is on this list.',
      'Check claimsNotToMake against what you will not say to a client.',
      'person.phone fills the platform onboarding forms, and the privacy scan checks it and person.email; remove them here if you do not want them stored.',
      'Fill business.json by hand; it is never drafted from sources.',
    ],
    empty: 'The draft has no verified claim at all. Add more background or check that the sources are readable text.',
  },
  ko: {
    title: '프로필 초안 검토 목록',
    intro: '모든 줄을 읽어 보세요. fsw profile accept 를 실행하기 전에는 아무것도 적용되지 않습니다. 틀린 내용은 먼저 profile.draft.json 에서 고치세요. accept 는 파일이 올바른 프로필 형식인지만 확인합니다.',
    claims: '주장과 출처',
    dropped: '출처에 없어서 뺀 내용',
    conflicts: '출처끼리 달라서 낮은 쪽을 고른 내용',
    notes: '전부 읽지 못한 입력',
    todo: '직접 확인할 일',
    none: '없음',
    chosen: '선택',
    todoItems: [
      '승인된 주장(approvedClaims)을 모두 확인하세요. 경력 관련 숫자는 이 목록에 있을 때만 발송 게이트를 통과합니다.',
      'claimsNotToMake 가 고객에게 하지 않을 말과 맞는지 확인하세요.',
      'person.phone 은 플랫폼 가입 양식에 쓰이고, person.email 과 함께 개인정보 검사에 쓰입니다. 저장하고 싶지 않으면 지우세요.',
      'business.json 은 출처에서 만들지 않으므로 직접 채우세요.',
    ],
    empty: '검증된 주장이 하나도 없습니다. 배경 자료를 더 주거나 읽을 수 있는 텍스트인지 확인하세요.',
  },
};

export function buildReview({ profile: draft, dropped, conflicts, notes = [], lang = 'en' }) {
  const t = T[lang] ?? T.en;
  const lines = [`# ${t.title}`, '', t.intro, ''];
  const claims = draft.provenance ?? [];
  lines.push(`## ${t.claims} (${claims.length})`, '');
  if (!claims.length) lines.push(t.empty, '');
  for (const c of claims) lines.push(`- ${c.path}: ${c.source} line ${c.line}: "${c.quote.replace(/\s+/g, ' ').slice(0, 140)}"`);
  lines.push('', `## ${t.dropped} (${dropped.length})`, '');
  if (!dropped.length) lines.push(t.none);
  for (const d of dropped) lines.push(`- ${d.path}: "${d.text}" (${d.reason})`);
  lines.push('', `## ${t.conflicts} (${conflicts.length})`, '');
  if (!conflicts.length) lines.push(t.none);
  for (const c of conflicts) lines.push(`- ${c.field}: ${c.versions.join(' | ')}; ${t.chosen}: ${c.chosen}${c.corrected ? ' (corrected to the lower value)' : ''}`);
  lines.push('', `## ${t.notes} (${notes.length})`, '');
  if (!notes.length) lines.push(t.none);
  for (const n of notes) lines.push(`- ${n}`);
  lines.push('', `## ${t.todo}`, '', ...t.todoItems.map((i) => `- ${i}`), '');
  return lines.join('\n');
}
