#!/usr/bin/env python3
"""Build the pinned llama.cpp engine for Windows from the checked-out submodule.

CPU is always buildable when MSVC is present. CUDA and Vulkan are only built when
explicitly requested AND their toolchain is available; a missing toolchain is a
hard error, never a silent skip. Outputs are collected flat (llama-server.exe plus
ggml DLLs in one directory, matching the official release layout) into
artifacts/engine/llama-<tag>-<backend>-x64/ with an engine.json manifest.
"""

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
LOCK_FILE = REPO_ROOT / "third_party" / "llama.cpp.lock.json"
SUBMODULE = REPO_ROOT / "third_party" / "llama.cpp"
VSWHERE = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / (
    "Microsoft Visual Studio/Installer/vswhere.exe"
)


def die(msg: str) -> "None":
    print(f"[ERROR] {msg}", file=sys.stderr)
    sys.exit(1)


def run(cmd, **kwargs):
    return subprocess.run(cmd, **kwargs)


def capture(cmd, cwd=None):
    return subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )


def verify_pinned_source() -> dict:
    if not LOCK_FILE.is_file():
        die(f"missing lock file: {LOCK_FILE}")
    if not (SUBMODULE / ".git").exists() and not (REPO_ROOT / ".git" / "modules").is_dir():
        die("llama.cpp submodule is not initialized; run: git submodule update --init third_party/llama.cpp")
    lock = json.loads(LOCK_FILE.read_text(encoding="utf-8"))
    head = capture(["git", "-C", str(SUBMODULE), "rev-parse", "HEAD"])
    if head.returncode != 0:
        die(f"cannot resolve submodule HEAD: {head.stderr.strip()}")
    if head.stdout.strip() != lock["commit"]:
        die(
            "submodule HEAD does not match the pinned version.\n"
            f"  pinned: {lock['commit']} (tag {lock['tag']})\n"
            f"  actual: {head.stdout.strip()}\n"
            f"Fix with: git -C {SUBMODULE} checkout {lock['tag']}"
        )
    return lock


def detect_vs() -> dict:
    if not VSWHERE.is_file():
        die("vswhere.exe not found; install Visual Studio with the C++ workload (MSVC)")
    result = capture(
        [
            str(VSWHERE),
            "-products",
            "*",
            "-requires",
            "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
            "-format",
            "json",
        ]
    )
    if result.returncode != 0 or not result.stdout.strip():
        die("no Visual Studio installation with the C++ (MSVC) toolset was found")
    instances = json.loads(result.stdout)
    if not instances:
        die("no Visual Studio installation with the C++ (MSVC) toolset was found")
    # Prefer a VS2022 (productLine "2022") instance: CMake's VS generator drives
    # the whole build without running vcvars batch scripts, which some machines'
    # PATH entries (e.g. paths with parentheses) can break.
    preferred = [
        i for i in instances
        if i.get("catalog", {}).get("productLineVersion") in ("17", "2022")
    ]
    inst = (preferred or instances)[0]
    line = inst.get("catalog", {}).get("productLineVersion", "")
    vcvars = Path(inst["installationPath"]) / "VC/Auxiliary/Build/vcvars64.bat"
    return {
        "name": inst.get("installationName") or inst.get("displayName", "Visual Studio"),
        "productLine": line,
        "generator": "Visual Studio 17 2022" if line in ("17", "2022") else "",
        "vcvars": str(vcvars) if vcvars.is_file() else "",
        "installationPath": inst["installationPath"],
    }


def detect_nvcc() -> str:
    nvcc = shutil.which("nvcc")
    if not nvcc:
        return ""
    out = capture([nvcc, "--version"])
    for line in out.stdout.splitlines():
        if "release" in line.lower():
            return f"{nvcc} ({line.strip()})"
    return nvcc


def run_vcvars_batch(
    vcvars: str, command: str, cwd: Path, work_dir: Path, env: dict | None = None
) -> subprocess.CompletedProcess:
    """Run through a temp batch file: cmd quoting of inline 'call "x" && y' is fragile."""
    work_dir.mkdir(parents=True, exist_ok=True)
    batch = work_dir / "_ommbuild.cmd"
    batch.write_text(
        "@echo off\r\n"
        f'call "{vcvars}"\r\n'
        "if errorlevel 1 exit /b 1\r\n"
        f"{command}\r\n",
        encoding="ascii",
        errors="strict",
    )
    try:
        return run(
            ["cmd", "/d", "/c", str(batch)],
            cwd=str(cwd),
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    finally:
        batch.unlink(missing_ok=True)


def sanitized_build_env(nvcc_path: str) -> dict:
    """Minimal PATH for the vcvars fallback: broken machine PATH entries (parentheses,
    unquoted dirs) crash cmd batch parsing inside vsdevcmd.bat."""
    env = dict(os.environ)
    dirs = [
        r"C:\Windows\System32",
        r"C:\Windows",
        r"C:\Windows\System32\Wbem",
        r"C:\Windows\System32\WindowsPowerShell\v1.0",
    ]
    for tool in ("cmake", "ninja", nvcc_path):
        if tool:
            resolved = shutil.which(tool)
            if resolved:
                dirs.append(str(Path(resolved).parent))
    env["PATH"] = ";".join(dirs)
    return env


def configure_and_build(backend: str, build_dir: Path, args, vs: dict) -> dict:
    flags = [
        f"-DCMAKE_BUILD_TYPE={args.config}",
        "-DGGML_BACKEND_DL=ON",
        "-DGGML_CPU_ALL_VARIANTS=ON",
        "-DLLAMA_BUILD_TESTS=OFF",
        "-DLLAMA_BUILD_EXAMPLES=OFF",
        "-DLLAMA_BUILD_SERVER=ON",
    ]
    toolchain = {
        "vs": vs["name"],
        "generator": "",
        "cmake": shutil.which("cmake") or "cmake",
        "ninja": shutil.which("ninja") or "ninja",
        "nvcc": "",
    }
    nvcc = ""
    if backend == "cuda":
        nvcc = detect_nvcc()
        if not nvcc:
            die("CUDA backend requested but nvcc was not found in PATH; install the CUDA toolkit or drop it from --backends")
        toolchain["nvcc"] = nvcc
        flags += ["-DGGML_CUDA=ON", f"-DCMAKE_CUDA_ARCHITECTURES={args.cuda_architectures}"]
    elif backend == "vulkan":
        if not (shutil.which("glslc") or shutil.which("glslangValidator") or os.environ.get("VULKAN_SDK")):
            die(
                "Vulkan backend requested but the Vulkan SDK was not found (glslc/VULKAN_SDK missing); "
                "install the SDK or drop it from --backends, or use the official prebuilt asset in the lock file"
            )
        flags += ["-DGGML_VULKAN=ON"]
    elif backend != "cpu":
        die(f"unknown backend '{backend}' (expected cpu, cuda or vulkan)")

    jobs = args.jobs or os.cpu_count() or 4
    started = time.monotonic()
    if vs["generator"]:
        # No cmd wrapper: cmake locates VS itself, so run it as an argv list and
        # keep "Visual Studio 17 2022" as a single argument.
        cmake = shutil.which("cmake") or "cmake"
        configure_cmd = [
            cmake, "-S", str(SUBMODULE), "-B", str(build_dir),
            "-G", vs["generator"], "-A", "x64", *flags,
        ]
        build_cmd = [
            cmake, "--build", str(build_dir), "--config", args.config,
            "--target", "llama-server", "--parallel", str(jobs),
        ]
        print(f"[{backend}] configure + build with {vs['generator']} (jobs={jobs}) ...")
        proc = run(configure_cmd, cwd=str(REPO_ROOT), capture_output=True, text=True,
                   encoding="utf-8", errors="replace")
        if proc.returncode == 0:
            proc = run(build_cmd, cwd=str(REPO_ROOT), capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    else:
        if not vs["vcvars"]:
            die("no usable MSVC environment (generator unsupported and vcvars64.bat missing)")
        flags += ["-G", "Ninja"]
        toolchain["generator"] = "Ninja + vcvars64"
        if backend == "cuda":
            flags.append(f'-DCMAKE_CUDA_COMPILER="{Path(nvcc.split(" (")[0])}"')
        build_cmd = (
            f'cmake -S "{SUBMODULE}" -B "{build_dir}" {" ".join(flags)} '
            f'&& cmake --build "{build_dir}" --target llama-server --parallel {jobs}'
        )
        print(f"[{backend}] configure + build with Ninja + vcvars64 (jobs={jobs}) ...")
        proc = run_vcvars_batch(
            vs["vcvars"], build_cmd, REPO_ROOT, build_dir, env=sanitized_build_env(nvcc.split(" (")[0])
        )
    if proc.returncode != 0:
        tail = (proc.stdout or "")[-4000:] + (proc.stderr or "")[-2000:]
        print(tail, file=sys.stderr)
        die(f"llama.cpp {backend} build failed with exit code {proc.returncode}")
    print(f"[{backend}] build finished in {time.monotonic() - started:.0f}s")
    return toolchain


def find_bin_dir(build_dir: Path) -> Path:
    # Ninja outputs go to <build>/bin directly.
    bin_dir = build_dir / "bin"
    if (bin_dir / "llama-server.exe").is_file():
        return bin_dir
    matches = list(build_dir.rglob("llama-server.exe"))
    if not matches:
        die(f"llama-server.exe not produced under {build_dir}")
    return matches[0].parent


def collect_output(backend: str, build_dir: Path, out_dir: Path, lock: dict) -> list:
    bin_dir = find_bin_dir(build_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    copied = []
    for src in sorted(bin_dir.iterdir()):
        if src.suffix.lower() in {".exe", ".dll"}:
            shutil.copy2(src, out_dir / src.name)
            copied.append(src.name)
    if backend == "cuda":
        cuda_bin = Path(os.environ.get("CUDA_PATH", "")) / "bin"
        if cuda_bin.is_dir():
            for src in sorted(cuda_bin.glob("cudart64_*.dll")):
                target = out_dir / src.name
                if not target.exists():
                    shutil.copy2(src, target)
                    copied.append(src.name)
    if not any(n.startswith("ggml-") for n in copied):
        die(f"no ggml backend DLLs were found next to llama-server.exe in {bin_dir}")
    if "ggml-base.dll" not in copied:
        print(f"[WARN] ggml-base.dll missing from {bin_dir}; the engine may still load if statically linked")
    return copied


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_engine(out_dir: Path) -> str:
    exe = out_dir / "llama-server.exe"
    proc = run(
        [str(exe), "--version"],
        cwd=str(out_dir),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
    )
    if proc.returncode != 0:
        die(f"llama-server --version failed (exit {proc.returncode}): {(proc.stderr or proc.stdout)[-1500:]}")
    return (proc.stdout or "").strip() + (("\n" + proc.stderr.strip()) if proc.stderr.strip() else "")


def write_manifest(out_dir: Path, lock: dict, backend: str, toolchain: dict, args, version_output: str) -> None:
    files = {}
    for path in sorted(out_dir.iterdir()):
        if path.is_file() and path.name != "engine.json":
            files[path.name] = {"sha256": sha256_of(path), "size": path.stat().st_size}
    manifest = {
        "name": "llama.cpp",
        "tag": lock["tag"],
        "commit": lock["commit"],
        "releaseDate": lock["releaseDate"],
        "backend": backend,
        "builtFrom": "source",
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "platform": f"windows-{platform.machine().lower()}",
        "config": args.config,
        "cudaArchitectures": args.cuda_architectures if backend == "cuda" else None,
        "toolchain": toolchain,
        "versionOutput": version_output,
        "files": files,
    }
    (out_dir / "engine.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"[{backend}] manifest written: {out_dir / 'engine.json'} ({len(files)} files)")


def main() -> None:
    if platform.system() != "Windows":
        die("this script targets Windows builds; run it on a Windows host")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backends", default="cpu", help="comma list: cpu,cuda,vulkan (cpu recommended)")
    parser.add_argument("--out", default=str(REPO_ROOT / "artifacts" / "engine"))
    parser.add_argument("--jobs", type=int, default=0, help="parallel build jobs (default: CPU count)")
    parser.add_argument("--config", default="Release", choices=["Release", "Debug", "RelWithDebInfo"])
    parser.add_argument("--cuda-architectures", default="native", help="CMAKE_CUDA_ARCHITECTURES for the CUDA backend")
    args = parser.parse_args()

    lock = verify_pinned_source()
    print(f"source pinned: {lock['tag']} @ {lock['commit']}")
    backends = [b.strip().lower() for b in args.backends.split(",") if b.strip()]
    if "cpu" not in backends:
        print(
            "[WARN] cpu backend not in --backends; the CPU engine is required for "
            "packaging — make sure artifacts/engine contains a CPU build"
        )
    vs = detect_vs()
    print(f"MSVC toolchain: {vs['name']}")

    for backend in backends:
        slug = "vs2022" if vs["generator"] else "ninja-vcvars"
        build_dir = REPO_ROOT / "build" / "engine" / slug / backend
        out_dir = Path(args.out) / f"llama-{lock['tag']}-{backend}-x64"
        toolchain = configure_and_build(backend, build_dir, args, vs)
        copied = collect_output(backend, build_dir, out_dir, lock)
        print(f"[{backend}] collected {len(copied)} files -> {out_dir}")
        version_output = verify_engine(out_dir)
        print(f"[{backend}] engine version check OK:\n{version_output}\n")
        write_manifest(out_dir, lock, backend, toolchain, args, version_output)

    print("engine build complete.")


if __name__ == "__main__":
    main()
