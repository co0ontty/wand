# Composer Edge Dock — Design QA

## Scope

Compact Codex-style Web composer selected as direction 2. The inspected scope is
the bottom composer and its responsive/interactive states; existing conversation
content and session count are fixture data, not part of this redesign.

## Visual source and captures

- Source reference:
  `/Users/co0ontty/.codex/generated_images/019f9437-4617-7fa3-b22b-a7022fcb41bf/call_3h6U1iSA7E5rn7eKddxR090a.png`
  (`1487 × 1058`)
- Matched implementation board:
  `output/product-design/composer-edge-dock-2026-07-24/implementation-board.png`
  (`1487 × 1058`)
  - desktop state: `1120 × 1058`
  - mobile state: `367 × 1058`
  - both states use the same three-line draft and one text attachment as the
    reference
- Full same-input comparison:
  `output/product-design/composer-edge-dock-2026-07-24/source-vs-implementation.png`
- Focused same-input composer comparison:
  `output/product-design/composer-edge-dock-2026-07-24/composer-source-vs-implementation.png`
- Additional implementation captures:
  - `desktop-final-1440x1024.png`
  - `desktop-attachment-1440x1024.png`
  - `mobile-final-390x844.png`
  - `mobile-attachment-390x844.png`

## Visible comparison review

- The implementation keeps the selected reference's growing writing area,
  compact fixed action rail, copper send button, attachment strip, and low-noise
  model/thinking summary.
- The implemented dock is intentionally a little tighter than the reference,
  following the user's follow-up request: one-pixel top/bottom rules, 12/9 px
  corner treatment, 40 px desktop actions, and 44 px touch actions.
- The attachment strip is integrated inside the outer dock boundary instead of
  floating as a second card. This is the chosen refinement for clearer top/bottom
  structure and prevents attachment overlap.
- The reference's generic model/permission labels are replaced by the real
  session values. Mode, refresh, prompt optimization, terminal interaction, and
  the full model/thinking controls remain available from the `+` menu.
- No unresolved P0, P1, or P2 visual mismatch remains in the composer scope.

## Browser interaction QA

- Desktop `1440 × 1024`: dock `920 × 115`, textarea `71 px` with
  `scrollHeight = 71`, no horizontal overflow, one-pixel top/bottom borders,
  40 px action targets.
- Mobile `390 × 844`: dock stays at `x = 6`, `right = 384`, action targets are
  `44 × 44`, and the structured-session joystick remains hidden.
- Narrow mobile `320 × 568`: dock stays within `6 px` side margins, the send
  button remains visible, thinking summary collapses, and document overflow is
  zero.
- Fifteen-line mobile draft: textarea caps at `180 px`, switches to internal
  scrolling (`scrollHeight = 360`), and the send button remains inside the
  viewport. Returning to the three-line draft shrinks correctly to `105 px`.
- Empty draft + no attachment disables and visually mutes send.
- Attachment-only input enables send; removal disables it again.
- Attachment strip is `26 px` on desktop and `30 px` on mobile, with horizontal
  overflow available for additional chips.
- `+` menu opens above the dock and remains inside both desktop and mobile
  viewports; upload, prompt optimization, mode, model, and thinking controls are
  reachable; Escape closes the menu and updates `aria-expanded`.
- Shift+Enter inserts at the selection, preserves the caret, grows the textarea,
  and does not submit.
- Reloaded multi-line drafts resize on first visible frame rather than clipping.
- Browser console after the final pass: zero warnings and zero errors.

## Automated checks

- `npm run check`: passed (browser bundle, generated Web assets, and all three
  TypeScript programs).
- `git diff --check`: passed.
- Focused architecture/legacy-host/shell tests: `30 / 30` passed.
- Full repository suite: `336 / 339` passed. The three failures are pre-existing
  native/overlay/sidebar source-contract failures unrelated to this Web composer:
  iOS subagent window height, quick-commit controller dismissal, and shell
  sidebar source contract.

## Physical-device status

Physical-device automation could not be completed in this environment:

- `adb devices -l`: no connected Android device.
- `adb mdns services`: no discoverable wireless Android device.
- `xcrun devicectl`: unavailable with the installed Command Line Tools.

The preview is reachable on the LAN at `http://192.168.0.149:18445/`, so the
remaining physical-device pass can be run immediately once a phone is connected
or opens that address on the same network. Browser responsive testing is not
reported as physical-device testing.

Final result: passed
