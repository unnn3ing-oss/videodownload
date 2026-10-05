import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_extension_and_host_versions_match():
    import version

    manifest = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["version"] == version.VERSION


def test_tracking_config_matches_between_js_and_python():
    import update_config

    js = (ROOT / "extension" / "lib" / "update-config.js").read_text(encoding="utf-8")
    found = {k: re.search(rf'{k}:\s*"([^"]+)"', js).group(1) for k in ("owner", "repo", "branch")}
    assert found == {"owner": update_config.OWNER, "repo": update_config.REPO, "branch": update_config.BRANCH}
    assert update_config.BRANCH == "release"


def test_ready_reports_host_version(tmp_path):
    import host
    import version

    assert host.Host(tmp_path, lambda message: None).ready_message()["hostVersion"] == version.VERSION
