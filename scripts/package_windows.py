"""Assemble a fresh Windows portable directory without modifying a user's release tree.

The new package carries the pinned llama.cpp engines built by
scripts/build_llama_windows.py (artifacts/engine/<name>) and the Node cloud
bridge runtime. It contains no Python runtime and no local HTTP bridge.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--engines-dir", type=Path, default=ROOT / "artifacts" / "engine",
        help="Directory containing llama-<tag>-<backend>-x64 engine builds",
    )
    parser.add_argument(
        "--engines", default="",
        help="Comma list of engine directory names to include (default: all)",
    )
    parser.add_argument(
        "--node", type=Path, default=ROOT / "release" / "scripts" / "node.exe",
        help="node.exe used by the cloud bridge",
    )
    parser.add_argument(
        "--output", type=Path, required=True,
        help="New output directory; existing paths are never overwritten",
    )
    parser.add_argument("--flutter", default="flutter",
                        help="Flutter executable (flutter.bat on Windows)")
    args = parser.parse_args()
    if args.output.resolve().exists():
        parser.error(f"Refusing to overwrite existing output: {args.output.resolve()}")
    flutter = shutil.which(args.flutter)
    if flutter is None:
        parser.error("Flutter executable not found; pass --flutter with the path to flutter.bat")
    subprocess.run([flutter, "build", "windows", "--release"], cwd=ROOT / "frontend", check=True)

    build = ROOT / "frontend/build/windows/x64/runner/Release"
    node = args.node
    if not node.exists():
        parser.error(f"node.exe not found at {node}; pass --node with a portable node.exe")
    ws = next((path for path in [ROOT / "scripts/node_modules/ws",
                                 ROOT / "node_modules/ws"]
               if (path / "package.json").exists()), None)
    if ws is None:
        parser.error("Missing ws runtime. Run npm --prefix scripts ci first.")

    engine_root = args.engines_dir.resolve()
    if args.engines:
        wanted = [name.strip() for name in args.engines.split(",") if name.strip()]
    else:
        wanted = sorted(
            path.name for path in engine_root.iterdir()
            if path.is_dir() and (path / "llama-server.exe").exists()
        ) if engine_root.is_dir() else []
    if not wanted:
        parser.error(
            f"No engine builds found under {engine_root}; run scripts/build_llama_windows.py first"
        )
    engines = []
    for name in wanted:
        source = engine_root / name
        if not (source / "llama-server.exe").exists():
            parser.error(f"Engine '{name}' has no llama-server.exe under {source}")
        engines.append(source)

    output = args.output.resolve()
    if output.exists():
        parser.error(f"Refusing to overwrite existing output: {output}")
    for source in [build, engine_root]:
        if output == source or source in output.parents:
            parser.error("Output must be outside the build and engine source trees")

    aot = build / "data/app.so"
    source_time = max(path.stat().st_mtime for path in (ROOT / "frontend/lib").rglob("*.dart"))
    if not aot.exists() or aot.stat().st_mtime < source_time:
        parser.error("Flutter assets are older than source. Complete flutter build windows --release first.")

    output.mkdir(parents=True)
    ignore = shutil.ignore_patterns("*.pyc", "*.log", ".cache", "*.pdb")
    for path in build.iterdir():
        if path.is_file() and path.suffix.lower() in (".exe", ".dll"):
            shutil.copy2(path, output / path.name)
    shutil.copytree(build / "data", output / "data", ignore=ignore)

    # 内置推理引擎：runtime/llama/<engine-name>/（InferenceService 自动发现）。
    for source in engines:
        shutil.copytree(source, output / "runtime" / "llama" / source.name, ignore=ignore)

    # 云端 Node 隧道（不经过 Python，保持 v2 协议）。
    (output / "scripts").mkdir()
    shutil.copy2(node, output / "scripts/node.exe")
    shutil.copytree(ws, output / "scripts/node_modules/ws", ignore=ignore)
    shutil.copy2(ROOT / "scripts/cloud_bridge.js", output / "scripts/cloud_bridge.js")

    engine_meta = []
    for source in engines:
        manifest = source / "engine.json"
        info = json.loads(manifest.read_text(encoding="utf-8")) if manifest.exists() else {}
        engine_meta.append({
            "name": source.name,
            "tag": info.get("tag", "unknown"),
            "commit": info.get("commit", ""),
            "backend": info.get("backend", "unknown"),
            "builtFrom": info.get("builtFrom", "source"),
        })
    (output / "README.txt").write_text(
        "OpenMyModel Windows portable build\n"
        "Run openmymodel.exe. The llama.cpp engine is built in (runtime/llama).\n"
        "Select a GGUF model on Home; no Python installation is required.\n"
        "Cloud passwords and API keys are local user data; protect your Windows account.\n"
        "This package contains no model, configuration profile, credentials or debug logs.\n",
        encoding="utf-8")

    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    dirty = bool(subprocess.check_output(["git", "diff", "--name-only", "HEAD"], cwd=ROOT, text=True).strip())
    hashes = {str(path.relative_to(output)).replace("\\", "/"): sha256(path)
              for path in output.rglob("*") if path.is_file()}
    (output / "build-manifest.json").write_text(
        json.dumps({
            "gitRevision": revision,
            "workingTreeModified": dirty,
            "engines": engine_meta,
            "sha256": hashes,
        }, indent=2),
        encoding="utf-8")
    print(f"Created {output} ({len(hashes)} files). Source revision: {revision}, modified: {dirty}")
    for meta in engine_meta:
        print(f"  engine: {meta['name']} (llama.cpp {meta['tag']}, {meta['backend']})")


if __name__ == "__main__":
    main()
