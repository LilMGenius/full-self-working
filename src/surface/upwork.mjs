// Upwork behind the Surface interface (003) as a shell (080 U8.5, 088 unit 2). Its job feed and proposal form are
// not mapped from a signed-in recording, so login is only the sign-in probe in the operator's session, sense
// returns nothing without loading a page, and read, send, quote and propose throw UNMAPPED before any driver
// call; the drain reads that code as not sent (NOT_TYPED). No signIn: a Google sign-in counts only when login()
// reads true, which the probe cannot yet (080 order 8 maps the marker with its recording).
import { AdapterRefusal } from '../platforms/kit.mjs';
import { probeSignIn } from '../platforms/signin.mjs';
import { authorizedSend, unauthorized } from './shared.mjs';

export const UNMAPPED = 'FSW_UPWORK_UNMAPPED';
export const NOT_TYPED = [UNMAPPED];
// The find-work feed needs the account; a signed-out session lands on the account-security login page.
export const SIGN_IN = { startUrl: 'https://www.upwork.com/nx/find-work/', loginRoute: /\/account-security\/login/ };

const unmapped = (what) => {
  throw new AdapterRefusal(UNMAPPED, 'the upwork ' + what + ' is not mapped from a signed-in recording; nothing was loaded or typed');
};
// The token check runs first, so a forged call is refused for its authorization before the unmapped form.
const write = (kinds, what) => async (ref, { text, authorized } = {}) => {
  const why = authorizedSend(authorized, { platform: 'upwork', ref: String(ref), kinds, text });
  return why ? unauthorized(why) : unmapped(what);
};

export async function openUpworkSurface({ session } = {}) {
  return {
    platform: 'upwork',
    session,
    publicSense: false,
    login: () => probeSignIn(session, SIGN_IN),
    sense: async () => [],
    read: async () => unmapped('job page'),
    send: write(['message', 'delivery'], 'message form'),
    quote: write(['quote'], 'quote, which a proposal replaces,'),
    propose: write(['proposal'], 'proposal form'),
    stop: async () => session?.stop?.(),
  };
}
