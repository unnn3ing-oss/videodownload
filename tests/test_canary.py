"""The pure parts of tools/canary_urls.py, tools/canary_flags.py and tools/win_registry_smoke.py. No network, no yt-dlp."""
import importlib.util
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def load(name):
    spec = importlib.util.spec_from_file_location(f"ytdl_{name}", ROOT / "tools" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


urls = load("canary_urls")
flags = load("canary_flags")
smoke = load("win_registry_smoke")

# A trimmed copy of the layout of `yt-dlp --help`.
HELP = """Usage: yt-dlp [OPTIONS] URL [URL...]

Options:
  -h, --help                      Print this help text and exit

General Options:
    --ignore-config                 Don't load any more configuration files
                                    except those given to --config-locations.
    --js-runtimes RUNTIME[:PATH]    Additional JavaScript runtime to enable,
                                    with an optional location for the runtime
    --color [STREAM:]POLICY         Whether to emit color codes in output
    -f, --format FORMAT             Video format code, see "FORMAT SELECTION"
    -S, --format-sort SORTORDER     Sort the formats by the fields given
    -O, --print [WHEN:]TEMPLATE     Field name or output template to print to
                                    screen, optionally prefixed with when to
                                    print it, separated by a ":". See --no-simulate
    --print-to-file [WHEN:]TEMPLATE FILE
                                    Append given template to the file.
    --progress-template [TYPES:]TEMPLATE
                                    Template for progress outputs
    --no-playlist                   Download only the video
"""


# ---------------------------------------------------------------- canary_flags

def test_flags_in_an_argument_list_skips_the_program_values_and_everything_after_the_double_dash():
    args = ["/x/yt-dlp", "--ignore-config", "-f", "bv*+ba/b", "-P", "home:/o", "--print", "after_move:%(id)s",
            "--", "--looks-like-a-flag-but-is-the-url"]
    assert flags.flags_in(args) == ["--ignore-config", "-f", "-P", "--print"]


def test_a_value_is_not_mistaken_for_a_flag():
    assert flags.flags_in(["yt-dlp", "-o", "-weird name.mp4", "--merge-output-format", "mp4"]) == ["-o", "--merge-output-format"]


def test_parse_help_flags_takes_the_option_names_of_each_entry_and_not_words_in_descriptions():
    found = flags.parse_help_flags(HELP)
    assert {"-h", "--help", "--ignore-config", "--js-runtimes", "--color", "-f", "--format", "-S", "--format-sort", "-O", "--print",
            "--print-to-file", "--progress-template", "--no-playlist"} <= found
    assert "--config-locations" not in found, "only mentioned in a description"
    assert "--no-simulate" not in found, "only mentioned in a description"


def test_missing_flags_lists_what_the_installed_ytdlp_does_not_know():
    used = {"--ignore-config": ["base_args"], "--js-runtimes": ["base_args"], "--gone": ["resolve", "fetch_meta"]}
    assert flags.missing_flags(used, flags.parse_help_flags(HELP)) == {"--gone": ["resolve", "fetch_meta"]}
    assert flags.missing_flags({"-f": ["x"]}, flags.parse_help_flags(HELP)) == {}


def test_the_flags_the_host_really_uses_are_collected_with_the_function_that_uses_them():
    used = flags.collect_used_flags(ROOT / "host")
    for flag in ("--ignore-config", "--color", "--ffmpeg-location", "--js-runtimes", "--no-playlist", "-f", "-S", "-P", "-o",
                 "--merge-output-format", "--progress-template", "--print", "--flat-playlist", "--dump-json", "--playlist-items", "--skip-download"):
        assert flag in used, flag
    assert set(used["--ignore-config"]) >= {"base_args", "build_download_args", "resolve", "fetch_meta"}
    assert "build_download_args" in used["--progress-template"] and "resolve" in used["--flat-playlist"]
    assert "fetch_meta" in used["--skip-download"] and "base_args" in used["--js-runtimes"]
    assert all(f.startswith("-") for f in used)


def test_the_flag_canary_succeeds_when_everything_is_known_and_fails_with_a_table_when_not(capsys):
    full = HELP + "".join(f"    {flag}   x\n" for flag in flags.collect_used_flags(ROOT / "host") if flag not in ("--gone",))
    assert flags.main([], get_help=lambda path: full) == 0
    assert "all" in capsys.readouterr().out
    lacking = full.replace("--skip-download", "--not-this-one")
    assert flags.main([], get_help=lambda path: lacking) == 1
    out = capsys.readouterr().out
    assert "--skip-download" in out and "fetch_meta" in out


def test_the_flag_canary_fails_when_yt_dlp_cannot_be_run(capsys):
    def broken(path):
        raise OSError("no such program")

    assert flags.main([], get_help=broken) == 2
    assert "no such program" in capsys.readouterr().err


# ---------------------------------------------------------------- canary_urls

def test_the_urls_come_from_the_host_modules():
    found = urls.load_urls(ROOT)
    installer, macos_engine, _ = urls._host_modules(ROOT)
    assert set(installer.URL) <= set(found), "everything in installer.URL is checked"
    assert found["macos_engine.ZIP_URL"].endswith("/yt-dlp_macos.zip") and found["macos_engine.SUMS_URL"].endswith("/SHA2-256SUMS")
    assert any(name.startswith("deno_") for name in found) and any(name.startswith("ffmpeg_") for name in found)
    assert all(u.startswith("https://") for u in found.values())


def test_a_url_that_answers_200_to_head_is_fine_and_get_is_not_even_tried():
    calls = []

    def fetch(url, method):
        calls.append(method)
        return 200, "https://objects.example/final"

    outcome = urls.check_url("https://x.example/a", fetch=fetch, sleep=lambda s: None)
    assert outcome.ok and outcome.status == 200 and calls == ["HEAD"]


def test_when_head_is_refused_a_ranged_get_decides():
    def fetch(url, method):
        return (403, url) if method == "HEAD" else (206, url)

    assert urls.check_url("https://x.example/a", fetch=fetch, sleep=lambda s: None).ok


def test_a_404_fails_without_retrying():
    calls = []

    def fetch(url, method):
        calls.append(method)
        return 404, url

    outcome = urls.check_url("https://x.example/gone", fetch=fetch, sleep=lambda s: None)
    assert not outcome.ok and outcome.status == 404 and calls == ["HEAD", "GET"]


def test_network_errors_and_server_errors_are_retried_then_reported():
    attempts = []

    def fetch(url, method):
        attempts.append(method)
        raise OSError("connection reset")

    slept = []
    outcome = urls.check_url("https://x.example/a", fetch=fetch, attempts=3, sleep=slept.append)
    assert not outcome.ok and outcome.status is None and "connection reset" in outcome.error
    assert len(attempts) == 6 and len(slept) == 2


def test_a_failure_that_goes_away_on_retry_is_a_pass():
    state = {"n": 0}

    def fetch(url, method):
        state["n"] += 1
        return (503, url) if state["n"] <= 2 else (200, url)

    assert urls.check_url("https://x.example/a", fetch=fetch, attempts=3, sleep=lambda s: None).ok


def test_the_table_shows_every_failure_with_its_name_status_and_address():
    rows = [urls.Outcome("ytdlp_win", "https://a.example/yt-dlp.exe", True, 200, "", ""),
            urls.Outcome("deno_win", "https://b.example/deno.zip", False, 404, "HTTP 404", "")]
    text = urls.format_table(rows)
    assert "ytdlp_win" in text and "deno_win" in text and "404" in text and "https://b.example/deno.zip" in text
    assert text.count("FAIL") == 1 and text.count("ok") >= 1


def test_the_url_canary_exit_codes(capsys):
    ok = lambda url, method: (200, url)
    assert urls.main(["urls"], fetch=ok, sleep=lambda s: None) == 0
    bad = lambda url, method: (404, url)
    assert urls.main(["urls"], fetch=bad, sleep=lambda s: None) == 1
    out = capsys.readouterr().out
    assert "deno_win" in out and "FAIL" in out


def sums_listing(names, extra=("yt-dlp_win_unrelated.zip",)):
    lines = [f"{'a' * 64}  {name}" if i % 2 else f"{'b' * 64} *{name}" for i, name in enumerate([*names, *extra])]
    return "\r\n".join(lines) + "\n"


def test_the_assets_the_installers_rely_on_are_derived_from_the_code():
    names = urls.required_assets(ROOT)
    assert names[0] == "yt-dlp_macos.zip" and len(names) >= 2
    assert all(name.startswith("yt-dlp") and name.endswith((".zip", ".exe")) for name in names)
    assert len(set(names)) == len(names)


def test_missing_assets_are_the_names_not_listed_in_the_checksum_file():
    listing = sums_listing(["yt-dlp.exe", "yt-dlp_macos.zip"])
    assert urls.missing_assets(listing, ["yt-dlp.exe", "yt-dlp_macos.zip"]) == []
    assert urls.missing_assets(listing, ["yt-dlp.exe", "yt-dlp_macos.zip", "yt-dlp_linux"]) == ["yt-dlp_linux"]
    assert urls.missing_assets("not a checksum file", ["yt-dlp.exe"]) == ["yt-dlp.exe"]
    assert urls.missing_assets("%s  yt-dlp.exe.sig\n" % ("a" * 64), ["yt-dlp.exe"]) == ["yt-dlp.exe"]


def test_the_sums_canary_reports_a_missing_asset_and_an_unreachable_list(capsys):
    names = urls.required_assets(ROOT)
    assert urls.main(["sums"], fetch_text=lambda url: sums_listing(names)) == 0
    assert urls.main(["sums"], fetch_text=lambda url: sums_listing(names[1:])) == 1
    assert names[0] in capsys.readouterr().out

    def down(url):
        raise OSError("timed out")

    assert urls.main(["sums"], fetch_text=down) == 1
    assert "timed out" in capsys.readouterr().out


# ---------------------------------------------------------------- win_registry_smoke

class FakeWinreg(types.SimpleNamespace):
    def __init__(self):
        values = {}
        super().__init__(HKEY_CURRENT_USER=1, REG_SZ=1, values=values)

        class Handle:
            def __init__(self, key): self.key = key
            def __enter__(self): return self
            def __exit__(self, *a): return False

        def create(root, key):
            values.setdefault(key, None)
            return Handle(key)

        def set_value(handle, name, reserved, kind, value):
            values[handle.key] = value

        def open_key(root, key):
            if key not in values:
                raise OSError("no such key")
            return Handle(key)

        self.CreateKey, self.SetValueEx, self.OpenKey = create, set_value, open_key
        self.QueryValueEx = lambda handle, name: (values[handle.key], 1)
        self.DeleteKey = lambda root, key: values.pop(key)


def test_the_registry_smoke_round_trips_through_register_and_the_check_and_cleans_up(monkeypatch, capsys):
    fake = FakeWinreg()
    monkeypatch.setitem(sys.modules, "winreg", fake)
    assert smoke.main(ROOT) == 0
    assert fake.values == {}, "the key is removed again"
    assert "OK" in capsys.readouterr().out


def test_the_registry_smoke_fails_when_the_value_does_not_come_back(monkeypatch, capsys):
    fake = FakeWinreg()
    fake.SetValueEx = lambda handle, name, reserved, kind, value: fake.values.__setitem__(handle.key, "C:\\elsewhere.json")
    monkeypatch.setitem(sys.modules, "winreg", fake)
    assert smoke.main(ROOT) == 1
    assert fake.values == {}, "cleaned up even on failure"
    assert "FAIL" in capsys.readouterr().out


def test_the_registry_smoke_does_not_touch_a_registration_that_already_exists(monkeypatch, capsys):
    fake = FakeWinreg()
    key = rf"Software\Google\Chrome\NativeMessagingHosts\{smoke_host_name()}"
    fake.values[key] = "C:\\real\\manifest.json"
    monkeypatch.setitem(sys.modules, "winreg", fake)
    assert smoke.main(ROOT, []) == 2
    assert fake.values == {key: "C:\\real\\manifest.json"}
    assert "already exists" in capsys.readouterr().out


def smoke_host_name():
    import doctor
    return doctor.HOST_NAME


def test_the_registry_smoke_says_so_when_it_is_not_on_windows(monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "winreg", None)  # makes `import winreg` raise ImportError
    assert smoke.main(ROOT) == 2
    assert "Windows" in capsys.readouterr().out


@pytest.mark.parametrize("name", ["canary_urls", "canary_flags", "win_registry_smoke", "release"])
def test_the_tools_use_only_the_standard_library(name):
    source = (ROOT / "tools" / f"{name}.py").read_text(encoding="utf-8")
    imports = {line.split()[1].split(".")[0] for line in source.splitlines() if line.startswith(("import ", "from "))}
    local = {"installer", "doctor", "ytdlp", "macos_engine"}
    stdlib = set(sys.stdlib_module_names) if hasattr(sys, "stdlib_module_names") else imports - local
    assert imports - local <= stdlib | {"__future__"}, imports
