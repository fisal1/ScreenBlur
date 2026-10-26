"""CLI entrypoint: bind a loopback socket, announce the port, run Uvicorn."""

from __future__ import annotations

import argparse
import contextlib
import json
import logging
import os
import socket
import sys
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path

import uvicorn

from . import __version__
from .config import (
    Settings,
    configure_logging,
    generate_token,
    host_for_bind,
)
from .ws import create_app

logger = logging.getLogger(__name__)


def build_parser(settings: Settings) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="screenblur-engine",
        description="Local-only ScreenBlur detection sidecar (WebSocket).",
    )
    parser.add_argument("--host", default=settings.host, help="loopback bind address")
    parser.add_argument(
        "--port",
        type=int,
        default=settings.port,
        help="TCP port (0 chooses a free port; default: %(default)s)",
    )
    parser.add_argument(
        "--token",
        default=None,
        help="bearer token (default: SCREENBLUR_TOKEN or auto-generated)",
    )
    parser.add_argument(
        "--model",
        type=Path,
        default=settings.model_path,
        help="path to an ONNX classifier or NudeNet detector (default: models/nsfw.onnx)",
    )
    parser.add_argument(
        "--model-kind",
        choices=("auto", "classifier", "nudenet"),
        default=settings.model_kind,
        help="detector adapter; auto uses the filename (default: %(default)s)",
    )
    parser.add_argument(
        "--model-input-size",
        type=int,
        default=settings.model_input_size,
        help="square model input size (default: %(default)s)",
    )
    parser.add_argument(
        "--explicit-class-index",
        type=int,
        default=settings.explicit_class_index,
        help="output index for the explicit class (default: %(default)s)",
    )
    parser.add_argument(
        "--sensitivity",
        type=float,
        default=settings.sensitivity,
        help="minimum score for show=true (default: %(default)s)",
    )
    parser.add_argument(
        "--fps",
        type=float,
        default=settings.fps,
        help="advisory capture FPS (default: %(default)s)",
    )
    parser.add_argument(
        "--max-frame-bytes",
        type=int,
        default=settings.max_frame_bytes,
        help="maximum accepted binary frame size (default: %(default)s)",
    )
    parser.add_argument(
        "--log-level",
        choices=("debug", "info", "warning", "error", "critical"),
        default=settings.log_level,
        help="logging verbosity (default: %(default)s)",
    )
    parser.add_argument(
        "--ready-file",
        type=Path,
        default=settings.ready_file,
        help="write {port, token?, pid} JSON here after binding",
    )
    parser.add_argument("--version", action="version", version=__version__)
    return parser


def bind_socket(host: str, port: int) -> socket.socket:
    """Bind a listening TCP socket, supporting port 0 and loopback IPv6."""
    bind_host = host_for_bind(host)
    family = socket.AF_INET6 if ":" in bind_host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if family == socket.AF_INET6:
        with contextlib.suppress(OSError):
            sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    sock.bind((bind_host, port))
    sock.listen(128)
    sock.setblocking(False)
    return sock


def write_ready_file(path: Path, *, port: int, token: str | None) -> None:
    """Atomically write the startup handshake file for Electron."""
    payload: dict[str, object] = {"port": port, "pid": os.getpid()}
    if token is not None:
        payload["token"] = token
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp")
    temporary.write_text(json.dumps(payload), encoding="utf-8")
    with contextlib.suppress(OSError):
        # The file may contain the auto-generated token; keep it owner-only.
        os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        env_settings = Settings.from_env()
    except ValueError as exc:
        print(f"screenblur-engine: {exc}", file=sys.stderr)
        return 2

    parser = build_parser(env_settings)
    args = parser.parse_args(argv)

    settings = replace(
        env_settings,
        host=args.host,
        port=args.port,
        token=args.token if args.token is not None else env_settings.token,
        model_path=args.model,
        model_kind=args.model_kind,
        model_input_size=args.model_input_size,
        explicit_class_index=args.explicit_class_index,
        sensitivity=args.sensitivity,
        fps=args.fps,
        max_frame_bytes=args.max_frame_bytes,
        log_level=str(args.log_level).lower(),
        ready_file=args.ready_file,
    )
    try:
        settings.validate()
    except ValueError as exc:
        parser.error(str(exc))

    configure_logging(settings.log_level)

    generated_token = settings.token is None
    token = settings.token or generate_token()
    settings = replace(settings, token=token)

    try:
        sock = bind_socket(settings.host, settings.port)
    except OSError as exc:
        logger.error("could not bind %s:%s: %s", settings.host, settings.port, exc)
        return 1

    port = int(sock.getsockname()[1])
    # Electron reads this line from the child process stdout before connecting.
    print(f"PORT={port}", flush=True)
    if generated_token:
        print(f"TOKEN={token}", flush=True)

    if settings.ready_file is not None:
        try:
            write_ready_file(
                settings.ready_file,
                port=port,
                token=token if generated_token else None,
            )
        except OSError as exc:
            logger.error("could not write ready file: %s", exc)
            sock.close()
            return 1

    logger.info("ScreenBlur engine %s starting on %s:%d", __version__, settings.host, port)
    app = create_app(settings)
    engine = app.state.engine
    logger.info(
        "detector=%s model=%s error=%s",
        engine.detector.id,
        engine.model_path,
        engine.detector_error or "none",
    )

    config = uvicorn.Config(
        app,
        host=host_for_bind(settings.host),
        port=port,
        log_level=settings.log_level,
        log_config=None,
        access_log=False,
        server_header=False,
        proxy_headers=False,
        lifespan="off",
        # Leave a little headroom so an oversized-but-close frame is rejected
        # by our protocol validator with a JSON error instead of being dropped
        # by the WebSocket layer.
        ws_max_size=settings.max_frame_bytes + 64 * 1024,
        timeout_graceful_shutdown=5,
    )
    server = uvicorn.Server(config)
    try:
        # uvicorn installs SIGINT/SIGTERM handlers in Server.run and exits
        # gracefully, draining connections before returning.
        server.run(sockets=[sock])
    except KeyboardInterrupt:
        logger.info("interrupted; shutting down")
    finally:
        sock.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
