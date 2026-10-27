// The sign-in probe of a board whose signed-in pages are not mapped yet (upwork, fiverr; 080 U8.5): open a page
// that needs the account in the operator's session and read where it landed. A redirect to the board's login
// route or a bot wall (kit challengeOf) is signed out; anything else is unknown (null), never signed in, since
// no positive signed-in marker has been recorded for these boards. Reading true waits for that recording.
import { challengeOf } from './kit.mjs';

// Page-side: where the page is and what it says, for the login route and the bot-wall check.
export function pageSignIn() {
  return { url: location.href, title: document.title, text: (document.body?.innerText ?? '').slice(0, 2000) };
}

// loginRoute: a RegExp tested against the landed URL.
export async function probeSignIn(session, { startUrl, loginRoute }) {
  const landed = await session.navigate(startUrl);
  const page = (await session.evaluate(pageSignIn)) ?? {};
  const url = String(page.url ?? landed ?? '');
  if (loginRoute.test(url)) return { loggedIn: false, detail: 'redirected to the login page ' + url };
  const challenge = challengeOf(page);
  if (challenge) return { loggedIn: false, detail: 'challenge: ' + challenge };
  return { loggedIn: null, detail: 'no signed-in marker is mapped; the page stayed on ' + url };
}
