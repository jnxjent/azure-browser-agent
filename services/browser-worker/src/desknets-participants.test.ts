import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSelfOrganizationParticipants, preferParticipantOrganization, participantNameSearchVariants } from "./desknets-participants.js";
import { companyHolidayDates } from "./desknets-holidays.js";

it("maps the common Takada spelling to 髙田 before trying the entered spelling", () => {
  assert.deepEqual(participantNameSearchVariants("高田"), ["髙田", "高田"]);
  assert.deepEqual(participantNameSearchVariants("高田廣明"), ["髙田廣明", "高田廣明"]);
  assert.deepEqual(participantNameSearchVariants("髙田廣明"), ["髙田廣明", "高田廣明"]);
  assert.deepEqual(participantNameSearchVariants("山本高田"), ["山本高田"]);
});

describe("resolveSelfOrganizationParticipants", () => {
  it("replaces self-department expressions with the logged-in user's DeskNet's organization", () => {
    for (const reference of ["当部", "自部署", "同じ部"]) {
      assert.deepEqual(
        resolveSelfOrganizationParticipants(
          [{ name: "甲斐", organization: reference }],
          "CP部",
        ),
        [{ name: "甲斐", organization: "CP部", organizationFallback: true }],
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

it("prefers 当部 for the list, falls back company-wide only when absent, and keeps ambiguity", () => {
  const selectors = resolveSelfOrganizationParticipants([
    { name: "髙田", organization: "当部" }, { name: "鈴木清彦" },
    { name: "佐藤", organization: "総務部" },
  ], "経営企画部");
  assert.equal(selectors[1]?.organization, "経営企画部");
  const external = [{ organization: "営業部" }, { organization: "管理部" }];
  assert.deepEqual(preferParticipantOrganization(external, selectors[1]!), external);
  const local = { organization: "経営企画部" };
  assert.deepEqual(preferParticipantOrganization([...external, local], selectors[1]!), [local]);
  assert.deepEqual(preferParticipantOrganization(external, selectors[2]!), []);
  const resolved = resolveSelfOrganizationParticipants([{name: "鈴木清彦", organization: "経営企画部"}], "経営企画部", "当部の髙田部長、鈴木清彦部長");
  assert.equal(resolved[0]?.organizationFallback, true);
});

it("excludes official company holidays including weekdays, without assuming every weekend is closed", () => {
  assert.deepEqual([...companyHolidayDates([
    { date: "20260919", label: "会社休日" },
    { date: "20260921", label: "会社休日：敬老の日" },
    { date: "20260922", label: "会社休日：国民の祝日" },
    { date: "20260923", label: "会議" },
    { date: "invalid", label: "会社休日" },
  ])], ["2026-09-19", "2026-09-21", "2026-09-22"]);
});
