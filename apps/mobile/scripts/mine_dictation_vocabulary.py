#!/usr/bin/env python3
"""Mine a dictation vocabulary from local Claude Code transcripts.

Speech recognisers bias toward general English. Anything project-specific -
"Convex", "relay", "TestFlight", "pbxproj" - gets mangled into the nearest
common word. This script reads the transcripts on this machine, keeps only the
text the *user* actually typed, and ranks the terms worth biasing toward.

Output is a JSON asset consumed by the iOS recogniser:
  - `terms`    -> SFSpeechAudioBufferRecognitionRequest.contextualStrings
  - `phrases`  -> training data for an iOS 17 SFSpeechLanguageModel
  - `persona`  -> style stats, used to prompt any downstream cleanup pass

Nothing leaves the machine. Run it yourself:

    python3 apps/mobile/scripts/mine_dictation_vocabulary.py

Transcripts are personal, so the generated asset is gitignored by default;
every contributor mines their own.
"""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import Counter
from datetime import datetime
from pathlib import Path

# contextualStrings is a bias list, not a dictionary. Apple degrades badly when
# it is flooded, so this stays well inside the 100 slots the iOS side allows -
# the tail of the ranking is mostly ordinary English, which biasing actively
# hurts. The remaining slots are filled at load time from the checked-in seed
# list (assets/dictation_seed_vocabulary.json), which is high-signal by hand.
DEFAULT_TERM_LIMIT = 70
DEFAULT_PHRASE_LIMIT = 400

# A "user" turn is not all human text. The harness injects tool output, task
# notifications, and command scaffolding into the same field, and the user
# pastes stack traces and minified bundles into it. All of that has to go, or
# the vocabulary fills up with `duration_ms` and `tool-use-id`.
NOISE_PATTERNS = [
    # Any XML-ish block the harness injects (task-notification, system-reminder,
    # local-command-stdout, ...). Matched generically so new ones are covered.
    re.compile(r"<([a-z][a-z0-9-]*)>.*?</\1>", re.S | re.I),
    re.compile(r"</?[a-z][a-z0-9-]*/?>", re.I),  # orphaned tags
    # Image attachment trailer, singular and plural, plus the harness preamble.
    re.compile(r"^Attached image files?:.*", re.M | re.S),
    re.compile(r"Please inspect the attached image\(s\)\.", re.I),
    re.compile(r"Caveat: The messages below were generated.*", re.S),
    re.compile(r"```.*?```", re.S),  # pasted code is typed, not spoken
    re.compile(r"https?://\S+"),
    re.compile(r"/(?:Users|var|tmp|private)/\S+"),  # absolute paths
]

# Beyond this, a "prompt" is a paste - a stack trace, a log dump, a bundle.
# The median real prompt is ~20 words, so this is generous.
MAX_PROMPT_WORDS = 400

# Words a recogniser already handles. Biasing toward them wastes slots and can
# actively hurt - "the" in contextualStrings makes "the" more likely everywhere.
STOPWORDS = set("""
a about after again all also am an and another any are as at back be because been
before being better both but by came can cant come could day did didnt do does
doesnt doing dont down each even every few first for from get gets getting give go
going good got had has have having he her here hers him his how i id if ill im in
into is isnt it its ive just keep know last let like ll little long look made make
many may me might more most much must my need never new no not now of off on once
one only or other our out over own put ran re right run said same say see set she
should since so some still such take than that the their them then there these they
thing things think this those though through time to too try two up us use used
using very want was way we well went were what when where which while who why will
with wont would yeah yes yet you your youre s t ve don doesn didn won isn couldn
shouldn wouldn ok okay pls plz thx really actually maybe something anything nothing
everything someone anyone please thanks thank sure fine nice cool great done
""".split())

# Terms that survive only as noise: single letters, pure numbers, hex blobs.
JUNK = re.compile(r"^(?:\d+|[0-9a-f]{6,}|.{1,2})$", re.I)

TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9'’_.-]*")
SENTENCE_SPLIT = re.compile(r"[.!?\n]+")


def is_prose(line: str) -> bool:
    """Does this line read like something a person could say out loud?

    Dictation vocabulary should come from spoken-shaped sentences. Code, JSON,
    and log lines are typed or pasted and would poison the bias list.
    """
    words = line.split()
    if len(words) < 2:
        return False
    # Minified bundles and hashes arrive as enormous unbroken tokens.
    if max(len(word) for word in words) > 30:
        return False
    letters = sum(char.isalpha() or char.isspace() for char in line)
    if letters / len(line) < 0.72:
        return False
    # Shell prompts, pasted commands, and source punctuation. A dictated
    # sentence contains none of these.
    if any(char in line for char in '➜$`"{}'):
        return False
    if any(marker in line for marker in ("};", "=>", "();", "});", "':", "&&", "||", "git:(", "curl ", " -H ", "::")):
        return False
    return True


def strip_noise(text: str) -> str:
    for pattern in NOISE_PATTERNS:
        text = pattern.sub(" ", text)
    return "\n".join(line for line in text.splitlines() if is_prose(line))


def iter_typed_prompts(root: Path):
    """Yield (timestamp, text) for everything the user actually typed.

    Two sources carry human text: `user` entries whose content is a bare string,
    and `queue-operation` enqueues. They overlap heavily, so the caller dedupes.
    """
    for path in sorted(root.glob("*/*.jsonl")):
        project = path.parent.name
        try:
            handle = path.open(errors="ignore")
        except OSError:
            continue
        with handle:
            for line in handle:
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                kind = entry.get("type")
                text = None
                if kind == "user":
                    content = entry.get("message", {}).get("content")
                    # A list means tool_result plumbing - never human text.
                    if isinstance(content, str):
                        text = content
                elif kind == "queue-operation" and entry.get("operation") == "enqueue":
                    text = entry.get("content")

                if not text or not text.strip():
                    continue
                yield project, entry.get("timestamp"), text


class TermStat:
    """Per-term evidence, keyed by lowercase so casing variants merge."""

    __slots__ = ("count", "docs", "proper", "forms")

    def __init__(self) -> None:
        self.count = 0
        self.docs = 0
        self.proper = 0  # capitalised while not sentence-initial
        self.forms: Counter = Counter()

    def observe(self, surface: str, sentence_initial: bool) -> None:
        self.count += 1
        self.forms[surface] += 1
        if surface[0].isupper() and not sentence_initial:
            self.proper += 1

    def surface(self) -> str:
        """The spelling to hand the recogniser - the one actually used most."""
        return self.forms.most_common(1)[0][0]


def tokenize(text: str) -> list[tuple[str, bool]]:
    """Yield (surface, sentence_initial) so casing can be interpreted."""
    out: list[tuple[str, bool]] = []
    for sentence in SENTENCE_SPLIT.split(text):
        for index, match in enumerate(TOKEN.finditer(sentence)):
            token = match.group(0).strip("'’_.-")
            if token:
                out.append((token, index == 0))
    return out


def load_lexicon() -> set[str]:
    """General-English wordlist, used as the "already handled" baseline."""
    for path in (Path("/usr/share/dict/words"), Path("/usr/dict/words")):
        if path.is_file():
            return {line.strip().lower() for line in path.open(errors="ignore") if line.strip()}
    return set()


def known_word(key: str, lexicon: set[str]) -> bool:
    """Is this ordinary English, allowing for inflection?

    The system wordlist stores base forms only, so a bare membership test rates
    `changes`, `tests`, and `pushed` as exotic and hands them a novelty bonus
    they have not earned. Strip the common English suffixes and re-check.
    """
    if key in lexicon:
        return True
    base = key.split("'")[0]  # let's -> let, what's -> what
    if base != key and base in lexicon:
        return True

    candidates: list[str] = []
    for suffix, stems in (
        ("ies", lambda w: [w[:-3] + "y"]),
        ("es", lambda w: [w[:-2], w[:-1]]),
        ("s", lambda w: [w[:-1]]),
        ("ed", lambda w: [w[:-2], w[:-1], w[:-3]]),
        ("ing", lambda w: [w[:-3], w[:-3] + "e", w[:-4]]),
    ):
        if key.endswith(suffix) and len(key) > len(suffix) + 1:
            candidates.extend(stems(key))
    return any(c in lexicon for c in candidates if c)


def score_terms(stats: dict[str, "TermStat"], total_docs: int, lexicon: set[str]) -> list[tuple[str, float]]:
    """Rank terms by how much recogniser bias they actually deserve.

    Raw frequency returns filler, so the score combines five signals:

      1. damped frequency - saying a word 500x is not 10x the evidence of 50x.
      2. spread across prompts - a term in many separate prompts is vocabulary;
         one repeated inside a single prompt is an artefact.
      3. lexical novelty - the decisive signal. A term absent from the system
         wordlist (`pbxproj`, `testflight`, `riverpod`, `e2e`) is exactly what a
         general-English recogniser cannot produce, so it earns its slot. A
         plain dictionary word (`file`, `work`, `change`) is already handled and
         gets pushed down.
      4. proper-noun usage - `Convex`, `Panda`, `Flutter` are dictionary words
         used as product names. Capitalisation away from sentence start recovers
         them from the penalty in (3).
      5. shape - camelCase and dotted/snake identifiers are mangled by default.
    """
    scored: list[tuple[str, float]] = []
    for key, stat in stats.items():
        spread = stat.docs / total_docs if total_docs else 0
        frequency = 1 + math.log(stat.count)
        breadth = math.sqrt(spread)

        if lexicon and not known_word(key, lexicon):
            lexical = 3.0  # out-of-vocabulary: the recogniser cannot guess it
        elif stat.count and stat.proper / stat.count > 0.5:
            lexical = 1.8  # dictionary word, but used as a proper noun
        else:
            lexical = 0.5  # ordinary English, already recognised fine

        surface = stat.surface()
        shape = 1.0
        if any(c.isupper() for c in surface[1:]):
            shape *= 1.6  # camelCase / TestFlight
        if any(c in surface for c in "._-"):
            shape *= 1.4  # dotted or snake identifiers
        if not surface.isascii():
            shape *= 1.2

        scored.append((surface, frequency * breadth * lexical * shape))
    scored.sort(key=lambda pair: (-pair[1], pair[0]))
    return scored


def mine_phrases(prompts: list[str], vocabulary: set[str], limit: int) -> list[str]:
    """Short sentences containing domain terms, for the custom language model.

    SFSpeechLanguageModel learns from realistic sentences, not word lists, so we
    keep the user's own phrasing rather than synthesising templates.
    """
    seen: set[str] = set()
    phrases: list[tuple[int, str]] = []
    for prompt in prompts:
        for raw in SENTENCE_SPLIT.split(prompt):
            sentence = " ".join(raw.split())
            if not 3 <= len(sentence.split()) <= 18:
                continue
            key = sentence.lower()
            if key in seen:
                continue
            hits = sum(1 for token in TOKEN.findall(key) if token in vocabulary)
            if hits == 0:
                continue
            seen.add(key)
            phrases.append((hits, sentence))
    phrases.sort(key=lambda pair: -pair[0])
    return [sentence for _, sentence in phrases[:limit]]


def profile(prompts: list[str], stamps: list[str], projects: Counter) -> dict:
    """Style statistics. Half diagnostics, half fun."""
    joined = " ".join(prompts).lower()
    words = [w for p in prompts for w in TOKEN.findall(p.lower())]
    lengths = [len(p.split()) for p in prompts]

    hours = Counter()
    for stamp in stamps:
        if not stamp:
            continue
        try:
            hours[datetime.fromisoformat(stamp.replace("Z", "+00:00")).hour] += 1
        except ValueError:
            continue

    def rate(pattern: str) -> float:
        hits = len(re.findall(pattern, joined))
        return round(hits / max(len(prompts), 1), 3)

    return {
        "prompts": len(prompts),
        "words": len(words),
        "median_prompt_words": sorted(lengths)[len(lengths) // 2] if lengths else 0,
        "mean_prompt_words": round(sum(lengths) / max(len(lengths), 1), 1),
        "longest_prompt_words": max(lengths, default=0),
        "busiest_hours_utc": [hour for hour, _ in hours.most_common(4)],
        "projects_touched": len(projects),
        "top_projects": [name for name, _ in projects.most_common(5)],
        "also_per_prompt": rate(r"\balso\b"),
        "please_per_prompt": rate(r"\bplease\b|\bpls\b"),
        "thanks_per_prompt": rate(r"\bthanks\b|\bthx\b"),
        "urgency_per_prompt": rate(r"\bnow\b|\basap\b|\bquick\b|\bfast\b"),
        "question_per_prompt": rate(r"\?"),
        "profanity_per_prompt": rate(r"\bfuck\w*\b|\bshit\b|\bdamn\b"),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--projects-dir",
        type=Path,
        default=Path.home() / ".claude" / "projects",
        help="directory of Claude Code transcripts",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "assets" / "dictation_vocabulary.json",
    )
    parser.add_argument("--terms", type=int, default=DEFAULT_TERM_LIMIT)
    parser.add_argument("--phrases", type=int, default=DEFAULT_PHRASE_LIMIT)
    args = parser.parse_args()

    if not args.projects_dir.is_dir():
        raise SystemExit(f"no transcripts at {args.projects_dir}")

    lexicon = load_lexicon()
    stats: dict[str, TermStat] = {}
    projects: Counter = Counter()
    prompts: list[str] = []
    stamps: list[str] = []
    deduped: set[str] = set()

    for project, stamp, raw in iter_typed_prompts(args.projects_dir):
        text = strip_noise(raw).strip()
        if not text or len(text.split()) > MAX_PROMPT_WORDS:
            continue
        key = " ".join(text.lower().split())
        if key in deduped:  # enqueue + user entry carry the same prompt
            continue
        deduped.add(key)

        prompts.append(text)
        stamps.append(stamp)
        projects[project] += 1

        seen_here: set[str] = set()
        for surface, sentence_initial in tokenize(text):
            key = surface.lower().replace("’", "'")
            if key in STOPWORDS or key.replace("'", "") in STOPWORDS or JUNK.match(key):
                continue
            stat = stats.setdefault(key, TermStat())
            stat.observe(surface, sentence_initial)
            if key not in seen_here:
                seen_here.add(key)
                stat.docs += 1

    if not prompts:
        raise SystemExit("found no user-typed prompts")

    ranked = score_terms(stats, len(prompts), lexicon)
    terms = [term for term, _ in ranked[: args.terms]]
    # Phrase mining uses a wider net than the shipped bias list.
    wide = {term.lower() for term, _ in ranked[: args.terms * 6]}

    payload = {
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source_prompts": len(prompts),
        "terms": terms,
        "term_scores": {term: round(score, 3) for term, score in ranked[: args.terms]},
        "phrases": mine_phrases(prompts, wide, args.phrases),
        "persona": profile(prompts, stamps, projects),
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    print(f"{len(prompts)} prompts -> {len(terms)} terms, {len(payload['phrases'])} phrases")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
