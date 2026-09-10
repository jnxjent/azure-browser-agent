/**
 * DeskNet's renders one link per participant row for the same appointment.
 * Treat duplicate DOM links as one appointment only when their targets match.
 */
export function resolveUniqueAppointmentHref(
  hrefs: Array<string | null | undefined>,
): string | undefined {
  const unique = new Set(
    hrefs
      .map((href) => href?.trim())
      .filter((href): href is string => href !== undefined && href !== ""),
  );
  return unique.size === 1 ? [...unique][0] : undefined;
}
