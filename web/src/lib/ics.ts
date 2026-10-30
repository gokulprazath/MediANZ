// A one-event .ics file for "Add to calendar". It holds only what the user
// can already see: when, where and with whom. The visit reason is left out.
import { clinicianName } from "@/lib/format";
import type { AppointmentWithRefs } from "@/types/db";

function icsDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function escape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Lines longer than 75 octets are folded (RFC 5545 3.1). */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = ` ${rest.slice(74)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

export function buildIcs(a: AppointmentWithRefs, now = new Date()): string {
  const f = a.facility;
  const location = [f.name, f.address_line1, `${f.suburb} ${f.state} ${f.postcode}`].join(", ");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MediANZ//Appointments//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${a.id}@medianz`,
    `DTSTAMP:${icsDate(now.toISOString())}`,
    `DTSTART:${icsDate(a.scheduled_start)}`,
    `DTEND:${icsDate(a.scheduled_end)}`,
    `SUMMARY:${escape(`Appointment with ${clinicianName(a.clinician)}`)}`,
    `LOCATION:${escape(location)}`,
    `DESCRIPTION:${escape(`${f.name}${f.phone ? `. Phone ${f.phone}` : ""}. For emergencies call 000.`)}`,
    "STATUS:CONFIRMED",
    "BEGIN:VALARM",
    "TRIGGER:-PT1H",
    "ACTION:DISPLAY",
    "DESCRIPTION:Appointment reminder",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
