import assert from "node:assert/strict";
import test from "node:test";
import { ptyInputState, mergePtyModifiers, modifiedPtySequence, modifiedTypedPtyText } from "../src/web-ui/pty-input-state.js";

test("latched modifiers stay enabled across letters and input views, and do not leak to another session", () => {
  const owner = "modifier-owner-A";
  ptyInputState.toggle(owner, "ctrl");
  assert.equal(modifiedPtySequence("a", ptyInputState.read(owner)), "\x01");
  assert.equal(modifiedPtySequence("b", ptyInputState.read(owner)), "\x02");
  ptyInputState.update(owner, { mode: "keyboard" });
  assert.equal(ptyInputState.read(owner).ctrl, true);
  assert.deepEqual(ptyInputState.read("modifier-owner-B"), {mode:"shortcuts",ctrl:false,shift:false,open:false});
  ptyInputState.toggle(owner, "ctrl");
  assert.equal(modifiedPtySequence("a", ptyInputState.read(owner)), null);
});

test("physical and latched modifiers share xterm cursor and character encoding", () => {
  ptyInputState.update("cursor-owner", { ctrl:true, shift:true });
  const modifiers = mergePtyModifiers("cursor-owner", {ctrl:false,shift:false});
  assert.equal(modifiedPtySequence("left", modifiers), "\x1b[1;6D");
  assert.equal(modifiedPtySequence("up", {ctrl:true,shift:false}), "\x1b[1;5A");
  assert.equal(modifiedPtySequence("right", {ctrl:false,shift:true}), "\x1b[1;2C");
  assert.equal(modifiedPtySequence("pageup", modifiers), "\x1b[5;6~");
  assert.equal(modifiedPtySequence("tab", {ctrl:false,shift:true}), "\x1b[Z");
  assert.equal(modifiedPtySequence("z", modifiers), "\x1a");
  assert.equal(modifiedPtySequence("c", {ctrl:false,shift:true}), "C");
  assert.equal(modifiedPtySequence("enter", modifiers), null, "Enter retains the separate CR submission contract");
});

test("soft keyboard letters can form controls without transforming pasted text or IME commits", () => {
  const ctrl = {ctrl:true,shift:false};
  assert.equal(modifiedTypedPtyText("d", {inputType:"insertText",data:"d"}, ctrl), "\x04");
  assert.equal(modifiedTypedPtyText(" ", {inputType:"insertText",data:" "}, ctrl), "\x00");
  assert.equal(modifiedTypedPtyText("d", {inputType:"insertFromPaste",data:"d"}, ctrl), null);
  assert.equal(modifiedTypedPtyText("ni", {inputType:"insertCompositionText",data:"ni"}, ctrl), null);
  assert.equal(modifiedTypedPtyText("你", {inputType:"insertText",data:"你"}, ctrl), null);
  assert.equal(modifiedTypedPtyText("draft", {inputType:"insertText",data:"t"}, ctrl), null);
});

test("modifier snapshots are immutable and identical updates do not notify React roots", () => {
  const owner = "notification-owner";
  ptyInputState.update(owner, {ctrl:true});
  const before = ptyInputState.read(owner);
  let calls = 0;
  const release = ptyInputState.subscribe(() => { calls++; });
  ptyInputState.update(owner, {ctrl:true});
  assert.equal(calls, 0); assert.equal(ptyInputState.read(owner), before); assert.equal(Object.isFrozen(before), true);
  ptyInputState.toggle(owner, "shift");
  assert.equal(calls, 1); assert.equal(before.shift, false); assert.equal(ptyInputState.read(owner).shift, true);
  release();
});
