import type { FacilitySchedule, TimeInterval } from "@azure-browser-agent/agent-core";
import { assertFacilityAvailable } from "./desknets-facility-conflicts.js";

export function resolveLiveRoomChange(schedules: FacilitySchedule[], slot: TimeInterval, query: string, scope?: string, exclude?: string) {
  const available = schedules.filter(room => {
    try { assertFacilityAvailable([room],room.facilityId,slot); return room.facilityId !== exclude; }
    catch (error) { if (error instanceof Error && error.message.includes("埋まっています")) return false; throw error; }
  }).map(room=>room.facilityId);
  const normalize = (s:string) => s.normalize("NFKC").replace(/\s+/g,"");
  const all = schedules.map(room=>room.facilityId);
  const exact = all.find(name=>normalize(name)===normalize(query));
  const matches = available.filter(name=>exact ? name===exact : normalize(name).includes(normalize(query)));
  const alternatives = available.filter(name=>!scope || normalize(name).startsWith(normalize(scope)));
  const facilityId = matches[0];
  const known = all.some(name=>normalize(name).includes(normalize(query)));
  const message = `指定した会議室「${query}」は、指定した日時には${known ? "埋まっています" : "確認できません"}。\n` +
    (alternatives.length ? `${scope ?? "指定日時で"}の以下の会議室は空いています。\n${alternatives.map(name=>`・${name}`).join("\n")}\n会議室名を指定してください。` : `${scope ?? "指定日時"}には空いている会議室がありません。別の場所または日時を指定してください。`);
  return {facilityId, available, alternatives, message};
}
