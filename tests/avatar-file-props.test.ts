import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { createFileProps, filePagePoint } from "../src/web-ui/react/avatars/file-props.js";

test("turning sheet stays bound to the spine, bends in depth and reaches the left page", () => {
  for (const angle of [0.12, Math.PI / 2, Math.PI - 0.12]) {
    const spine = filePagePoint(0, 0.5, angle);
    assert.equal(spine.x, 0);
    assert.equal(spine.y, 0);
    assert.equal(spine.z, 0.1235);
  }
  assert.ok(filePagePoint(1, 0.5, 0.12).x > 0.5);
  assert.ok(filePagePoint(1, 0.5, Math.PI - 0.12).x < -0.5);
  assert.ok(filePagePoint(0.5, 0.5, Math.PI / 2).z > 0.49);
  assert.ok(filePagePoint(0.5, 0.5, Math.PI / 2).x > 0.09, "mid-turn curvature is not a flat rigid card");
  assert.ok(filePagePoint(0.8, 0.5, 1, 1).z > filePagePoint(0.8, 0.5, 1, -1).z, "paper has separate front/back skin");
});

test("two page cycles and pen contact use real mesh poses; idle hides all props", () => {
  const props = createFileProps({ shape: "round", color: "sage", glasses: "none", hat: "none" }, new THREE.Texture(), () => new THREE.BufferGeometry());
  props.pose("reading", 1.4);
  const initial = props.root.userData.pageAngle;
  assert.ok(initial > 0.5 && initial < 2);
  props.pose("reading", 4.6);
  assert.equal(props.root.userData.pageTurn, 1);
  assert.ok(Math.abs(props.root.userData.pageAngle - initial) < 0.001);
  props.pose("writing", 0.7);
  assert.equal(props.root.userData.nibContact, 0);
  props.pose("idle", 1);
  assert.equal(props.root.visible, false);
});

test("readable and writable normals face the eyes; the camera sees outside covers", () => {
  const props = createFileProps({ shape: "round", color: "sage", glasses: "none", hat: "none" }, new THREE.Texture(), () => new THREE.BufferGeometry());
  props.root.updateMatrixWorld(true);
  for (const surface of props.root.children) {
    const centre = surface.localToWorld(new THREE.Vector3(0, 0, 0.09));
    const normal = new THREE.Vector3(0, 0, 1).transformDirection(surface.matrixWorld);
    const towardEyes = new THREE.Vector3(0, 0.08, 0.63).sub(centre).normalize();
    assert.ok(normal.dot(towardEyes) > 0.90, "reading/writing side faces the character");
    assert.ok(normal.z < -0.50, "text side does not face front camera");
  }
});
