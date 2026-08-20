// Public holidays used when computing the actual payday.
//
// IMPORTANT: This list is YOUR responsibility. Add the public holidays for the
// country whose labour rules you follow. The payday rule moves a payday that
// lands on a weekend OR a public holiday back to the previous working day.
//
// Cambodia sources these dates from the official calendar (e.g. min.gov.kh).
// The dates below are only a small sample of internationally fixed ones so the
// mechanism works out of the box — please verify and complete the list for
// 2026 (Khmer New Year lands mid-April, Pchum Ben ~early October, Water
// Festival ~mid-November, etc. — all lunar-based, so check the official list).
//
// Format: "YYYY-MM-DD" per day. The flat set below is used at runtime
// regardless of year.
export const HOLIDAYS_BY_YEAR: Record<string, string[]> = {
  "2026": [
    "2026-01-01", // New Year's Day
    "2026-05-01", // Labour Day
    "2026-09-24", // Constitution Day
    "2026-11-09", // Independence Day
    // TODO: add your country's other 2026 public holidays (e.g. Khmer New Year)
  ],
};

export const HOLIDAYS: ReadonlySet<string> = new Set(
  Object.values(HOLIDAYS_BY_YEAR).flat(),
);