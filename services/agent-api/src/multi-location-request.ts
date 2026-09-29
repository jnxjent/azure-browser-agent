const LOCATIONS = [
  "ミダックこなん", "奥山の杜CC", "浜名湖CC", "遠州CC", "御殿山",
  "富士宮", "名古屋", "アクト", "有玉", "品川", "奥山", "都田",
];

/** Only explicit requests for one room at each named site use the intersection. */
export function readRequiredFacilityLocations(prompt: string): string[] | undefined {
  const text = prompt.normalize("NFKC");
  if (!/(?:会議室|応接室|ミーティングルーム)/.test(text) ||
      !/(?:それぞれ|各(?:拠点|場所|事務所|本社)|両方|双方|両拠点)/.test(text)) return undefined;
  const locations = LOCATIONS.filter((location) => text.includes(location) &&
    !LOCATIONS.some((longer) => longer !== location && longer.includes(location) && text.includes(longer)));
  return locations.length >= 2 ? locations : undefined;
}
