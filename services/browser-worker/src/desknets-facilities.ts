const MEETING_ROOM_LABELS = ["会議室", "応接室", "ミーティングルーム"];
const BUSINESS_DEFINED_MEETING_ROOMS = new Set([
  "遠州CC",
  "浜名湖CC",
  "奥山の杜CC",
]);

export function isMeetingRoomFacilityName(value: string): boolean {
  const normalized = normalizeFacilityName(value);
  return (
    MEETING_ROOM_LABELS.some((label) => normalized.includes(label)) ||
    BUSINESS_DEFINED_MEETING_ROOMS.has(normalized)
  );
}

export function keepMeetingRoomFacilities<T extends { facilityId: string }>(
  facilities: T[],
): T[] {
  return facilities.filter((facility) =>
    isMeetingRoomFacilityName(facility.facilityId),
  );
}

function normalizeFacilityName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").toUpperCase();
}
