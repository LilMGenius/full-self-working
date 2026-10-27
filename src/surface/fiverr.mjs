// Fiverr behind the Surface interface (003) as a shell (080 U8.5, 088 unit 2). Its inbox and order pages are not
// mapped from a signed-in recording, so login is only the sign-in probe in the operator's session, sense returns
// nothing without loading a page, and read, send, quote and propose throw UNMAPPED before any driver call; the
// drain reads that code as not sent (NOT_TYPED). Fiverr is a storefront: buyers order a gig, nobody bids.
import { AdapterRefusal } from '../platforms/kit.mjs';
import { probeSignIn } from '../platforms/signin.mjs';

export const UNMAPPED = 'FSW_FIVERR_UNMAPPED';
export const NOT_TYPED = [UNMAPPED];
// The inbox needs the account; a signed-out session lands on /login.
export const SIGN_IN = { startUrl: 'https://www.fiverr.com/inbox', loginRoute: /^https:\/\/[^/]*fiverr\.com\/login(?:[/?#]|$)/ };

const unmapped = (what) => {
  throw new AdapterRefusal(UNMAPPED, 'the fiverr ' + what + ' is not mapped from a signed-in recording; nothing was loaded or typed');
};

export async function openFiverrSurface({ session } = {}) {
  return {
    platform: 'fiverr',
    session,
    publicSense: false,
    login: () => probeSignIn(session, SIGN_IN),
    sense: async () => [],
    read: async () => unmapped('inbox'),
    send: async () => unmapped('message form'),
    quote: async () => unmapped('custom offer form'),
    propose: async () => unmapped('proposal, which a storefront does not take,'),
    stop: async () => session?.stop?.(),
  };
}
