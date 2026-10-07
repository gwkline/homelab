// CronJob schedules as the controller parses them: five space-separated
// fields (minute hour day-of-month month day-of-week). Each field is a comma
// list of `*`, `n`, or `a-b`, any of them optionally `/step`; month and
// day-of-week also take three-letter names. Macros like @daily are refused.
interface CronField {
  max: number;
  min: number;
  // names[i] stands for min + i.
  names?: string[];
}

const FIELDS: CronField[] = [
  { max: 59, min: 0 },
  { max: 23, min: 0 },
  { max: 31, min: 1 },
  {
    max: 12,
    min: 1,
    names: [
      "JAN",
      "FEB",
      "MAR",
      "APR",
      "MAY",
      "JUN",
      "JUL",
      "AUG",
      "SEP",
      "OCT",
      "NOV",
      "DEC",
    ],
  },
  {
    max: 6,
    min: 0,
    names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"],
  },
];

const valueOf = (token: string, field: CronField): number | null => {
  const named = field.names?.indexOf(token.toUpperCase()) ?? -1;
  let n = Number.NaN;
  if (named !== -1) {
    n = field.min + named;
  } else if (/^\d{1,2}$/u.test(token)) {
    n = Number(token);
  }
  return n >= field.min && n <= field.max ? n : null;
};

const validItem = (item: string, field: CronField): boolean => {
  const [range = "", step, ...extra] = item.split("/");
  if (extra.length > 0) {
    return false;
  }
  if (step !== undefined && !(/^\d{1,2}$/u.test(step) && Number(step) > 0)) {
    return false;
  }
  if (range === "*") {
    return true;
  }
  const [lo = "", hi, ...more] = range.split("-");
  const from = valueOf(lo, field);
  if (from === null || more.length > 0) {
    return false;
  }
  if (hi === undefined) {
    return true;
  }
  const to = valueOf(hi, field);
  return to !== null && from <= to;
};

export const validCronSchedule = (schedule: string): boolean => {
  const fields = schedule.trim().split(/\s+/u);
  return (
    fields.length === FIELDS.length &&
    fields.every((value, i) => {
      const field = FIELDS[i];
      return (
        field !== undefined &&
        value.split(",").every((item) => validItem(item, field))
      );
    })
  );
};
