import type { FacilitySchedule, TimeInterval } from "@azure-browser-agent/agent-core";

/** Validate a freshly read room timeline before offering or committing a booking. */
export function assertFacilityAvailable(
  schedules: FacilitySchedule[], facilityId: string, slot: TimeInterval,
): void {
  const matching = schedules.filter((schedule) => schedule.facilityId === facilityId);
  if (matching.length === 0) throw new Error(`${facilityId}の最新の予約状況を確認できません。空き時間を再検索してください。`);
  const start = Date.parse(slot.start);
  const end = Date.parse(slot.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error("予約日時が不正です。");
  for (const schedule of matching) {
    for (const busy of schedule.busy) {
      const busyStart = Date.parse(busy.start);
      const busyEnd = Date.parse(busy.end);
      if (!Number.isFinite(busyStart) || !Number.isFinite(busyEnd) || busyStart >= busyEnd) {
        throw new Error(`${facilityId}の予約情報を読み取れませんでした。空き時間を再検索してください。`);
      }
      if (start < busyEnd && busyStart < end) {
        throw new Error(`指定した会議室「${facilityId}」は指定した日時には埋まっています。別の会議室または日時を指定してください。`);
      }
    }
  }
}
