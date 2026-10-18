"""One-request-per-line JSON protocol. Stdout is protocol only."""
import json
import os
import sys
import traceback

import spacy

from pipeline import InputError, Pipeline


def send(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    model_name = os.environ.get("NLP_MODEL", "en_core_web_sm")
    nlp = spacy.load(model_name)
    if "transformer" in nlp.pipe_names:
        raise RuntimeError("Transformer pipelines are prohibited")
    pipeline = Pipeline(nlp)
    send({"type": "ready", "model": nlp.meta.get("name", model_name), "version": nlp.meta.get("version"), "pipes": nlp.pipe_names})
    for line in sys.stdin:
        request_id = None
        try:
            message = json.loads(line)
            request_id = message.get("requestId")
            if message.get("type") == "ping":
                send({"type": "pong", "requestId": request_id})
                continue
            if message.get("type") != "analyze":
                raise InputError("unsupported request type")
            send({"type": "result", "requestId": request_id, "result": pipeline.analyze(message["payload"])})
        except InputError as exc:
            send({"type": "error", "requestId": request_id, "code": "INVALID_TEXT", "message": str(exc)})
        except Exception:
            print(json.dumps({"event": "worker_error", "requestId": request_id, "trace": traceback.format_exc(limit=2)}), file=sys.stderr, flush=True)
            send({"type": "error", "requestId": request_id, "code": "ANALYSIS_FAILED", "message": "Text analysis failed"})


if __name__ == "__main__":
    main()
