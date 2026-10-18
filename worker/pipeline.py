"""Deterministic, non-generative NLP pipeline for reviewed journal text."""
from __future__ import annotations

import hashlib
import math
import re
from collections import Counter
from dataclasses import dataclass
from typing import Any

import numpy as np
from sklearn.decomposition import NMF
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

MAX_TEXT_CHARS = 100_000
EXTRACTION_VERSION = "rules-en-1.0.0"


class InputError(ValueError):
    pass


def utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def codepoint_to_utf16(value: str, index: int) -> int:
    return utf16_length(value[:index])


def content_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def validate_text(value: Any) -> str:
    if not isinstance(value, str):
        raise InputError("text must be a Unicode string")
    if not value.strip():
        raise InputError("text is empty")
    if len(value) > MAX_TEXT_CHARS:
        raise InputError("text exceeds the supported length; it was not truncated")
    if "\x00" in value:
        raise InputError("text contains a null character")
    return value


def evidence(text: str, start: int, end: int, entry_id: str, revision: int) -> dict[str, Any]:
    quote = text[start:end]
    return {
        "entryId": entry_id,
        "entryRevision": revision,
        "quote": quote,
        "start": codepoint_to_utf16(text, start),
        "end": codepoint_to_utf16(text, end),
        "offsetConvention": "utf16-code-unit",
        "contentHash": content_hash(text),
        "extractionVersion": EXTRACTION_VERSION,
    }


FIRST_PERSON = {"i", "we"}
CATEGORY_LEMMAS = {
    "desire": {"want", "wish", "hope", "aspire", "desire"},
    "goal": {"plan", "aim", "intend"},
    "commitment": {"promise", "commit", "pledge"},
    "decision": {"decide", "choose", "resolve"},
    "idea": {"consider", "explore", "could"},
    "principle": {"value", "believe", "matter"},
    "constraint": {"cannot", "can't", "lack", "limit", "prevent"},
    "resource": {"have", "own", "access"},
}


def classify_sentence(sent: Any, text: str, entry_id: str, revision: int) -> dict[str, Any]:
    root = sent.root
    subject = next((tok for tok in sent if tok.dep_ in {"nsubj", "nsubjpass"} and tok.head == root), None)
    subject_text = subject.text if subject is not None else None
    is_first_person = subject is not None and subject.lemma_.lower() in FIRST_PERSON
    negated = any(tok.dep_ == "neg" and (tok.head == root or tok.head.head == root) for tok in sent)
    tentative = any(tok.lemma_.lower() in {"might", "may", "perhaps", "maybe", "consider"} for tok in sent)
    category = "uncategorized"
    lemma_set = {tok.lemma_.lower() for tok in sent}
    if is_first_person:
        for candidate, lemmas in CATEGORY_LEMMAS.items():
            if lemma_set.intersection(lemmas):
                category = candidate
                break
    elif sent.text.strip().endswith("?"):
        category = "question"
    start, end = sent.start_char, sent.end_char
    state = "withdrawn" if negated and category in {"desire", "goal", "commitment"} else "suggested"
    return {
        "id": hashlib.sha256(f"{entry_id}:{revision}:{start}:{end}:{category}".encode()).hexdigest()[:32],
        "category": category,
        "originalWording": sent.text,
        "label": sent.text.strip(),
        "subject": "self" if is_first_person else subject_text,
        "negated": negated,
        "modality": "tentative" if tentative else "stated",
        "temporal": {"referenceDateRequired": any(tok.lemma_.lower() in {"tomorrow", "next", "later"} for tok in sent)},
        "state": state,
        "evidence": [evidence(text, start, end, entry_id, revision)],
    }


def extract_keywords(doc: Any) -> list[dict[str, Any]]:
    counts: Counter[str] = Counter()
    for chunk in doc.noun_chunks:
        term = " ".join(tok.lemma_.lower() for tok in chunk if not tok.is_stop and not tok.is_punct).strip()
        if len(term) >= 3:
            counts[term] += 1
    for tok in doc:
        if tok.pos_ in {"NOUN", "PROPN"} and not tok.is_stop and len(tok.text) >= 3:
            counts[tok.lemma_.lower()] += 1
    return [{"term": term, "count": count} for term, count in counts.most_common(24)]


def textrank_summary(doc: Any, max_sentences: int = 3) -> list[dict[str, Any]]:
    sentences = [sent for sent in doc.sents if len(sent.text.strip()) >= 12]
    if len(sentences) <= max_sentences:
        chosen = sentences
    else:
        matrix = TfidfVectorizer(stop_words="english").fit_transform([sent.text for sent in sentences])
        graph = cosine_similarity(matrix)
        np.fill_diagonal(graph, 0)
        scores = np.full(len(sentences), 1 / len(sentences))
        for _ in range(30):
            row_sums = graph.sum(axis=1)
            normalized = np.divide(graph, row_sums[:, None], out=np.zeros_like(graph), where=row_sums[:, None] != 0)
            scores = 0.15 / len(sentences) + 0.85 * normalized.T.dot(scores)
        ranked = sorted(range(len(sentences)), key=lambda idx: (-scores[idx], idx))
        selected: list[int] = []
        for idx in ranked:
            if all(graph[idx, other] < 0.72 for other in selected):
                selected.append(idx)
            if len(selected) == max_sentences:
                break
        chosen = [sentences[idx] for idx in sorted(selected)]
    return [{"text": sent.text, "start": codepoint_to_utf16(doc.text, sent.start_char), "end": codepoint_to_utf16(doc.text, sent.end_char)} for sent in chosen]


def related_entries(texts: list[str]) -> list[list[float]]:
    if len(texts) < 2 or not any(value.strip() for value in texts):
        return []
    try:
        matrix = TfidfVectorizer(stop_words="english", min_df=1).fit_transform(texts)
    except ValueError:
        return []
    return np.round(cosine_similarity(matrix), 6).tolist()


def discover_topics(texts: list[str], max_topics: int = 6) -> dict[str, Any]:
    if len(texts) < 4 or len(set(value.strip().lower() for value in texts)) < 3:
        return {"method": "phrase-groups", "topics": [], "reason": "insufficient-distinct-text"}
    try:
        vectorizer = TfidfVectorizer(stop_words="english", min_df=2, max_df=0.95)
        matrix = vectorizer.fit_transform(texts)
    except ValueError:
        return {"method": "phrase-groups", "topics": [], "reason": "empty-vocabulary"}
    components = min(max_topics, matrix.shape[0] - 1, matrix.shape[1] - 1)
    if components < 2:
        return {"method": "phrase-groups", "topics": [], "reason": "invalid-matrix-dimensions"}
    model = NMF(n_components=components, init="nndsvda", random_state=17, max_iter=400)
    model.fit(matrix)
    terms = vectorizer.get_feature_names_out()
    topics = []
    for index, component in enumerate(model.components_):
        top = [str(terms[i]) for i in component.argsort()[-8:][::-1]]
        topics.append({"id": f"nmf-{index}", "terms": top, "label": " / ".join(top[:3])})
    return {"method": "nmf-tfidf", "version": "sklearn-nmf-1", "topics": topics}


@dataclass
class Pipeline:
    nlp: Any

    def analyze(self, payload: dict[str, Any]) -> dict[str, Any]:
        text = validate_text(payload.get("text"))
        entry_id = str(payload.get("entryId", ""))
        revision = int(payload.get("entryRevision", 0))
        if not entry_id or revision < 1:
            raise InputError("entryId and a positive entryRevision are required")
        doc = self.nlp(text)
        items = [classify_sentence(sent, text, entry_id, revision) for sent in doc.sents]
        entities = []
        for ent in doc.ents:
            if ent.label_ not in {"PERSON", "ORG"}:
                continue
            entities.append({
                "name": ent.text,
                "type": "person" if ent.label_ == "PERSON" else "organization",
                "confirmed": False,
                "evidence": evidence(text, ent.start_char, ent.end_char, entry_id, revision),
            })
        return {
            "schemaVersion": 1,
            "entryId": entry_id,
            "entryRevision": revision,
            "contentHash": content_hash(text),
            "language": "en",
            "offsetConvention": "utf16-code-unit",
            "entities": entities,
            "items": items,
            "keywords": extract_keywords(doc),
            "summary": textrank_summary(doc),
            "limitations": ["Suggestions require review", "Similarity is lexical, not proof of meaning"],
        }
