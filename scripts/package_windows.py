"""Assemble a fresh Windows directory without modifying a user's release tree."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, default=ROOT / "release",
                        help="Existing portable runtime (Python, Node and their dependencies)")
    parser.add_argument("--output", type=Path, required=True,
                        help="New output directory; existing paths are never overwritten")
    parser.add_argument("--flutter", default="flutter", help="Flutter executable (flutter.bat on Windows)")
    args = parser.parse_args()
    if args.output.resolve().exists():
        parser.error(f"Refusing to overwrite existing output: {args.output.resolve()}")
    flutter = shutil.which(args.flutter)
    if flutter is None:
        parser.error("Flutter executable not found; pass --flutter with the path to flutter.bat")
    subprocess.run([flutter, "build", "windows", "--release"], cwd=ROOT / "frontend", check=True)
    runtime = args.runtime.resolve()
    output = args.output.resolve()
    build = ROOT / "frontend/build/windows/x64/runner/Release"
    required = [build / "openmymodel.exe", build / "flutter_windows.dll", build / "data",
                runtime / "python/python.exe", runtime / "scripts/node.exe"]
    for path in required:
        if not path.exists():
            parser.error(f"Required build/runtime file missing: {path}")
    if output.exists():
        parser.error(f"Refusing to overwrite existing output: {output}")
    for source in [build, runtime]:
        if output == source or source in output.parents:
            parser.error("Output must be outside the build and runtime source trees")
    ws = next((path for path in [ROOT / "scripts/node_modules/ws",
                                runtime / "scripts/node_modules/ws", runtime / "node_modules/ws"]
               if (path / "package.json").exists()), None)
    if ws is None:
        parser.error("Missing ws runtime. Run npm --prefix scripts ci first.")
    source_time = max(path.stat().st_mtime for path in (ROOT / "frontend/lib").rglob("*.dart"))
    aot = build / "data/app.so"
    if not aot.exists() or aot.stat().st_mtime < source_time:
        parser.error("Flutter assets are older than source. Complete flutter build windows --release first.")
    output.mkdir(parents=True)
    ignore = shutil.ignore_patterns("__pycache__", "*.pyc", "*.log", ".cache")
    for path in build.iterdir():
        if path.is_file() and path.suffix.lower() in (".exe", ".dll"):
            shutil.copy2(path, output / path.name)
    shutil.copytree(build / "data", output / "data", ignore=ignore)
    shutil.copytree(runtime / "python", output / "python", ignore=ignore)
    (output / "scripts").mkdir()
    shutil.copy2(runtime / "scripts/node.exe", output / "scripts/node.exe")
    shutil.copytree(ws, output / "scripts/node_modules/ws", ignore=ignore)
    shutil.copy2(ROOT / "scripts/cloud_bridge.js", output / "scripts/cloud_bridge.js")
    for name in ["bridge_server.py", "server_manager.py", "config_manager.py", "chat_handler.py"]:
        shutil.copy2(ROOT / "python" / name, output / name)
    (output / "README.txt").write_text(
        "OpenMyModel Windows portable build\n"
        "Run openmymodel.exe. Select your llama-server and GGUF model on Home.\n"
        "Cloud passwords and API keys are local user data; protect your Windows account.\n"
        "This package contains no model, configuration profile, credentials or debug logs.\n",
        encoding="utf-8")
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    dirty = bool(subprocess.check_output(["git", "diff", "--name-only", "HEAD"], cwd=ROOT, text=True).strip())
    hashes = {str(path.relative_to(output)).replace("\\", "/"): hashlib.sha256(path.read_bytes()).hexdigest()
              for path in output.rglob("*") if path.is_file()}
    (output / "build-manifest.json").write_text(
        json.dumps({"gitRevision": revision, "workingTreeModified": dirty, "sha256": hashes}, indent=2),
        encoding="utf-8")
    print(f"Created {output} ({len(hashes)} files). Source revision: {revision}, modified: {dirty}")


if __name__ == "__main__":
    main()
