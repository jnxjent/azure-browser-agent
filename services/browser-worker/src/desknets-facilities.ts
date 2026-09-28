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
  facilityType?: "meeting_room" | "reception_room" | "any",
): T[] {
  return facilities.filter((facility) =>
    isMeetingRoomFacilityName(facility.facilityId) &&
    (facilityType === "reception_room" ? facility.facilityId.normalize("NFKC").includes("応接室") :
      facilityType === "meeting_room" ? !facility.facilityId.normalize("NFKC").includes("応接室") : true),
  );
}

function normalizeFacilityName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").toUpperCase();
}
