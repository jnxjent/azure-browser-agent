/** Phase1: native screen preparation only; never registration or authentication. */
export function buildDeskNetsHandoffUrl(input: {
  start: string; end: string; userIds: string[];
}, now = new Date()): string {
  const start = new Date(input.start), end = new Date(input.end);
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) ||
      !/(Z|[+-]\d{2}:\d{2})$/.test(input.start) || !/(Z|[+-]\d{2}:\d{2})$/.test(input.end) ||
      start <= now || end <= start) throw new Error("候補の日時が無効か、開始時刻を過ぎています。再検索してください。");
  if (start.getUTCSeconds() || start.getUTCMilliseconds() || end.getUTCSeconds() || end.getUTCMilliseconds()) {
    throw new Error("日時は分単位で指定してください。");
  }
  if (!input.userIds.length || input.userIds.length > 100 || new Set(input.userIds).size !== input.userIds.length ||
      input.userIds.some(id=>!/^\d{1,20}$/.test(id))) throw new Error("参加者IDを確認できません。候補を再作成してください。");
  const parts = (date: Date) => {
    const jst = new Date(date.getTime()+9*60*60*1000).toISOString();
    return {date:jst.slice(0,10).replaceAll('-',''),time:jst.slice(11,16).replace(':','')};
  };
  const s=parts(start), e=parts(end);
  const hash=new URLSearchParams({cmd:'schaddtarget',date:s.date,enddate:e.date,starttime:s.time,endtime:e.time});
  input.userIds.forEach(id=>hash.append('id',id));
  return `https://desknets.midac.jp/dneo/dneo.cgi?cmd=schindex#${hash}`;
}
