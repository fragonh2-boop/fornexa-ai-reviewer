import assert from "node:assert/strict";
import test from "node:test";
import {
  isCannotReplyToMessageError,
  slackPlatformErrorCode,
} from "../src/slack-errors.js";

test("reconoce cannot_reply_to_message sin depender de una clase concreta del SDK", () => {
  const error = {
    code: "slack_webapi_platform_error",
    data: { ok: false, error: "cannot_reply_to_message" },
  };
  assert.equal(slackPlatformErrorCode(error), "cannot_reply_to_message");
  assert.equal(isCannotReplyToMessageError(error), true);
  assert.equal(isCannotReplyToMessageError(new Error("cannot_reply_to_message")), false);
  assert.equal(isCannotReplyToMessageError(null), false);
});
