import assert from "node:assert/strict";
import test from "node:test";
import { isMeshControlAuthorized, parseMeshPingTarget } from "../src/mesh-control.js";

test("MESH control accepts only an exact target payload", () => {
  assert.equal(parseMeshPingTarget('{"to":"CLAUDE"}'), "CLAUDE");
  assert.equal(parseMeshPingTarget('{"to":"CLAUDE","text":"deploy"}'), null);
  assert.equal(parseMeshPingTarget('{"to":3}'), null);
  assert.equal(parseMeshPingTarget('[]'), null);
});

test("MESH control requires an exact bearer token", () => {
  assert.equal(isMeshControlAuthorized("Bearer control-token", "control-token"), true);
  assert.equal(isMeshControlAuthorized("Bearer control-token-extra", "control-token"), false);
  assert.equal(isMeshControlAuthorized(undefined, "control-token"), false);
  assert.equal(isMeshControlAuthorized("Bearer control-token", null), false);
});
