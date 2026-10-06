"""Chrome starts the host with its native-messaging pipe as stdin, and the host's main thread sits in a read on it.
A child that inherits that handle can hang on Windows while it starts (yt-dlp.exe stalled before running any code),
so every program the host starts must get its own stdin."""
import ast
from pathlib import Path

HOST = Path(__file__).resolve().parent.parent


def test_every_program_the_host_starts_has_its_own_stdin():
    missing = []
    for source in sorted(HOST.glob("*.py")):
        for node in ast.walk(ast.parse(source.read_text(encoding="utf-8"))):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
                continue
            if node.func.attr in ("run", "Popen") and getattr(node.func.value, "id", "") == "subprocess":
                if "stdin" not in {kw.arg for kw in node.keywords}:
                    missing.append(f"{source.name}:{node.lineno}")
    assert not missing, f"subprocess calls that inherit the host's stdin: {missing}"
