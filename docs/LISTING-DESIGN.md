# DESIGN.md of the kmong listing images

This is the noslop-uiux DESIGN.md for the images buyers see on a kmong gig, the main card and the detail images that src/listings/images.mjs renders. src/render/tokens.mjs carries the values below as data, and test/tokens.test.mjs compares the colour table, the steps and the weights here with it. docs/DESIGN.md stays the architecture source of truth.

## Direction

An ink card that carries one oversized Korean claim and the real screen of shipped work beside it. It breaks the category convention of the kmong search grid on purpose: no stock 3D figures, no generated faces, no award ribbons and no gradient washes, only type and proof.

Reading this as: a service storefront for Korean small-business owners and team leads hiring one developer and designer, with a print-poster language. Two product references stand behind it (named in the phase evidence, since this file names no company): an issue tracker whose marketing pages use a near-black field, one warm accent and the product screen as the only picture, and a Korean payments app whose headlines are set large with whole words kept on one line.

## Audience and job

- Listing main image: a buyer scanning a kmong search grid where each card shows at about 190 px wide among loud, saturated covers. The job is to be read in one glance: what the service is, in two to five Korean syllables, and that real work stands behind it.
- Listing detail images: a buyer who opened the gig and is deciding whether to message. The job is scope, process and proof, in that order.

## What the frontier shows

Captured 2026-10-27 with `node scripts/probe.mjs kmong frontier`: the top three covers of each category a gig was published in, kept in the instance under qa/frontier and never committed.

- Every leading cover sets its claim in display type that fills half the card or more; at grid size that claim is the only text a buyer reads.
- Proof beats decoration where reviews run into the hundreds: the leading photo editing covers are before and after photographs of real work, and the leading data crawling cover is a plain claim on a dark field.
- The earlier covers set the claim at a third of the card width on warm paper with small screens and three bullet lines; at 190 px they read as an empty pale card. That warm paper is also a model default, so it is replaced, with the reason stated here.

## Colour

| Token | Hex | Where it is spent |
|---|---|---|
| ink | #121418 | the card field and the ink detail sections |
| inkRaised | #1D2026 | panels and screen frames on ink |
| paper | #F3F4F6 | the paper detail sections and the paper card ground |
| sheet | #FFFFFF | raised surfaces on paper |
| text | #121418 | body text on paper and sheet |
| muted | #596069 | secondary text on paper and sheet (5.78:1 on paper) |
| line | #D8DBE0 | hairlines on paper and sheet |
| lineOnInk | #33373D | hairlines on ink |
| accent | #CF3315 | the one accent on light grounds (white on it 5.08:1) |
| accentOnInk | #F26A48 | the accent on ink: rules, numbers and short labels (6.08:1) |
| onInk | #F3F4F6 | text on ink (16.75:1) |
| onInkMuted | #A2A8B1 | secondary text on ink (7.70:1) |
| onAccent | #FFFFFF | text on the accent fill |

One hue carries all emphasis; neutrals are cool so the accent stays the only warm colour.

## Type

- One family, Pretendard (assets/fonts, SIL OFL 1.1), inlined as a data URL wherever pixels are produced, so no render waits on a download.
- Weights: body 450, strong 650, display 800. Display is heavier than a reading page would use, because the headline must hold its strokes at 29 percent scale in the grid.
- Scale in px, steps 1 to 10: 13, 15, 17, 20, 24, 32, 44, 60, 88, 112. The listing headline sets at step 10 (112 px on the 652 px card, about 33 px in the grid).
- Korean-first line breaking: `word-break: keep-all` and `overflow-wrap: break-word` on every text block, headlines broken by hand at word boundaries, letter spacing -0.04em at steps 8 and above.
- Numbers are tabular wherever they line up in a column.

## Layout

- Spacing steps in px, 1 to 10: 4, 8, 12, 16, 24, 32, 48, 64, 96, 128. Radius: sm 4, md 8, lg 14, pill 999.
- Listing main card, 652 by 488: the claim on two lines of at most five syllables each, set as large as its box allows, its second line in the accent; the sub-line; and a short list of two or three scope items from the gig's own card copy, since the blind comparison against kmong's top three covers chose concrete scope over an empty field. The proof shows the deliverable of that service itself: a real screen cropped by the card edge and never tilted, or a work sample shown whole and tagged as a sample above it. No badge row and no seller mark on the cover; the AI disclosure lives on every detail image.
- One system, a character per service: each service picks a frame and a ground for its cover in the instance's listing settings. Frames: stage (the claim above a proof stage at the lower right), wide (the claim and the scope as a row above a proof band across the card) and split (the claim and scope at the left of a full-height proof panel). Grounds: ink (ink field, paper stage, accentOnInk) and paper (paper field, sheet stage with a hairline, accent). Tokens, type and the claim treatment stay the same in every combination.
- Listing detail, 860 wide: alternating paper and ink sections, each with one step 7 heading, one paragraph and one proof (a screen, a file listing or a before and after pair).

## Imagery

- Pictures are captures of shipped work and media of paid jobs from the ranked portfolio, and only items the operator authored or whose client allowed portfolio use. A work sample the agent made for a service is labelled as a sample on the image itself.
- No stock photography, generated people, 3D mascots, award or ranking badges, star ratings or review counts on the cover; a figure appears only when a platform record backs it.
- Listing images are static.

## Components

- Screen frame: inkRaised border of 1 px, radius lg on the outer corners only, the capture shown at its own aspect ratio.
- Captions name the client type and the deliverable, never a metric the instance cannot prove.

## Never

Gradient fills or gradient text, glass panels, eyebrow labels above headlines, icon tiles in rows of three, centred hero blocks over a pale ground, warm paper grounds, emoji, exclamation marks in display type, and any figure, award or rank the instance records do not hold. A render that keeps one of these writes `noslop-allow <rule>: <reason>` beside it.
