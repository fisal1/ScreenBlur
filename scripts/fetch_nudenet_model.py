#!/usr/bin/env python3
"""Download the NudeNet 320n ONNX detector into engine/models/.

The model is not committed to this repository. The official ``nudenet`` PyPI
wheel contains the 320n weights; this script downloads the wheel with pip and
extracts only the ONNX file. NudeNet's GitHub repository is AGPL-3.0; verify
the model/licence terms before redistributing it with your build.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

DEFAULT_VERSION = "3.4.2"
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "engine" / "models" / "nudenet-320n.onnx"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", default=DEFAULT_VERSION, help="nudenet package version")
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"destination ONNX path (default: {DEFAULT_OUTPUT})",
    )
    args = parser.parse_args()

    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="screenblur-nudenet-") as temporary:
        print(f"Downloading nudenet=={args.version} metadata/weights via pip...")
        subprocess.run(
            [
                sys.executable,
                "-m",
                "pip",
                "download",
                "--no-deps",
                "--quiet",
                "--dest",
                temporary,
                f"nudenet=={args.version}",
            ],
            check=True,
        )

        wheels = sorted(Path(temporary).glob("nudenet-*.whl"))
        if not wheels:
            raise RuntimeError("pip did not download a nudenet wheel")

        with zipfile.ZipFile(wheels[0]) as archive:
            try:
                source = archive.open("nudenet/320n.onnx")
            except KeyError as exc:
                raise RuntimeError("nudenet wheel does not contain 320n.onnx") from exc

            temporary_output = output.with_name(f"{output.name}.tmp")
            try:
                with source, temporary_output.open("wb") as destination:
                    shutil.copyfileobj(source, destination, length=1024 * 1024)
                temporary_output.replace(output)
            finally:
                temporary_output.unlink(missing_ok=True)

    print(f"Installed NudeNet 320n: {output}")
    print("Rebuild the engine so the model is bundled: make build")
    print("NudeNet is AGPL-3.0; review the licence before redistribution.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
