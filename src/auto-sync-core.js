export function getNextScheduledTime(time, timeZone, now = new Date()) {
  const [hour, minute] = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time || "")?.slice(1).map(Number) || [1, 0];
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  } catch {
    formatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  }
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  for (let index = 0; index < 60 * 48; index += 1, candidate.setMinutes(candidate.getMinutes() + 1)) {
    const parts = formatter.formatToParts(candidate);
    const localHour = Number(parts.find((part) => part.type === "hour")?.value);
    const localMinute = Number(parts.find((part) => part.type === "minute")?.value);
    if (localHour === hour && localMinute === minute) return new Date(candidate);
  }
  return new Date(now.getTime() + 24 * 60 * 60 * 1000);
}
