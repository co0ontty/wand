"""Wand's bounded, offline MLX worker. stdout is protocol only; no tools or DB access."""
import json
import os
from pathlib import Path
import sys

MAX_LINE = 65536


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def main():
    # The parent also supplies a minimal env; enforce offline behavior here too.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    import mlx.core as mx
    import laya_mlx as laya
    from laya_mlx.common import collapsed_options, render_options

    if not mx.metal.is_available():
        raise RuntimeError("Metal unavailable")
    model = Path(sys.argv[1])
    if not model.is_absolute() or not model.is_dir():
        raise ValueError("Local model required")
    metadata = json.loads((model / "mlx_config.json").read_text())
    if metadata.get("repository") != "aac6fef/laya-multilingual-mlx":
        raise ValueError("Unexpected checkpoint identity")
    mx.set_cache_limit(128 * 1024**2)
    mx.set_memory_limit(2 * 1024**3)
    agent = laya.load(str(model), device="gpu", dtype="float16", batch_size=1)
    if agent.cfg.get("max_len") != 1024:
        raise ValueError("A 1024-token multilingual checkpoint is required")
    emit({"type": "ready", "protocol": 1})
    while True:
        line = sys.stdin.buffer.readline(MAX_LINE + 1)
        if not line:
            return
        if len(line) > MAX_LINE:
            raise ValueError("Protocol size limit")
        request = json.loads(line)
        request_id = request["id"]
        try:
            data = request["request"]
            # The upstream prefix builder also truncates instructions/options separately.
            # Reject before that happens: a lost negation must not become a confident answer.
            prefix_fits = True
            for definition in data["questions"].values():
                question = agent._to_internal(definition)
                instruction = str(question["ins"]).replace(agent.tok.mask_token, " ")
                head_size = len(agent.tok(f"{question['t']} question: {instruction}")["input_ids"])
                option_sizes = [1 + len(agent.tok(" " + option.replace(agent.tok.mask_token, " "))["input_ids"])
                                for option in render_options(question)]
                budget = agent.cfg.get("head_max_len", 192) - sum(option_sizes)
                if any(size > 49 for size in option_sizes) or budget < 16 or head_size > max(8, budget):
                    prefix_fits = False
                    break
            if not prefix_fits:
                emit({"id": request_id, "error": "QUESTION_LIMIT"})
                continue
            items, _ = agent.prepare(data["state"], data["questions"])
            if any(item["state_stats"]["truncated"] for item in items):
                emit({"id": request_id, "error": "CONTEXT_LIMIT"})
                continue
            if collapsed_options(list(data["questions"]), items):
                emit({"id": request_id, "error": "OPTIONS_COLLAPSED"})
                continue
            result = agent.predict(data["state"], data["questions"])
            mx.synchronize()
            emit({"id": request_id, "result": result})
        except (ValueError, TypeError, KeyError):
            emit({"id": request_id, "error": "INVALID_REQUEST"})
        except Exception:
            # Inference failure may leave GPU state unhealthy: fail closed and restart on a later request.
            emit({"id": request_id, "error": "INFERENCE_FAILED"})
            return


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("Wand decision worker failed. Check the configured local runtime.\n")
        sys.exit(1)
