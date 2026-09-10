import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSelfOrganizationParticipants } from "./desknets-participants.js";

describe("resolveSelfOrganizationParticipants", () => {
  it("replaces self-department expressions with the logged-in user's DeskNet's organization", () => {
    for (const reference of ["当部", "自部署", "同じ部"]) {
      assert.deepEqual(
        resolveSelfOrganizationParticipants(
          [{ name: "甲斐", organization: reference }],
          "CP部",
        ),
        [{ name: "甲斐", organization: "CP部" }],
      );
    }
  });

  it("does not change an explicitly named organization", () => {
    const participants = [{ name: "甲斐", organization: "総務部" }];
    assert.equal(resolveSelfOrganizationParticipants(participants, "CP部"), participants);
  });

  it("fails safely when DeskNet's does not expose the current organization", () => {
    assert.throws(
      () => resolveSelfOrganizationParticipants(
        [{ name: "甲斐", organization: "当部" }],
        undefined,
      ),
      /所属部署をDeskNet'sから取得できない/,
    );
  });
});
