"""Small, explicit regression/evaluation set. Not a production accuracy claim."""
from pipeline import Pipeline, codepoint_to_utf16, discover_topics, related_entries
import spacy

CASES = [
    ("I want to open a bakery.", "desire", "self", False, "stated"),
    ("Ahmed wants to open a bakery.", "uncategorized", "Ahmed", False, "stated"),
    ("I no longer want to open a bakery.", "desire", "self", True, "stated"),
    ("I might explore a bakery.", "idea", "self", False, "tentative"),
    ("I promised Sarah I would call tomorrow.", "commitment", "self", False, "stated"),
]

nlp = spacy.load("en_core_web_sm")
assert "transformer" not in nlp.pipe_names
pipeline = Pipeline(nlp)
passed = 0
for index, (text, category, subject, negated, modality) in enumerate(CASES):
    result = pipeline.analyze({"text": text, "entryId": f"case-{index}", "entryRevision": 1})
    item = result["items"][0]
    ok = (item["category"], item["subject"], item["negated"], item["modality"]) == (category, subject, negated, modality)
    passed += int(ok)
    if not ok:
        print("FAIL", text, item)

assert codepoint_to_utf16("A😀ب", 2) == 3
assert related_entries(["", ""]) == []
assert discover_topics(["same"])["method"] == "phrase-groups"
print(f"Rule evaluation: {passed}/{len(CASES)} exact cases passed; this is a regression set, not real-world accuracy.")
raise SystemExit(0 if passed == len(CASES) else 1)
