// 크몽 conversation pages: page-side extractors, serialised into the page by the driver (no closure over
// module scope). Moved verbatim from src/platforms/kmong/adapter.mjs:16-82 at 2c77326, with pageLoginForm
// from 36400c4.

export function pageLogin() {
  const nickLink = [...document.querySelectorAll('a[href^="/@"]')].find((a) => a.innerText.includes('프로필 완성도'));
  return {
    url: location.href,
    avatar: !!document.querySelector('[data-testid=avatar]'),
    authSection: !!document.querySelector('[data-testid=authenticate-section]'),
    loginButton: [...document.querySelectorAll('a,button')].some((e) => e.innerText.trim() === '로그인'),
    sellerMode: document.querySelector('input[aria-label="전문가 모드"]')?.checked ?? null,
    profileHref: nickLink?.getAttribute('href') ?? null,
  };
}

// The 로그인 modal (/?open=login_modal, read 2026-10-26): an email input, a password input and a 로그인
// submit button in one box, with 로그인 유지 checked by default. The three are marked for fill and click.
export function pageLoginForm() {
  const pw = document.querySelector('input[type=password]');
  if (!pw) return { found: false };
  let box = pw;
  for (let i = 0; i < 12 && box && !box.querySelector('input[type=email], input[name=email]'); i++) box = box.parentElement;
  const email = box?.querySelector('input[type=email], input[name=email]');
  const submit = box && ([...box.querySelectorAll('button')].find((b) => b.innerText.trim() === '로그인') ?? box.querySelector('button[type=submit]'));
  if (!email || !submit) return { found: false };
  email.setAttribute('data-fsw', 'login-email');
  pw.setAttribute('data-fsw', 'login-password');
  submit.setAttribute('data-fsw', 'login-submit');
  return { found: true };
}

export function pageInboxRows() {
  return [...document.querySelectorAll('a[href*="inbox_group_id="]')].filter((a) => /inbox_group_id=\d+/.test(a.getAttribute('href'))).map((a) => ({
    href: a.getAttribute('href'),
    nickname: a.querySelector('.font-bold')?.innerText ?? '',
    time: a.querySelector('p[class*="typo-12"]')?.innerText ?? '',
    preview: a.querySelector('.truncate')?.innerText ?? '',
  }));
}

export async function pageSelectTab(label) {
  const tab = [...document.querySelectorAll('button[aria-selected]')].find((b) => b.innerText.trim() === label);
  if (!tab) return { ok: false, reason: 'no tab ' + label };
  if (tab.getAttribute('aria-selected') !== 'true') tab.click();
  for (let i = 0; i < 20 && tab.getAttribute('aria-selected') !== 'true'; i++) await new Promise((r) => setTimeout(r, 150));
  await new Promise((r) => setTimeout(r, 1500));
  return { ok: tab.getAttribute('aria-selected') === 'true', empty: document.body.innerText.includes('안 읽은 메시지가 없어요') };
}

export function pageOpenRow(id) {
  const a = document.querySelector(`a[href*="inbox_group_id=${id}&"]`);
  if (!a) return false;
  a.click();
  return true;
}

export function pageThread() {
  const stamps = [...document.querySelectorAll('p')].filter((p) => /^\d{2}\.\d{2}\.\d{2}\s+\d{2}:\d{2}$/.test(p.innerText.trim()));
  const bubbles = stamps.map((p) => {
    const row = p.closest('div.relative.flex');
    const all = row ? row.innerText : '';
    const stamp = p.innerText;
    const text = all.endsWith(stamp) ? all.slice(0, -stamp.length) : all.replace(stamp, '');
    return { text: text.trim(), stamp: stamp.replace(/\s+/g, ' '), outbound: !!row?.classList.contains('flex-row-reverse') };
  });
  const ta = document.querySelector('textarea');
  const send = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '전송');
  if (ta) ta.setAttribute('data-fsw', 'composer');
  if (send) send.setAttribute('data-fsw', 'send');
  return {
    url: location.href,
    gigHrefs: [...document.querySelectorAll('a[href^="/gig/"]')].map((a) => a.getAttribute('href')),
    bubbles,
    // An unreachable counterpart renders a read-only textarea (placeholder 대화할 수 없는 회원입니다).
    composer: { found: !!ta, disabled: !!ta && (ta.disabled || ta.readOnly), placeholder: ta?.placeholder ?? null, value: ta?.value ?? '', sendButton: !!send, sendDisabled: !!send?.disabled, fileInput: !!document.querySelector('[data-testid=dropzone-layout] input[type=file]') },
  };
}

export function pageOrders(testids) {
  const counters = {};
  for (const id of testids) {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (el) counters[id] = el.innerText;
  }
  return { counters, emptyState: document.body.innerText.includes('조회 기간에 거래 내역이 없어요') };
}
