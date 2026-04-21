"""CLI for ds9-http: a pure-HTTP, browser-based DS9 clone."""

from __future__ import annotations

import argparse
import os
import sys

from .server import run_server


def main():
    parser = argparse.ArgumentParser(
        prog="ds9-http",
        description="Browser-based DS9-like FITS viewer served over HTTP",
        usage="ds9-http [OPTIONS] [FITS_FILE] [DS9_ARGS ...]",
    )
    parser.add_argument("--port", type=int, default=10000,
                        help="TCP port for the web client (default: 10000)")
    parser.add_argument("--bind", default="127.0.0.1",
                        help="Address to bind to (default: 127.0.0.1)")

    # DS9-compatible flags consumed as initial state.
    parser.add_argument("-scale", dest="scale", default=None,
                        choices=["linear", "log", "power", "sqrt",
                                 "squared", "asinh", "sinh", "histequ"])
    parser.add_argument("-zscale", dest="zscale", action="store_true")
    parser.add_argument("-minmax", dest="minmax", action="store_true")
    parser.add_argument("-cmap", dest="cmap", default=None)
    parser.add_argument("-invert", dest="invert", action="store_true")

    args, rest = parser.parse_known_args()

    # Anything in `rest` that's a readable file path is treated as a FITS file.
    # Everything else is silently forwarded-via-initial-state (best effort).
    files = [a for a in rest if not a.startswith("-") and os.path.isfile(a)]
    initial_path = files[0] if files else None

    # Dependency check
    missing = []
    for mod in ("numpy", "astropy", "PIL"):
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    if missing:
        sys.exit(
            "Error: missing dependencies: " + ", ".join(missing) +
            "\n  Install with: pip install '.[http]'"
        )

    initial_args = {
        "scale": args.scale,
        "zscale": args.zscale,
        "minmax": args.minmax,
        "cmap": args.cmap,
        "invert": args.invert,
    }

    run_server(args.bind, args.port, initial_path, initial_args)


if __name__ == "__main__":
    main()
