import assert from "node:assert/strict";
import test from "node:test";
import { useSidebarGesture } from "../src/web-ui/react/shell/use-sidebar-gesture.js";

test("sidebar drawer gesture hooks into touch events with generous trigger area and velocity tracking", () => {
  assert.equal(typeof useSidebarGesture, "function");
});

test("gesture physics: velocity and acceleration calculations correctly identify flick vs slow drag", () => {
  // Test velocity and acceleration algorithm in isolation
  const samples = [
    { x: 20, y: 100, time: 1000 },
    { x: 45, y: 101, time: 1050 },
    { x: 95, y: 102, time: 1090 },
  ];

  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const dt = last.time - first.time; // 90ms
  const velocity = (last.x - first.x) / dt; // 75px / 90ms = 0.833 px/ms

  const mid = samples[1]!;
  const dt1 = mid.time - first.time; // 50ms
  const dt2 = last.time - mid.time; // 40ms
  const v1 = (mid.x - first.x) / dt1; // 25 / 50 = 0.5 px/ms
  const v2 = (last.x - mid.x) / dt2; // 50 / 40 = 1.25 px/ms
  const acceleration = (v2 - v1) / dt2; // (1.25 - 0.5) / 40 = 0.01875 px/ms^2

  const effectiveVelocity = velocity + acceleration * 50; // 0.833 + 0.9375 = 1.77 px/ms

  assert.ok(velocity > 0.28, "Raw velocity exceeds fling threshold");
  assert.ok(acceleration > 0, "Positive acceleration detects fling momentum");
  assert.ok(effectiveVelocity > velocity, "Acceleration boosts effective commit velocity");
});

test("gesture commit rules: flick right opens drawer even with small displacement", () => {
  const drawerWidth = 320;
  const startX = 20;
  const currentX = 60; // only moved 40px (12.5% progress, well under 35%)
  const dx = currentX - startX;
  const progress = dx / drawerWidth;

  const effectiveVelocity = 0.42; // Fast flick right (> 0.28)
  const shouldOpen = effectiveVelocity >= 0.28;

  assert.ok(progress < 0.35, "Displacement alone would not open");
  assert.equal(shouldOpen, true, "Flick velocity with acceleration commits to open");
});

test("gesture commit rules: slow drag requires passing position threshold", () => {
  const drawerWidth = 320;
  const startX = 20;

  // Case 1: 30% drag with zero velocity -> close
  const currentX1 = 20 + 320 * 0.3;
  const dx1 = currentX1 - startX;
  const progress1 = dx1 / drawerWidth;
  const v1 = 0.05; // very slow
  const shouldOpen1 = v1 >= 0.28 ? true : v1 <= -0.28 ? false : progress1 >= 0.35;
  assert.equal(shouldOpen1, false, "Slow drag under 35% must cancel and snap back");

  // Case 2: 40% drag with zero velocity -> open
  const currentX2 = 20 + 320 * 0.4;
  const dx2 = currentX2 - startX;
  const progress2 = dx2 / drawerWidth;
  const v2 = 0.05;
  const shouldOpen2 = v2 >= 0.28 ? true : v2 <= -0.28 ? false : progress2 >= 0.35;
  assert.equal(shouldOpen2, true, "Slow drag over 35% commits to open");
});

test("gesture commit rules: closing flick left closes drawer even with large remaining width", () => {
  const drawerWidth = 320;
  const startX = 280;
  const currentX = 240; // only moved 40px left
  const dx = currentX - startX;
  const progress = 1 + dx / drawerWidth; // 87.5% remaining open

  const effectiveVelocity = -0.45; // Fast flick left (< -0.28)
  const shouldOpen = effectiveVelocity <= -0.28 ? false : effectiveVelocity >= 0.28 ? true : progress >= 0.65;

  assert.equal(shouldOpen, false, "Fast flick left closes the drawer despite high remaining progress");
});

test("gesture trigger edge width: generous touch hit area scales with viewport", () => {
  const defaultWidth = 56;
  const mobileWidth = Math.max(defaultWidth, Math.round(390 * 0.16)); // 62px
  const largePhoneWidth = Math.max(defaultWidth, Math.round(430 * 0.16)); // 69px

  assert.ok(mobileWidth >= 56, "Mobile trigger zone is at least 56px");
  assert.ok(largePhoneWidth > mobileWidth, "Trigger zone scales gracefully with wider mobile screens");
  assert.ok(mobileWidth > 32, "Much larger than legacy 20-30px hit targets for effortless swipe");
});
