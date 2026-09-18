/** Candidate search window in Japan local time; the entire meeting must fit. */
export function readMeetingHours(env: NodeJS.ProcessEnv = process.env): { start: string; end: string } {
  const start = env.DESKNETS_MEETING_START_TIME?.trim() || "09:00";
  const end = env.DESKNETS_MEETING_END_TIME?.trim() || "17:00";
  for (const [name, value] of [["DESKNETS_MEETING_START_TIME", start], ["DESKNETS_MEETING_END_TIME", end]]) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value!)) {
      throw new Error(`${name} は HH:mm 形式（00:00〜23:59）で設定してください。`);
    }
  }
  if (start >= end) throw new Error("打ち合わせ可能時間の開始は終了より前に設定してください。");
  return { start, end };
}
