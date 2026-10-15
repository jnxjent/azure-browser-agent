/** Explicit user text takes precedence over inferred/default meeting titles. */
export function readMeetingTitleInstruction(prompt: string): { title: string; onlyTitle: boolean } | undefined {
  const match = /(?:^|[\s、,。])(?:議題|件名)\s*(?:は|を|[:：=])\s*(?:「([^」]*)」|"([^"]*)"|([^\r\n、,。]+))/u.exec(prompt);
  if (!match) return undefined;
  const quoted = match[1] ?? match[2];
  const title = (quoted ?? match[3] ?? "").trim()
    .replace(quoted === undefined ? /(?:に変更(?:してください|して)?|にしてください|にして|でお願いします|です)$/u : /$^/u, "").trim();
  if (!title || title.length > 100 || /[\r\n\t]/.test(title)) {
    throw new TypeError("件名は1〜100文字の1行で指定してください。");
  }
  const remainder = (prompt.slice(0, match.index) + prompt.slice(match.index + match[0].length)).trim();
  return { title, onlyTitle: /^(?:(?:に変更(?:してください|して)?|にしてください|にして|でお願いします|です))?[\s。！!]*$/u.test(remainder) };
}
