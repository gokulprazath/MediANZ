// Recording consent wording "v2" (consent_text_versions.version = 'v2', which
// covers AI analysis: the consult-notes worker only drafts notes from a
// transcript when both consents are a version with covers_ai_analysis).
// Shown in the consent panel (4.5, 5.2) and on the privacy page. Changing this
// text means a new version string, recorded with every consent.
export const CONSENT_VERSION = "v2";

export const CONSENT_TITLE = "Recording this consultation";

export const CONSENT_POINTS: { heading: string; text: string }[] = [
  {
    heading: "What is recorded",
    text: "The conversation between you and your clinician during this consultation, turned into a written transcript.",
  },
  {
    heading: "Audio is not stored",
    text: "The audio is turned into text as it is recorded and then discarded. No audio is saved anywhere.",
  },
  {
    heading: "You review the transcript first",
    text: "You can read the draft transcript and approve or reject it. Rejected drafts, and drafts you don't review within the review period, are deleted.",
  },
  {
    heading: "AI help with the notes",
    text: "After you approve the transcript, AI tools draft notes from it, such as medicines, test results and follow-ups, for your clinician to check. Nothing is added to your record until your clinician approves it.",
  },
  {
    heading: "Who can see the transcript",
    text: "You can see your drafts and approved transcripts. Your clinician can see a transcript only after you approve it. Clinic reception staff cannot see transcripts.",
  },
  {
    heading: "Both of you must agree",
    text: "Recording starts only when both you and your clinician have agreed. Either of you can withdraw at any time; withdrawing stops the recording and deletes every transcript and AI draft for this appointment.",
  },
];
