"""tools/release.py: `check` and `bump`, exercised on a small fake repository (a temp folder with the same layout)."""
import importlib.util
import json
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("ytdl_release", ROOT / "tools" / "release.py")
release = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(release)

MANIFEST = """{
  "manifest_version": 3,
  "name": "YouTube 批量下載器",
  "version": "%s",
  "minimum_chrome_version": "114",
  "key": "AAAA"
}
"""
FAKE_BUILD = '''import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "extension" / "installers"


def main(out_dir=OUT):
    version = re.search(r'VERSION = "([^"]+)"', (ROOT / "host" / "version.py").read_text(encoding="utf-8")).group(1)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "install-windows.cmd").write_bytes(f"@echo off\\r\\nversion {version}\\r\\n".encode())
    (out / "install-mac.zip").write_bytes(b"PK-fake-" + version.encode())
    (out / "install-mac.sh").write_bytes(f"#!/bin/bash\\nversion {version}\\n".encode())
    print("wrote installers to", out)


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else OUT)
'''


def git(root, *args):
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args], cwd=root,
                          capture_output=True, text=True, check=True).stdout


def make_repo(tmp_path, manifest="1.2.3", host="1.2.3", init_git=True, build=True):
    repo = tmp_path / "repo"
    (repo / "extension" / "tests").mkdir(parents=True)
    (repo / "host").mkdir()
    (repo / "extension" / "manifest.json").write_text(MANIFEST % manifest, encoding="utf-8")
    (repo / "host" / "version.py").write_text(
        f'"""Host version; must equal extension/manifest.json "version"."""\nVERSION = "{host}"\n', encoding="utf-8")
    (repo / "extension" / "tests" / "extension-id.test.mjs").write_text("// pin\n", encoding="utf-8")
    (repo / "build.py").write_text(FAKE_BUILD, encoding="utf-8")
    (repo / ".gitignore").write_text("__pycache__/\n", encoding="utf-8")
    if build:
        run_fake_build(repo)
    if init_git:
        git(repo, "init", "-q", "-b", "main")
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", "initial")
    return repo


def run_fake_build(repo):
    subprocess.run(["python3", "build.py"], cwd=repo, check=True, capture_output=True)


def runner(pin_rc=0, pin_output="# pass 7"):
    """Real git, a canned answer for node (the pin test itself is covered by node --test)."""
    seen = []

    def run(cmd, cwd):
        if cmd[0] == "node":
            seen.append(cmd)
            return pin_rc, pin_output
        return release.default_run(cmd, cwd)

    run.seen = seen
    return run


def check(repo, capsys, run=None, extra=()):
    code = release.main(["check", "--root", str(repo), *extra], run=run or runner())
    return code, capsys.readouterr().out


def line_for(output, text):
    return next(line for line in output.splitlines() if text in line)


# ---------------------------------------------------------------- versions

@pytest.mark.parametrize("text", ["0.3.0", "1.2.3", "10.20.30", "0.0.0"])
def test_plain_x_y_z_is_a_valid_version(text):
    assert release.parse_semver(text) is not None


@pytest.mark.parametrize("text", ["", "1.2", "1.2.3.4", "v1.2.3", "1.2.3-rc1", "1.2.3+b", "01.2.3", "1.02.3", "1.2.x", " 1.2.3", "1.2.3\n"])
def test_anything_but_plain_x_y_z_is_not(text):
    assert release.parse_semver(text) is None


def test_versions_compare_as_numbers_not_text():
    assert release.parse_semver("0.10.0") > release.parse_semver("0.9.0")
    assert release.parse_semver("1.0.0") > release.parse_semver("0.99.99")


def test_read_versions_reads_both_files(tmp_path):
    repo = make_repo(tmp_path, manifest="1.2.3", host="1.2.4", init_git=False)
    assert release.read_versions(repo) == ("1.2.3", "1.2.4")


# ---------------------------------------------------------------- bump

def test_bump_sets_both_version_strings_and_changes_nothing_else(tmp_path, capsys):
    repo = make_repo(tmp_path)
    manifest, host = repo / "extension/manifest.json", repo / "host/version.py"
    before = {p: p.read_bytes() for p in repo.rglob("*") if p.is_file() and ".git" not in p.parts}
    assert release.main(["bump", "1.3.0", "--root", str(repo)], run=runner()) == 0
    after = {p: p.read_bytes() for p in repo.rglob("*") if p.is_file() and ".git" not in p.parts}
    assert set(before) == set(after)
    assert {p for p in before if before[p] != after[p]} == {manifest, host}
    assert after[manifest] == before[manifest].replace(b'"version": "1.2.3"', b'"version": "1.3.0"')
    assert after[host] == before[host].replace(b'VERSION = "1.2.3"', b'VERSION = "1.3.0"')
    assert json.loads(manifest.read_text(encoding="utf-8"))["version"] == "1.3.0"
    assert release.read_versions(repo) == ("1.3.0", "1.3.0")


def test_bump_does_not_touch_other_version_like_fields(tmp_path):
    repo = make_repo(tmp_path)
    release.bump(repo, "1.2.4")
    manifest = json.loads((repo / "extension/manifest.json").read_text(encoding="utf-8"))
    assert manifest["manifest_version"] == 3 and manifest["minimum_chrome_version"] == "114"


def test_bump_keeps_crlf_line_endings_of_the_files_it_edits(tmp_path):
    repo = make_repo(tmp_path, init_git=False)
    path = repo / "host/version.py"
    path.write_bytes(path.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))  # (write_text already made CRLF on Windows)
    release.bump(repo, "1.2.4")
    assert path.read_bytes().endswith(b'VERSION = "1.2.4"\r\n')


@pytest.mark.parametrize("new", ["1.2.3", "1.2.2", "0.9.9", "1.1.99"])
def test_bump_refuses_a_version_that_is_not_greater(tmp_path, capsys, new):
    repo = make_repo(tmp_path)
    before = (repo / "extension/manifest.json").read_bytes(), (repo / "host/version.py").read_bytes()
    assert release.main(["bump", new, "--root", str(repo)], run=runner()) == 1
    assert "not greater" in capsys.readouterr().err
    assert ((repo / "extension/manifest.json").read_bytes(), (repo / "host/version.py").read_bytes()) == before


def test_bump_compares_numbers_not_text(tmp_path):
    repo = make_repo(tmp_path, manifest="0.9.0", host="0.9.0", init_git=False)
    release.bump(repo, "0.10.0")  # "0.10.0" < "0.9.0" as text
    assert release.read_versions(repo) == ("0.10.0", "0.10.0")


@pytest.mark.parametrize("new", ["1.3", "v1.3.0", "1.3.0-rc1", "banana", "1.3.0.1", ""])
def test_bump_refuses_a_version_that_is_not_x_y_z(tmp_path, capsys, new):
    repo = make_repo(tmp_path)
    assert release.main(["bump", new, "--root", str(repo)], run=runner()) == 1
    assert "x.y.z" in capsys.readouterr().err
    assert release.read_versions(repo) == ("1.2.3", "1.2.3")


def test_bump_refuses_when_the_two_files_disagree(tmp_path, capsys):
    repo = make_repo(tmp_path, manifest="1.2.3", host="1.2.4")
    assert release.main(["bump", "2.0.0", "--root", str(repo)], run=runner()) == 1
    assert "disagree" in capsys.readouterr().err
    assert release.read_versions(repo) == ("1.2.3", "1.2.4")


def test_bump_refuses_a_file_it_cannot_edit_unambiguously_and_leaves_both_alone(tmp_path, capsys):
    repo = make_repo(tmp_path, init_git=False)
    manifest = repo / "extension/manifest.json"
    manifest.write_text(manifest.read_text(encoding="utf-8").replace('"key"', '"version": "9.9.9",\n  "key"'), encoding="utf-8")
    before = (manifest.read_bytes(), (repo / "host/version.py").read_bytes())
    assert release.main(["bump", "2.0.0", "--root", str(repo)], run=runner()) == 1
    assert (manifest.read_bytes(), (repo / "host/version.py").read_bytes()) == before


def test_bump_tells_the_person_what_to_run_next_and_runs_none_of_it(tmp_path, capsys):
    repo = make_repo(tmp_path)
    git(repo, "checkout", "-q", "-b", "my-release-branch")
    assert release.main(["bump", "1.3.0", "--root", str(repo)], run=runner()) == 0
    out = capsys.readouterr().out
    for expected in ("1.2.3 -> 1.3.0", "python3 build.py", "python3 -m pytest -q", "node --test extension/tests/*.test.mjs",
                     "python3 tools/release.py check", "git add extension/manifest.json host/version.py extension/installers",
                     'git commit -m "release: v1.3.0"', "git push origin my-release-branch",
                     "git push origin HEAD:main", "git merge-base --is-ancestor origin/main HEAD",
                     'git tag -a v1.3.0 -m "v1.3.0"', "git push origin v1.3.0"):
        assert expected in out, expected
    assert git(repo, "tag", "--list") == "", "no tag was made"
    assert git(repo, "log", "--oneline").count("\n") == 1, "no commit was made"
    assert (repo / "extension/installers/install-mac.sh").read_bytes() == b"#!/bin/bash\nversion 1.2.3\n", "bump does not build"


def test_bump_still_prints_commands_outside_a_git_repository(tmp_path, capsys):
    repo = make_repo(tmp_path, init_git=False)
    assert release.main(["bump", "1.3.0", "--root", str(repo)], run=runner()) == 0
    assert "git push origin <branch>" in capsys.readouterr().out


# ---------------------------------------------------------------- check

def test_check_passes_on_a_clean_current_repository(tmp_path, capsys):
    repo = make_repo(tmp_path)
    run = runner()
    code, out = check(repo, capsys, run)
    assert code == 0, out
    assert "FAIL" not in out and out.count("PASS") == 5
    assert run.seen == [["node", "--test", "extension/tests/extension-id.test.mjs"]]


def test_check_fails_when_the_versions_differ(tmp_path, capsys):
    repo = make_repo(tmp_path, manifest="1.2.3", host="1.2.4")
    code, out = check(repo, capsys)
    assert code == 1
    line = line_for(out, "agree")
    assert "FAIL" in line and "1.2.3" in out and "1.2.4" in out


@pytest.mark.parametrize("manifest,host", [("1.2", "1.2"), ("1.2.3-beta", "1.2.3-beta")])
def test_check_fails_when_a_version_is_not_plain_x_y_z(tmp_path, capsys, manifest, host):
    repo = make_repo(tmp_path, manifest=manifest, host=host)
    code, out = check(repo, capsys)
    assert code == 1
    assert "PASS" in line_for(out, "agree") and "FAIL" in line_for(out, "x.y.z")


def test_check_fails_when_the_installers_are_older_than_the_sources(tmp_path, capsys):
    repo = make_repo(tmp_path)
    release.bump(repo, "1.3.0")  # without running build.py
    code, out = check(repo, capsys)
    assert code == 1
    line = line_for(out, "installers")
    assert "FAIL" in line and "python3 build.py" in out and "install-mac.sh" in out
    assert "PASS" in line_for(out, "working tree"), "the version files and the installers are what is being released"


def test_check_passes_after_bump_and_build(tmp_path, capsys):
    repo = make_repo(tmp_path)
    release.bump(repo, "1.3.0")
    run_fake_build(repo)
    code, out = check(repo, capsys)
    assert code == 0, out
    assert git(repo, "status", "--porcelain").count("\n") == 5, "manifest, version and the three installers are what changed"


def test_check_builds_into_a_temp_folder_and_leaves_the_committed_installers_alone(tmp_path, capsys):
    repo = make_repo(tmp_path)
    release.bump(repo, "1.3.0")
    before = (repo / "extension/installers/install-mac.sh").read_bytes()
    check(repo, capsys)
    assert (repo / "extension/installers/install-mac.sh").read_bytes() == before
    assert not list(repo.rglob("__pycache__")), "importing build.py must not leave bytecode in the repository"


def test_check_fails_when_an_installer_is_missing(tmp_path, capsys):
    repo = make_repo(tmp_path)
    (repo / "extension/installers/install-mac.zip").unlink()
    code, out = check(repo, capsys)
    assert code == 1 and "FAIL" in line_for(out, "installers") and "install-mac.zip" in out


def test_check_fails_when_build_py_cannot_run(tmp_path, capsys):
    repo = make_repo(tmp_path, init_git=False)
    (repo / "build.py").write_text("raise RuntimeError('broken build')\n", encoding="utf-8")
    code, out = check(repo, capsys)
    assert code == 1 and "FAIL" in line_for(out, "installers") and "broken build" in out


def test_check_fails_on_changes_that_are_not_part_of_the_release(tmp_path, capsys):
    repo = make_repo(tmp_path)
    (repo / "host" / "other.py").write_text("x = 1\n", encoding="utf-8")  # untracked, not a release file
    (repo / "build.py").write_text((repo / "build.py").read_text(encoding="utf-8") + "\n# edited\n", encoding="utf-8")
    code, out = check(repo, capsys)
    assert code == 1
    assert "FAIL" in line_for(out, "working tree")
    assert "host/other.py" in out and "build.py" in out


def test_check_allows_extra_paths_the_person_names(tmp_path, capsys):
    repo = make_repo(tmp_path)
    (repo / "docs").mkdir()
    (repo / "docs" / "notes.md").write_text("n\n", encoding="utf-8")
    assert check(repo, capsys)[0] == 1
    assert check(repo, capsys, extra=("--allow", "docs/"))[0] == 0


def test_check_fails_outside_a_git_repository(tmp_path, capsys):
    repo = make_repo(tmp_path, init_git=False)
    code, out = check(repo, capsys)
    assert code == 1 and "FAIL" in line_for(out, "working tree")


def test_check_fails_when_the_extension_id_pin_test_fails(tmp_path, capsys):
    repo = make_repo(tmp_path)
    code, out = check(repo, capsys, runner(pin_rc=1, pin_output="THE EXTENSION ID CHANGED"))
    assert code == 1
    assert "FAIL" in line_for(out, "extension id") and "THE EXTENSION ID CHANGED" in out


def test_check_fails_instead_of_crashing_when_node_is_missing(tmp_path, capsys):
    repo = make_repo(tmp_path)

    def run(cmd, cwd):
        return (127, "node: command not found") if cmd[0] == "node" else release.default_run(cmd, cwd)

    code, out = check(repo, capsys, run)
    assert code == 1 and "FAIL" in line_for(out, "extension id") and "command not found" in out


def test_check_reports_every_problem_not_only_the_first(tmp_path, capsys):
    repo = make_repo(tmp_path, manifest="1.2.3", host="1.2.4")
    (repo / "stray.txt").write_text("x", encoding="utf-8")
    code, out = check(repo, capsys, runner(pin_rc=1))
    assert code == 1
    assert out.count("FAIL") >= 3
    assert "checks failed" in out


def test_default_run_survives_a_missing_program(tmp_path):
    rc, output = release.default_run(["definitely-not-a-program-xyz"], tmp_path)
    assert rc != 0 and output


# ---------------------------------------------------------------- the command line

def test_unknown_or_missing_command_is_a_usage_error(capsys):
    with pytest.raises(SystemExit) as exc:
        release.main([])
    assert exc.value.code == 2
    with pytest.raises(SystemExit) as exc:
        release.main(["publish"])
    assert exc.value.code == 2


def test_release_py_is_standard_library_only():
    source = (ROOT / "tools" / "release.py").read_text(encoding="utf-8")
    imports = {line.split()[1].split(".")[0] for line in source.splitlines() if line.startswith(("import ", "from "))}
    allowed = {"__future__", "argparse", "contextlib", "dataclasses", "importlib", "io", "json", "re", "subprocess", "sys", "tempfile", "pathlib", "typing"}
    assert imports <= allowed, imports - allowed
    assert "git push" not in source.replace("git push origin", ""), "only text for the person to run, never run by the tool"
