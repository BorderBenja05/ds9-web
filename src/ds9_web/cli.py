import argparse
import os
import shutil
import subprocess
import sys
import time


def main():
    # Parse only our known args; everything else passes through to ds9
    parser = argparse.ArgumentParser(
        description="Launch DS9 in the browser via Xpra",
        usage="ds9-web [OPTIONS] [DS9_ARGS ...]",
        epilog="All unrecognized arguments are forwarded directly to ds9.",
    )
    parser.add_argument(
        "--port", type=int, default=5000, help="TCP port for the web client (default: 5000)"
    )
    parser.add_argument(
        "--display", type=int, default=100, help="X display number for Xpra (default: 100)"
    )
    parser.add_argument(
        "--bind", default="127.0.0.1", help="Address to bind to (default: 127.0.0.1)"
    )
    parser.add_argument(
        "--no-stop", action="store_true", help="Don't stop an existing Xpra session on this display first"
    )

    args, ds9_args = parser.parse_known_args()

    # Check dependencies
    for cmd in ("xpra", "ds9"):
        if not shutil.which(cmd):
            sys.exit(f"Error: '{cmd}' not found on PATH")

    display = f":{args.display}"

    # Stop existing session unless told not to
    if not args.no_stop:
        try:
            subprocess.run(["xpra", "stop", display], capture_output=True, timeout=5)
        except subprocess.TimeoutExpired:
            pass
        time.sleep(1)

    ds9_cmd = " ".join(["ds9"] + ds9_args)

    url = f"http://{args.bind}:{args.port}"
    print(f"\n  DS9 Web: \033[1;4m{url}\033[0m\n")

    # Replace this process with xpra, suppressing its output
    devnull = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    os.close(devnull)

    os.execvp(
        "xpra",
        [
            "xpra",
            "start",
            display,
            f"--bind-tcp={args.bind}:{args.port}",
            "--html=on",
            f"--start={ds9_cmd}",
            "--no-daemon",
            "--no-notifications",
            "--no-mdns",
        ],
    )
