#!/usr/bin/env python3
"""Fetch an official prebuilt llama.cpp engine, verify it against the pinned
lock file, and install it under artifacts/engine/ with an engine.json manifest.

This is the fallback path when a backend cannot be built from source on this
machine (e.g. Vulkan without the SDK). Nothing is downloaded silently at app
runtime; this is an explicit, hash-verified packaging step.
"""

import argparse
import hashlib
import json
import platform
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCK_FILE = ROOT / "third_party" / "llama.cpp.lock.json"
DOWNLOADS = ROOT / "artifacts" / "downloads"
ENGINE_ROOT = ROOT / "artifacts" / "engine"

# Lock-file asset key -> engine.json backend label used by the desktop app.
BACKEND_LABELS = {
    "cpu": "cpu",
    "cuda-12.4": "cuda",
    "cuda-13.3": "cuda",
    "vulkan": "vulkan",
}


def die(msg: str) -> None:
    print(f"[ERROR] {msg}", file=sys.stderr)
    sys.exit(1)


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"downloading {url}")
    with urllib.request.urlopen(url) as response, tmp.open("wb") as out:
        total = int(response.headers.get("Content-Length") or 0)
        done = 0
        for chunk in iter(lambda: response.read(1024 * 512), b""):
            out.write(chunk)
            done += len(chunk)
            if total:
                pct = min(100, done * 100 // total)
                print(f"\r  {done / (1024 * 1024):.1f} MiB / {total / (1024 * 1024):.1f} MiB ({pct}%)", end="")
    print()
    tmp.replace(dest)


def extract_flat(zip_path: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as archive:
        names = [info for info in archive.infolist() if not info.is_dir()]
        top_dirs = {info.filename.split("/")[0] for info in names if "/" in info.filename}
        strip = len(next(iter(top_dirs))) + 1 if len(top_dirs) == 1 and all(
            info.filename.startswith(next(iter(top_dirs)) + "/") for info in names
        ) else 0
        for info in names:
            target = dest / info.filename[strip:]
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as src, target.open("wb") as out:
                out.write(src.read())


def main() -> None:
    if platform.system() != "Windows":
        die("this installer targets Windows engine packages")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", required=True,
                        choices=sorted(BACKEND_LABELS),
                        help="lock-file asset key (cpu, cuda-12.4, cuda-13.3, vulkan)")
    parser.add_argument("--force", action="store_true",
                        help="replace an existing engine directory")
    args = parser.parse_args()

    if not LOCK_FILE.is_file():
        die(f"missing lock file: {LOCK_FILE}")
    lock = json.loads(LOCK_FILE.read_text(encoding="utf-8"))
    assets = lock.get("officialWindowsX64Assets", {})
    asset = assets.get(args.backend)
    if asset is None:
        die(f"lock file has no official asset for '{args.backend}'")

    name = f"llama-{lock['tag']}-{args.backend}-x64"
    dest = ENGINE_ROOT / name
    if dest.exists():
        if not args.force:
            die(f"engine directory already exists: {dest} (use --force to replace)")
        for path in dest.iterdir():
            path.unlink() if path.is_file() else die(f"refusing to remove non-file {path}")

    archive = DOWNLOADS / asset["asset"]
    if archive.exists():
        actual = sha256_of(archive)
        if actual != asset["sha256"]:
            die(
                f"cached archive hash mismatch for {archive.name}\n"
                f"  expected: {asset['sha256']}\n  actual:   {actual}\n"
                "Delete the file to re-download."
            )
        print(f"using cached archive {archive}")
    else:
        download(asset["url"], archive)
        actual = sha256_of(archive)
        if actual != asset["sha256"]:
            die(
                f"downloaded archive hash mismatch for {archive.name}\n"
                f"  expected: {asset['sha256']}\n  actual:   {actual}"
            )
    print(f"sha256 verified: {actual}")

    extract_flat(archive, dest)
    if not (dest / "llama-server.exe").is_file():
        die(f"archive did not contain llama-server.exe under {dest}")

    version = subprocess.run(
        [str(dest / "llama-server.exe"), "--version"],
        cwd=str(dest), capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=120,
    )
    if version.returncode != 0:
        die(f"llama-server --version failed (exit {version.returncode}): "
            f"{(version.stderr or version.stdout)[-1000:]}")
    version_output = (version.stdout or "").strip()
    if version.stderr.strip():
        version_output += "\n" + version.stderr.strip()
    print(f"engine version check OK:\n{version_output}\n")

    files = {}
    for path in sorted(dest.iterdir()):
        if path.is_file():
            files[path.name] = {"sha256": sha256_of(path), "size": path.stat().st_size}
    manifest = {
        "name": "llama.cpp",
        "tag": lock["tag"],
        "commit": lock["commit"],
        "releaseDate": lock["releaseDate"],
        "backend": BACKEND_LABELS[args.backend],
        "builtFrom": "official-prebuilt",
        "prebuiltAsset": args.backend,
        "sourceUrl": asset["url"],
        "archiveSha256": asset["sha256"],
        "installedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "platform": f"windows-{platform.machine().lower()}",
        "versionOutput": version_output,
        "files": files,
    }
    (dest / "engine.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"installed {dest} ({len(files)} files, engine.json written)")


if __name__ == "__main__":
    main()
