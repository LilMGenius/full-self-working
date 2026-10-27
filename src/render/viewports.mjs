// The viewport sweep every rendered surface is checked at: phones from 320 px, tablets, laptops and a
// 1920 px desktop, each at a height that device class ships with, plus a short landscape laptop. One list
// so the portfolio quality score and job acceptance (090) can never drift apart (AGENTS.md executionIsCheap: every
// width from 320 to 1920 at several heights).
export const VIEWPORTS = Object.freeze([
  { width: 320, height: 568 },
  { width: 360, height: 740 },
  { width: 390, height: 844 },
  { width: 414, height: 896 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
]);

export const viewportName = ({ width, height }) => width + 'x' + height;
