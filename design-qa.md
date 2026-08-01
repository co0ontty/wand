# Design QA — Web Composer Redesign

## Comparison Target

- Source visual truth: `/Users/co0ontty/.codex/visualizations/2026/07/30/019fb55b-c855-7f01-897d-da9362cff932/wand-composer-redesign/source.png`
- Browser-rendered implementation: `/Users/co0ontty/.codex/visualizations/2026/07/30/019fb55b-c855-7f01-897d-da9362cff932/wand-composer-redesign/implementation-desktop.png`
- Final normalized comparison: `/Users/co0ontty/.codex/visualizations/2026/07/30/019fb55b-c855-7f01-897d-da9362cff932/wand-composer-redesign/comparison-final.png`
- Local implementation URL: `http://127.0.0.1:18443/`
- Theme and state: light theme, authenticated structured Claude session, populated draft, full-access mode, Sonnet model, xhigh thinking, active send action.

## Viewport and Normalization

- Source pixels: `814 × 129`.
- Implementation full-view pixels / CSS viewport: `1111 × 1324`, device density `1×`.
- Implementation composer CSS box: `751 × 114` at the measured desktop viewport.
- Focused implementation crop: normalized to `814 × 129` and vertically stacked with the source in one comparison image.
- Mobile evidence: `390 × 844`, device density `1×`, saved as `implementation-mobile.png`.
- The source is a component crop rather than a complete viewport. Comparison therefore uses an equal-pixel focused crop and treats the implementation's responsive full-parent width as an intentional product constraint.

## Evidence Reviewed

- Full view: `implementation-desktop.png` confirms the composer remains anchored at the bottom of the live Wand shell without obscuring conversation content.
- Focused region: `comparison-final.png` compares the reference and implementation at equal `814 × 129` pixels; this is required because typography, rail alignment, icons, radius, and elevation are too small to judge reliably in the full-page screenshot.
- Responsive view: `implementation-mobile.png` confirms the writing area wraps without collision, the compact rail remains usable, and touch targets remain `44px`.
- Expanded content: `implementation-multiline.png` confirms the textarea grows while the rail stays fixed at the bottom.
- Popover: `implementation-popover.png` confirms the `+` menu aligns with its trigger and stays clear of the send action.
- Browser console: no warnings or errors were reported during the final verification pass.

## Required Fidelity Surfaces

- Fonts and typography: the implementation uses Wand's existing system-sans stack. Draft text is `15px/1.5` on desktop with the same visual inset and line position as the reference. Compact controls use a lighter optical weight and truncate long dynamic model names without wrapping into the rail.
- Spacing and layout rhythm: the empty desktop surface is `114px` high with a `22px` radius, a `72px` writing band, and a `40px` action rail. The draft begins about `13px` from the left edge and `18px` from the top, matching the normalized reference. Mobile keeps a `58px + 52px` structure and grows only when the draft wraps.
- Colors and visual tokens: orange access state, purple high-thinking state, dark primary send action, thin neutral border, and soft elevation follow the source hierarchy while retaining Wand's warm surface tokens and focus treatment.
- Image quality and asset fidelity: the target contains no photographic or raster product assets. All visible UI icons reuse Wand's existing icon renderer; no placeholder, emoji, CSS drawing, or replacement image was introduced.
- Copy and content: the reference draft text is reproduced exactly. `full-access` now presents consistently as “完全访问”. Model text remains live application data rather than hardcoded reference copy.
- Icons and controls: plus, shield, chevron, optimize, and up-arrow icons are optically aligned. Web intentionally keeps the native-only microphone hidden because recording is not implemented on this surface.
- Accessibility and behavior: the composer has named groups, the permission label is a polite live status, queue mode receives a distinct accessible label, DOM order follows visual order, and the textarea no longer consumes Tab as a literal character. Reduced-motion, reduced-transparency, high-contrast, and mobile touch-target rules remain intact.

## Findings

- No actionable P0, P1, or P2 differences remain.
- [P3] Product-specific controls differ from the reference.
  - Location: right side of the action rail.
  - Evidence: the source shows a microphone; Wand Web shows its existing prompt-optimization action and hides the native-only microphone.
  - Impact: minor visual difference, with no loss of working Web functionality.
  - Disposition: accepted product constraint; do not expose a non-functional recording affordance.
- [P3] The normalized implementation card is about `15px` wider than the source card.
  - Location: outer composer width.
  - Evidence: source card is approximately `736px` wide; the implementation is `751px` in the measured parent.
  - Impact: negligible at this viewport and preserves Wand's tested full-parent PTY layout contract.
  - Disposition: accepted responsive adaptation.

## Comparison History

1. Pass 1 — `/Users/co0ontty/.codex/visualizations/2026/07/30/019fb55b-c855-7f01-897d-da9362cff932/wand-composer-redesign/comparison-pass-1.png`
   - [P2] The action rail sat roughly `4px` too high, the `36px` send circle was visibly larger than the source, and the plus icon was about `5px` too far right.
   - Fixes: changed desktop bands from `64px + 48px` to `72px + 40px`, reduced the send circle to `32px`, and rebalanced the left rail padding while keeping the popover anchored to the trigger.
2. Pass 2 — `/Users/co0ontty/.codex/visualizations/2026/07/30/019fb55b-c855-7f01-897d-da9362cff932/wand-composer-redesign/comparison-final.png`
   - Post-fix evidence shows matching `114px` surface height, text baseline, rail baseline, left control alignment, radius, and send-action scale. No actionable P0/P1/P2 finding remains.

## Open Questions

- None blocking. If microphone input is implemented for Web later, its intended slot is already preserved beside the send action.

## Implementation Checklist

- [x] Separate the writing band from the bottom action rail.
- [x] Keep access context on the left and runtime/send controls on the right.
- [x] Preserve attachments, permission actions, queue mode, optimization, and complete settings in the `+` menu.
- [x] Align the `+` popover with its trigger at desktop and mobile widths.
- [x] Verify active, multiline, popover, desktop, and `390px` responsive states.
- [x] Verify generated assets, TypeScript checks, unit tests, and browser console output.

## Follow-up Polish

- [P3] Add the microphone only when Web speech input has a real implementation and permission flow.

## Component Select Follow-up — 2026-08-01

- Replaced the composer's transparent native mode/model/thinking selects with the existing `WandSelect` component backed by Radix Select. The legacy composer now exposes typed portal slots while React owns trigger, listbox, option, focus, and selection semantics.
- Kept compact rail values (`完全访问`, short model name, localized thinking depth) while the opened listbox shows full model names and availability states.
- Removed the persistent boxed native-focus appearance. Resting triggers are unboxed; hover/open states use a quiet token background, while keyboard focus receives a contained two-pixel ring.
- Verified pointer selection and state synchronization from both the main rail and the `+` menu. Selecting inside the nested menu closes it after the value commits and updates every composer instance.
- Verified ArrowDown opening, Escape closing with focus restoration, portalled option interaction, and protection from terminal-interactive key capture.
- Verified the model list at desktop and `390 × 844`; the content collision boundary remains inside the viewport, mobile options keep `44px` targets, and the compact rail does not overflow.
- Browser console remained free of warnings and errors during the final component pass.

final result: passed

## Inline Model Refresh Follow-up — 2026-08-01

- Added the existing model-catalog refresh action directly beside the composer's model selector; the `+` menu entry remains available and both controls share one delegated request path.
- Verified the live busy contract: the button becomes disabled with `aria-busy="true"` and `is-refreshing`, then returns to enabled with `aria-busy="false"` after the refreshed catalog is applied.
- Kept the control visually secondary at `34 × 34px` on desktop while preserving a measured `44 × 44px` touch target at `390px` and on coarse-pointer layouts.
- Verified the real refresh request in the in-app browser, successful model-list repopulation, desktop/mobile layout, HTTP 200, and an empty browser console log.

final result: passed
