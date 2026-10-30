// Words in "What do you need help with?" that show the emergency banner first.
// Matching is case-insensitive on whole phrases. This is a safety prompt only;
// the app never assesses symptoms or gives clinical advice.
export const EMERGENCY_PHRASES: string[] = [
  "chest pain",
  "chest pains",
  "chest tightness",
  "heart attack",
  "can't breathe",
  "cant breathe",
  "cannot breathe",
  "can not breathe",
  "struggling to breathe",
  "difficulty breathing",
  "trouble breathing",
  "short of breath",
  "choking",
  "stroke",
  "face drooping",
  "slurred speech",
  "unconscious",
  "not breathing",
  "fainted",
  "seizure",
  "fitting",
  "severe bleeding",
  "bleeding heavily",
  "won't stop bleeding",
  "overdose",
  "poisoned",
  "anaphylaxis",
  "allergic reaction",
  "throat swelling",
  "suicidal",
  "suicide",
  "kill myself",
  "end my life",
  "want to die",
  "self harm",
  "self-harm",
  "hurt myself",
];

export const EMERGENCY_CONTACTS = {
  emergency: { label: "Emergency (ambulance, police, fire)", number: "000" },
  lifeline: { label: "Lifeline crisis support, 24/7", number: "13 11 14" },
};

const normalise = (text: string) =>
  text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9'\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function containsEmergencyWords(text: string): boolean {
  const t = ` ${normalise(text)} `;
  return EMERGENCY_PHRASES.some((p) => t.includes(` ${normalise(p)} `));
}
