// Database and API errors as sentences people can act on. Raw messages are
// never shown for constraint names, and nothing here is logged.
import { DataError } from "@/lib/data/api";
import { AuthError } from "@/lib/auth/client";

const BY_MESSAGE: [RegExp, string][] = [
  [/Slot is no longer available/i, "Slot is no longer available. Please choose another time."],
  [/Only patients can hold slots/i, "Only patients can reserve a time."],
  [/No patient profile/i, "Please complete your profile before booking."],
  [/Only staff can book for another patient/i, "Only clinic staff can book for someone else."],
  [/not affiliated with this facility/i, "This clinician isn't working at that clinic on that day."],
  [/Not allowed to cancel/i, "This appointment can no longer be cancelled online. Please call the clinic."],
  [/Not allowed to reschedule/i, "This appointment can no longer be moved online. Please call the clinic."],
  [/Invalid appointment status change: (\w+) -> (\w+)/i, "That change isn't possible from the appointment's current status."],
  [/cannot be changed; reschedule instead/i, "The time, patient and clinician can't be changed. Reschedule instead."],
  [/Consent can only be given for an upcoming or current/i, "Consent can only be given for an upcoming or current appointment."],
  [/Only the patient or clinician of this appointment can consent/i, "Only the patient or clinician of this appointment can consent."],
  [/Both patient and clinician must consent/i, "Recording needs both you and the other person to consent first."],
  [/consent is missing or was withdrawn/i, "Recording stopped: consent was withdrawn."],
  [/Recording is only allowed during the consultation/i, "Recording is only possible during the consultation."],
  [/Recording session is no longer open|Recording session is not open/i, "This recording has already ended."],
  [/Not a participant of this appointment/i, "Only the patient or clinician of this appointment can do this."],
  [/Transcript is not awaiting review|Only transcripts awaiting review/i, "This transcript has already been reviewed."],
  [/Review window has expired/i, "The review period for this transcript has ended, so it will be deleted."],
  [/Transcript not found/i, "Transcript not found."],
  [/Vitals can only be recorded once the patient has checked in/i, "Vitals can be recorded once the patient has checked in."],
  [/no insurance policy on the visit date/i, "The patient had no insurance policy on the visit date, so a claim can't be made."],
  [/Policy does not belong to this patient or was not valid/i, "That policy wasn't valid for this patient on the visit date."],
  [/Only staff can moderate ratings/i, "Only clinic staff can moderate ratings."],
  [/Appointment not found/i, "Appointment not found."],
  [/Self check-in opens 30 minutes before/i, "You can check in from 30 minutes before your appointment until 15 minutes after it starts."],
  [/Only a booked appointment can be checked in/i, "This appointment is already checked in or no longer active."],
  [/is not a draft/i, "This draft has already been reviewed."],
  [/Only the treating clinician or staff can/i, "Only the treating clinician or clinic staff can do this."],
  [/Answer is not an option of this question/i, "Choose one of the listed answers."],
  [/Value does not match the field/i, "That value doesn't fit this field. Please check it."],
  [/already resolved|already answered/i, "This has already been handled."],
  [/Only staff can view agent activity/i, "Only clinic staff can view agent activity."],
  [/Invalid login credentials/i, "Email or password is incorrect."],
  [/Email not confirmed/i, "Please confirm your email first. Check your inbox for the link."],
  [/User already registered/i, "An account with this email already exists. Try signing in or resetting your password."],
  [/Invalid TOTP code|invalid.*code/i, "That code didn't work. Check your authenticator app and try again."],
  [/Password should be at least/i, "Passwords need at least 8 characters."],
  [/Auth session missing|JWT expired/i, "Your session has ended. Please sign in again."],
  [/Transcription failed, please retry/i, "That part of the recording couldn't be transcribed. Retrying."],
];

const BY_CODE: Record<string, string> = {
  "23P01": "This overlaps an existing record for the same dates.",
  "23505": "That value is already in use.",
  "23514": "Some values are outside the allowed range. Please check the form.",
  "23502": "Please fill in the required fields.",
  "23503": "Please choose an option from the list.",
  "42501": "You don't have permission to do that.",
  PGRST116: "That record wasn't found, or you don't have access to it.",
  PGRST301: "Your session has ended. Please sign in again.",
};

const CHECK_HINTS: [RegExp, string][] = [
  [/medicare_number/, "Medicare number must be 10 digits."],
  [/medicare_irn/, "Medicare IRN must be a number from 1 to 9."],
  [/ihi_number/, "IHI must be 16 digits."],
  [/date_of_birth/, "Date of birth can't be in the future."],
  [/ahpra/, "AHPRA registration number looks like MED0001234567 (3 letters, 10 digits)."],
  [/medicare_provider_number/, "Medicare provider number is 6 digits then 2 letters or digits, e.g. 2451101J."],
  [/visit_vitals_check2/, "Enter at least one measurement."],
  [/visit_vitals_check1/, "Systolic must be higher than diastolic."],
  [/visit_vitals_check"/, "Enter both systolic and diastolic blood pressure."],
  [/(addresses|residency|policies|_registrations|affiliations)_check/, "The end date must be after the start date. A record added today can be edited but not ended until tomorrow."],
];

export function friendlyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? "");
  for (const [re, text] of BY_MESSAGE) if (re.test(message)) return text;
  if (err instanceof DataError && err.code) {
    if (err.code === "23514" || err.code === "23P01") {
      for (const [re, text] of CHECK_HINTS) if (re.test(message)) return text;
    }
    if (BY_CODE[err.code]) return BY_CODE[err.code];
  }
  if (err instanceof AuthError) return message || "Sign-in failed. Please try again.";
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return "Can't reach the server. Check your connection and try again.";
  }
  return "Something went wrong. Please try again.";
}
