"""Deterministic grounding checks (spec 6.1 check_grounding). Code only, no engine.

A quote is grounded when it appears verbatim (whitespace-normalised) in one of
the given segments. A value is derivable when deterministic parsers find it in
the quote: numbers written as digits or words ("thirty seven point five"),
blood pressure ("142 over 91", "one forty over ninety"), and text values.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from healthmcp.shared.engines.models import ClinicalField, Segment

ValueType = Literal["number", "blood_pressure", "text", "boolean", "object"]
Reason = Literal["ok", "empty_quote", "quote_not_found", "value_not_in_quote", "bad_value"]

_UNITS = {
    "zero": 0, "oh": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17,
    "eighteen": 18, "nineteen": 19,
}  # fmt: skip
_TENS = {
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70,
    "eighty": 80, "ninety": 90,
}  # fmt: skip
_NUMBER_WORDS = set(_UNITS) | set(_TENS) | {"hundred", "point", "and"}
_DIGITS = re.compile(r"\d+(?:\.\d+)?")
_BP = re.compile(r"(?<!\d)(\d{2,3})\s*(?:/|over)\s*(\d{2,3})(?!\d)", re.IGNORECASE)
_TOKEN = re.compile(r"[A-Za-z]+|\d+(?:\.\d+)?|[^\sA-Za-z\d]+|\s+")

# Text values that are rarely said literally.
_SYNONYMS: Mapping[str, tuple[str, ...]] = {
    "never": ("never smoked", "non-smoker", "don't smoke", "do not smoke", "never"),
    "former": ("used to smoke", "quit smoking", "gave up smoking", "ex-smoker", "quit"),
    "current": ("smoker", "i smoke", "still smoke", "cigarettes"),
}


@dataclass(frozen=True)
class Grounding:
    quote_found: bool
    segment_id: UUID | None
    char_start: int | None
    char_end: int | None
    value_derivable: bool
    reason: Reason


def _quote_pattern(quote: str) -> re.Pattern[str] | None:
    tokens = quote.split()
    if not tokens:
        return None
    return re.compile(r"\s+".join(re.escape(t) for t in tokens))


def find_quote(segments: Sequence[Segment], quote: str) -> tuple[UUID, int, int] | None:
    pattern = _quote_pattern(quote)
    if pattern is None:
        return None
    for seg in segments:
        if m := pattern.search(seg.text):
            return seg.id, m.start(), m.end()
    return None


def _word_number(words: list[str]) -> float | None:
    """'one hundred and forty' -> 140, 'thirty seven point five' -> 37.5,
    'one forty' -> 140 (spoken readings)."""
    words = [w for w in words if w != "and"]
    if not words or words[0] in {"point", "hundred"}:
        return None
    whole, current, decimals, seen_point = 0, 0, "", False
    previous: str | None = None
    for w in words:
        if seen_point:
            if w not in _UNITS or _UNITS[w] > 9:
                return None
            decimals += str(_UNITS[w])
            continue
        if w == "point":
            seen_point = True
        elif w == "hundred":
            current = (current or 1) * 100
        elif w in _TENS:
            if previous in _UNITS and 1 <= _UNITS[previous] <= 9 and current < 10:
                current = current * 100 + _TENS[w]  # "one forty"
            else:
                current += _TENS[w]
        elif w in _UNITS:
            if previous in _UNITS and current < 10 and _UNITS[w] < 10:
                return None  # "five six": two numbers, not one
            if previous in _UNITS and 1 <= current <= 9 and 10 <= _UNITS[w] <= 19:
                current = current * 100 + _UNITS[w]  # "one twelve"
            else:
                current += _UNITS[w]
        previous = w
    total = float(whole + current)
    if seen_point:
        if not decimals:
            return None
        total += float(f"0.{decimals}")
    return total


def _word_digit(word: str) -> str:
    if word in _UNITS:
        return str(_UNITS[word])
    if word in _TENS:
        return str(_TENS[word])
    return word


def words_to_digits(text: str) -> str:
    """Replace runs of number words with digits, leaving everything else unchanged."""
    out: list[str] = []
    run: list[str] = []
    gap = ""

    def flush() -> None:
        nonlocal gap
        if run:
            value = _word_number(run)
            if value is None:  # not one number ("five and six"): convert word by word
                out.append(" ".join(_word_digit(w) for w in run))
            else:
                out.append(str(int(value)) if value.is_integer() else str(value))
            run.clear()
        out.append(gap)
        gap = ""

    for token in _TOKEN.findall(text):
        lower = token.lower()
        if lower in _NUMBER_WORDS and (lower != "and" or run):
            if run and gap.strip("- "):
                flush()
            run.append(lower)
            gap = ""
        elif token.isspace() or token == "-":  # noqa: S105 (a hyphen, not a password)
            if run:
                gap += token
            else:
                out.append(token)
        else:
            flush()
            out.append(token)
    flush()
    return "".join(out)


def numbers_in(text: str) -> list[float]:
    return [float(n) for n in _DIGITS.findall(words_to_digits(text))]


def _same(a: float, b: float) -> bool:
    return abs(a - b) < 1e-6


def _number_in(value: Any, quote: str) -> bool:
    if isinstance(value, bool):
        return False
    try:
        wanted = float(value)
    except (TypeError, ValueError):
        return False
    return any(_same(wanted, n) for n in numbers_in(quote))


def _bp_parts(value: Any) -> tuple[int, int] | None:
    if isinstance(value, Mapping):
        try:
            return int(value["systolic"]), int(value["diastolic"])
        except (KeyError, TypeError, ValueError):
            return None
    if isinstance(value, str) and (m := _BP.fullmatch(value.strip())):
        return int(m.group(1)), int(m.group(2))
    return None


def _bp_in(value: Any, quote: str) -> bool:
    parts = _bp_parts(value)
    if parts is None:
        return False
    return any(
        (int(m.group(1)), int(m.group(2))) == parts for m in _BP.finditer(words_to_digits(quote))
    )


def _norm(text: str) -> str:
    return " ".join(text.lower().split())


def _text_in(value: Any, quote: str) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    q = _norm(quote)
    v = _norm(value)
    return v in q or any(s in q for s in _SYNONYMS.get(v, ()))


def _object_in(value: Any, quote: str) -> bool:
    if not isinstance(value, Mapping) or not value:
        return False
    if _bp_parts(value) is not None and set(value) <= {"systolic", "diastolic"}:
        return _bp_in(value, quote)
    for leaf in value.values():
        if isinstance(leaf, str):
            if not _text_in(leaf, quote):
                return False
        elif isinstance(leaf, int | float) and not isinstance(leaf, bool):
            if not _number_in(leaf, quote):
                return False
        elif leaf is not None:
            return False
    return True


def value_derivable(value: Any, value_type: ValueType, quote: str) -> bool:
    if value_type == "number":
        return _number_in(value, quote)
    if value_type == "blood_pressure":
        return _bp_in(value, quote)
    if value_type == "text":
        return _text_in(value, quote)
    if value_type == "boolean":
        return isinstance(value, bool)
    return _object_in(value, quote)


def check(segments: Sequence[Segment], quote: str, value: Any, value_type: ValueType) -> Grounding:
    if not quote.strip():
        return Grounding(False, None, None, None, False, "empty_quote")
    found = find_quote(segments, quote)
    if found is None:
        return Grounding(False, None, None, None, False, "quote_not_found")
    segment_id, start, end = found
    seg = next(s for s in segments if s.id == segment_id)
    derivable = value_derivable(value, value_type, seg.text[start:end])
    return Grounding(
        True, segment_id, start, end, derivable, "ok" if derivable else "value_not_in_quote"
    )


def value_type_for(field: ClinicalField) -> ValueType:
    schema = field.value_schema
    props = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
    if field.id == "bp_reading" or {"systolic", "diastolic"} <= set(props or {}):
        return "blood_pressure"
    kind = schema.get("type")
    if kind in {"number", "integer"}:
        return "number"
    if kind == "string":
        return "text"
    if kind == "boolean":
        return "boolean"
    return "object"
