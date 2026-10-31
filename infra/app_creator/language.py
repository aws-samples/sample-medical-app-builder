"""
Which language the author is writing in — decided by code, not left to the model.

The system prompt necessarily contains German (the hospital's name, German example requests from the
catalog), which primes a model to answer in German even when the author writes English. So each turn
detects the language of the author's message with a marker-word heuristic and states it to the model as
an instruction: reply in it, and make it the app's display language unless the author asks otherwise.
Short or ambiguous messages ("ok", "yes") inherit the conversation's language; a clear switch is honoured.
"""

from __future__ import annotations

import re
from typing import Literal

Language = Literal["en", "de"]

SUPPORTED: tuple[Language, ...] = ("en", "de")

# Function words and drafting vocabulary; deliberately no names, codes or medical terms (those are shared).
_GERMAN = re.compile(
    r"\b(der|die|das|den|dem|des|ein|eine|einer|einen|und|oder|nicht|mit|für|über|bei|von|zum|zur|ist|sind|"
    r"soll|sollen|kann|können|möchte|möchten|wir|ich|sie|uns|auch|nur|alle|jeder|keine|welche|bitte|"
    r"anzeigen|sehen|zeigen|patienten|patientin|rolle|rollen|verlauf|übersicht|letzten|jahre|monate|"
    r"ärzte|pflege|station|ambulanz|sprechstunde|passt|genau|ja|nein)\b",
    re.IGNORECASE,
)
_ENGLISH = re.compile(
    r"\b(the|a|an|and|or|not|with|for|over|at|of|to|is|are|should|can|could|would|want|need|we|i|you|us|"
    r"also|only|all|each|no|which|please|show|see|display|patient|patients|role|roles|trend|summary|"
    r"last|years|months|doctors|nurses|ward|clinic|outpatient|fine|exactly|yes|ok|okay)\b",
    re.IGNORECASE,
)

LANGUAGE_NAMES: dict[Language, str] = {"en": "English", "de": "German"}


def detect_language(text: str) -> Language | None:
    """'en' or 'de' when the text clearly leans one way; None when there is too little to tell."""
    de = len(_GERMAN.findall(text))
    en = len(_ENGLISH.findall(text))
    if de == en:
        return None
    if max(de, en) < 2 and abs(de - en) < 2:
        return None  # a word or two is not evidence
    return "de" if de > en else "en"


def conversation_language(message: str, previous: str | None) -> Language:
    """The language this turn is held in: the message's when it is clear, else the conversation's so far, else English."""
    detected = detect_language(message)
    if detected:
        return detected
    if previous in SUPPORTED:
        return previous  # type: ignore[return-value]
    return "en"


def language_instruction(lang: Language) -> str:
    """The per-turn block appended to the system prompt."""
    name = LANGUAGE_NAMES[lang]
    return (
        "## This conversation\n"
        f"The author writes in {name}. Reply in {name}. Unless the author asks for another language, {name} is also "
        f'the app\'s display language: set app.language to "{lang}" and write the app name, description, role display names, '
        "chart and section titles and every other display text in it. The hospital's name and the example requests above "
        "are not a signal of the author's language."
    )
