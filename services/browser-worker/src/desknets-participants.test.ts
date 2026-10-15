import { chromium } from "playwright";
import { removeRequesterFromRegistration } from "./desknets-participants.js";
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
      /所属部署をdesknet'sから取得できない/,
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
  assert.deepEqual(preferParticipantOrganization([
    { organization: "㈱ミダックライナー 管理グループ" },
    { organization: "ミダックライナー 営業グループ" },
  ], { name: "鈴木", organization: "ミダックライナーの管理G" }), [
    { organization: "㈱ミダックライナー 管理グループ" },
  ]);
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

it("removes only the verified requester and refuses ambiguous or unsupported controls", async () => {
 const browser = await chromium.launch({headless:true});
 try {
  const page = await browser.newPage();
  const row = (name:string, button=true) => `<tr><td class="name-text">${name}</td><td>${button ? '<button onclick="this.closest(\'tr\').remove()">削除</button>' : ''}</td></tr>`;
  const fixture = async (rows:string) => page.setContent(`<div class="co-sel-dialog"><div class="co-sel-bottom"><table><tbody>${rows}</tbody></table></div></div>`);
  await fixture(row("田中社長")+row("秘書")+row("鈴木"));
  assert.equal(await removeRequesterFromRegistration(page,"秘書"),"秘書");
  assert.deepEqual(await page.locator(".name-text").allTextContents(),["田中社長","鈴木"]);
  await assert.rejects(removeRequesterFromRegistration(page,undefined),/表示名/);
  await assert.rejects(removeRequesterFromRegistration(page,"不明"),/一意/);
  await fixture(row("秘書")+row("秘書"));
  await assert.rejects(removeRequesterFromRegistration(page,"秘書"),/一意/);
  assert.equal(await page.locator("tr").count(),2);
  await fixture(`<tr><th><a href="#" title="選択を解除" class="co-sel-icon remove-item" onclick="event.preventDefault();this.closest('tr').remove()">x</a><a class="name-text" data-refid="user186">秘書</a></th></tr>` + row("田中社長"));
  assert.equal(await removeRequesterFromRegistration(page,"秘書"), "秘書");
  assert.deepEqual(await page.locator(".name-text").allTextContents(), ["田中社長"]);
  await fixture(row("秘書",false)+row("田中社長"));
  await assert.rejects(removeRequesterFromRegistration(page,"秘書"),/削除ボタン/);
  assert.equal(await page.locator("tr").count(),2);
 } finally {await browser.close();}
});
