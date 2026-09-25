#!/usr/bin/env python3
"""Build relocatable and Debian packages for the OpenMyModel Linux desktop app.

Run this on Linux after installing Flutter's Linux desktop dependencies. The
package contains the cloud bridge, its `ws` dependency, and a private Node.js
runtime. Docker and the NVIDIA Container Toolkit remain host prerequisites for
starting the vLLM engine.
"""

from __future__ import annotations

import argparse
import os
import platform
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"


def run(command: list[str], *, cwd: Path | None = None) -> None:
    subprocess.run(command, cwd=cwd, check=True)


def flutter_version() -> str:
    text = (FRONTEND / "pubspec.yaml").read_text(encoding="utf-8")
    match = re.search(r"^version:\s*([0-9]+(?:\.[0-9]+){1,3})(?:\+[^\s]+)?\s*$", text, re.M)
    if not match:
        raise RuntimeError("Could not read the app version from frontend/pubspec.yaml")
    return match.group(1)


def copy_bundle(bundle: Path, destination: Path, node: Path) -> None:
    if not bundle.is_dir() or not (bundle / "openmymodel").is_file():
        raise FileNotFoundError(f"Flutter Linux release bundle not found: {bundle}")
    shutil.copytree(bundle, destination)

    bridge = destination / "scripts"
    bridge.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "scripts" / "cloud_bridge.js", bridge / "cloud_bridge.js")
    shutil.copytree(
        ROOT / "scripts" / "node_modules" / "ws",
        bridge / "node_modules" / "ws",
        dirs_exist_ok=True,
    )
    target_node = bridge / "node"
    shutil.copy2(node, target_node)
    target_node.chmod(target_node.stat().st_mode | 0o111)

    shutil.copy2(ROOT / "logo.png", destination / "openmymodel.png")
    (destination / "README-LINUX.txt").write_text(
        "OpenMyModel for Linux\n"
        "=====================\n\n"
        "Launch ./openmymodel from this directory.\n"
        "The bundled vLLM engine runs in Docker and requires an NVIDIA GPU, a\n"
        "working Docker Engine, and NVIDIA Container Toolkit configured for\n"
        "Docker. On first start Docker downloads the selected vLLM image.\n\n"
        "The node API binds to 127.0.0.1. Use the Cloud Connection page to\n"
        "connect it to an OpenMyModel gateway. Keep the generated node key\n"
        "private and enter the same value in that gateway's node settings.\n",
        encoding="utf-8",
    )


def write_desktop_file(path: Path) -> None:
    path.write_text(
        "[Desktop Entry]\n"
        "Type=Application\n"
        "Name=OpenMyModel\n"
        "GenericName=Local AI Node Manager\n"
        "Comment=Manage a local vLLM inference node\n"
        "Exec=/opt/openmymodel/openmymodel\n"
        "Icon=openmymodel\n"
        "Terminal=false\n"
        "Categories=Development;Utility;\n"
        "StartupWMClass=openmymodel\n",
        encoding="utf-8",
    )


def package_deb(app: Path, destination: Path, version: str, arch: str) -> None:
    with tempfile.TemporaryDirectory(prefix="openmymodel-deb-") as temp:
        root = Path(temp)
        opt = root / "opt" / "openmymodel"
        shutil.copytree(app, opt)
        desktop = root / "usr" / "share" / "applications" / "openmymodel.desktop"
        desktop.parent.mkdir(parents=True, exist_ok=True)
        write_desktop_file(desktop)
        icon = root / "usr" / "share" / "icons" / "hicolor" / "512x512" / "apps" / "openmymodel.png"
        icon.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / "logo.png", icon)

        control = root / "DEBIAN" / "control"
        control.parent.mkdir(parents=True, exist_ok=True)
        control.write_text(
            f"Package: openmymodel\n"
            f"Version: {version}-1\n"
            f"Section: utils\n"
            f"Priority: optional\n"
            f"Architecture: {arch}\n"
            f"Depends: libc6, libstdc++6, libgcc-s1, liblzma5, libblkid1, libgtk-3-0 | libgtk-3-0t64\n"
            f"Maintainer: OpenMyModel contributors\n"
            f"Description: desktop manager for local OpenMyModel inference nodes\n"
            f" Manages vLLM Docker nodes and connects them to an OpenMyModel gateway.\n",
            encoding="utf-8",
        )
        run(["dpkg-deb", "--build", "--root-owner-group", str(root), str(destination)])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="New output directory; existing paths are never overwritten")
    parser.add_argument("--flutter", default="flutter", help="Flutter executable available on Linux")
    parser.add_argument("--node", type=Path, default=None, help="Linux Node.js executable to bundle (defaults to PATH)")
    parser.add_argument("--format", choices=("tar.gz", "deb", "both"), default="both")
    parser.add_argument("--skip-build", action="store_true", help="Package an existing Flutter release bundle")
    args = parser.parse_args()

    if platform.system() != "Linux":
        parser.error("Run this packaging script on Linux; Flutter Linux desktop cannot be cross-built from Windows.")
    output = args.output.expanduser().resolve()
    if output.exists():
        parser.error(f"Refusing to overwrite existing output: {output}")
    node = args.node.expanduser().resolve() if args.node else Path(shutil.which("node") or "")
    if not node.is_file():
        parser.error("Linux Node.js was not found; install Node.js or pass --node /path/to/node")
    if not (ROOT / "scripts" / "node_modules" / "ws" / "package.json").is_file():
        parser.error("Bridge dependency is missing; run npm ci --prefix scripts first")

    version = flutter_version()
    if not args.skip_build:
        run([args.flutter, "build", "linux", "--release"], cwd=FRONTEND)
    bundle = FRONTEND / "build" / "linux" / "x64" / "release" / "bundle"
    if platform.machine().lower() not in {"x86_64", "amd64"}:
        parser.error("The current vLLM NVIDIA desktop package is built for x86_64 Linux.")

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="openmymodel-linux-") as temp:
        app = Path(temp) / "openmymodel"
        copy_bundle(bundle, app, node)
        output.mkdir(parents=True)
        try:
            base = f"openmymodel-{version}-linux-x86_64"
            if args.format in ("tar.gz", "both"):
                shutil.make_archive(str(output / base), "gztar", root_dir=app.parent, base_dir=app.name)
            if args.format in ("deb", "both"):
                package_deb(app, output / f"openmymodel_{version}-1_amd64.deb", version, "amd64")
        except Exception:
            shutil.rmtree(output, ignore_errors=True)
            raise
    print(f"Linux packages written to {output}")


if __name__ == "__main__":
    main()
