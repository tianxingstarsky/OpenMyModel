#!/usr/bin/env python3
"""Build the Windows installer (single setup .exe) from an assembled package
directory using Inno Setup (ISCC.exe).

The payload must be a directory produced by scripts/package_windows.py. The
installer installs per-user (no admin required), adds Start Menu / optional
desktop shortcuts, and ships an uninstaller. User data outside the install
directory (profiles, preferences) is never touched by uninstall.
"""

import argparse
import hashlib
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
ISCC_CANDIDATES = [
    Path(os.environ.get("localappdata", "")) / "Programs" / "Inno Setup 6" / "ISCC.exe",
    Path("C:/Program Files (x86)/Inno Setup 6/ISCC.exe"),
    Path("C:/Program Files/Inno Setup 6/ISCC.exe"),
]


def die(msg: str) -> None:
    print(f"[ERROR] {msg}", file=sys.stderr)
    sys.exit(1)


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_iscc(explicit: str) -> Path:
    if explicit:
        path = Path(explicit)
        if not path.is_file():
            die(f"ISCC.exe not found at --iscc path: {path}")
        return path
    for candidate in ISCC_CANDIDATES:
        if candidate.is_file():
            return candidate
    found = Path(subprocess.run(["where", "ISCC"], capture_output=True, text=True)
                 .stdout.splitlines()[0]) if subprocess.run(
        ["where", "ISCC"], capture_output=True).returncode == 0 else None
    if found and found.is_file():
        return found
    die(
        "ISCC.exe (Inno Setup) not found. Install it with: "
        "winget install --id JRSoftware.InnoSetup -e, or pass --iscc <path>"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--payload", type=Path, required=True,
                        help="Package directory built by scripts/package_windows.py")
    parser.add_argument("--out", type=Path, default=ROOT / "artifacts",
                        help="Directory for the resulting setup .exe")
    parser.add_argument("--iscc", default="", help="Explicit path to ISCC.exe")
    parser.add_argument("--engine-tag", default="b10909")
    args = parser.parse_args()

    payload = args.payload.resolve()
    if not (payload / "openmymodel.exe").is_file():
        die(f"not a package directory (missing openmymodel.exe): {payload}")
    engines = sorted(p.name for p in (payload / "runtime" / "llama").iterdir()
                     if (p / "llama-server.exe").is_file()) if (
        payload / "runtime" / "llama").is_dir() else []
    if not engines:
        die("payload has no bundled engines under runtime/llama; build them first")

    rev = ""
    manifest = payload / "build-manifest.json"
    if manifest.is_file():
        import json
        rev = json.loads(manifest.read_text(encoding="utf-8")).get("gitRevision", "")[:7]
    if not rev:
        rev = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True).strip()

    iscc = find_iscc(args.iscc)
    args.out.mkdir(parents=True, exist_ok=True)
    cmd = [
        str(iscc),
        f"/DPayload={payload}",
        f"/DOutDir={args.out.resolve()}",
        f"/DRev={rev}",
        f"/DEngineTag={args.engine_tag}",
        str(ROOT / "scripts" / "installer.iss"),
    ]
    print(f"building installer with {iscc.name} for rev {rev} ({len(engines)} engines: {', '.join(engines)})")
    proc = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        print((proc.stdout or "")[-3000:] + (proc.stderr or "")[-1500:], file=sys.stderr)
        die(f"ISCC failed with exit code {proc.returncode}")

    setup_exe = args.out / f"OpenMyModel-Setup-1.0.0-{rev}.exe"
    if not setup_exe.is_file():
        die(f"ISCC reported success but {setup_exe} is missing")
    print(f"created {setup_exe}")
    print(f"  size:   {setup_exe.stat().st_size / (1024 * 1024):.1f} MiB")
    print(f"  sha256: {sha256_of(setup_exe)}")


if __name__ == "__main__":
    main()
