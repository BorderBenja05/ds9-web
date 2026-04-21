"""HTTP server: serves the static UI and a REST API for the current frame.

Pure stdlib — no Flask/starlette dependency. Single-user, single-frame for now.
"""

from __future__ import annotations

import json
import mimetypes
import os
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from urllib.parse import parse_qs, urlparse

from . import fits_ops
from .fits_ops import FrameState


STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


class AppState:
    def __init__(self):
        self.frame = FrameState()
        self.lock = threading.Lock()

    def load(self, path: str) -> None:
        data, header, wcs = fits_ops.load_fits(path)
        with self.lock:
            f = self.frame
            f.path = path
            f.data = data
            f.header = header
            f.wcs = wcs
            # reset view
            f.zoom = 1.0
            f.pan_x = data.shape[1] / 2.0
            f.pan_y = data.shape[0] / 2.0
            f.rotate = 0.0
            # recompute limits under current mode (default minmax)
            fits_ops.set_scale(f, limit_mode=f.limit_mode)


def make_handler(state: AppState, initial_args: dict):
    class Handler(BaseHTTPRequestHandler):
        # Silence default logging
        def log_message(self, fmt, *args):  # noqa: N802
            pass

        # ----- helpers -----
        def _send_json(self, code: int, obj) -> None:
            body = json.dumps(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _send_bytes(self, code: int, content_type: str, body: bytes,
                        cache: str = "no-store") -> None:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", cache)
            self.end_headers()
            self.wfile.write(body)

        def _read_json(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length == 0:
                return {}
            raw = self.rfile.read(length)
            try:
                return json.loads(raw.decode("utf-8"))
            except Exception:
                return {}

        # ----- routing -----
        def do_GET(self):  # noqa: N802
            try:
                self._route_get()
            except Exception:
                traceback.print_exc()
                self._send_json(500, {"error": "internal"})

        def do_POST(self):  # noqa: N802
            try:
                self._route_post()
            except Exception:
                traceback.print_exc()
                self._send_json(500, {"error": "internal"})

        def _route_get(self):
            u = urlparse(self.path)
            path = u.path
            qs = parse_qs(u.query)

            if path == "/" or path == "/index.html":
                return self._send_static("index.html")
            if path.startswith("/static/"):
                return self._send_static(path[len("/static/"):])

            if path == "/api/state":
                return self._send_json(200, _frame_to_dict(state.frame, initial_args))
            if path == "/api/image":
                with state.frame.lock:
                    png = fits_ops.render_full(state.frame)
                if not png:
                    return self._send_json(404, {"error": "no image"})
                return self._send_bytes(200, "image/png", png)
            if path == "/api/pixel":
                try:
                    ix = int(float(qs.get("x", ["0"])[0]))
                    iy = int(float(qs.get("y", ["0"])[0]))
                except ValueError:
                    return self._send_json(400, {"error": "bad coords"})
                f = state.frame
                v = fits_ops.pixel_value(f, ix, iy)
                wcs = fits_ops.wcs_of(f, ix, iy)
                return self._send_json(200, {
                    "x": ix, "y": iy,
                    "value": v,
                    "wcs": {"ra": wcs[0], "dec": wcs[1]} if wcs else None,
                })
            if path == "/api/stats":
                return self._send_json(200, fits_ops.stats(state.frame))
            if path == "/api/histogram":
                try:
                    bins = int(qs.get("bins", ["256"])[0])
                except ValueError:
                    bins = 256
                return self._send_json(200, fits_ops.histogram(state.frame, bins))
            if path == "/api/header":
                return self._send_json(200, state.frame.header)
            if path == "/api/regions":
                return self._send_json(200, {"regions": state.frame.regions})

            return self._send_json(404, {"error": "not found"})

        def _route_post(self):
            u = urlparse(self.path)
            path = u.path
            body = self._read_json()

            if path == "/api/load":
                fpath = body.get("path")
                if not fpath or not os.path.isfile(fpath):
                    return self._send_json(400, {"error": "file not found"})
                try:
                    state.load(fpath)
                except Exception as e:
                    return self._send_json(400, {"error": str(e)})
                return self._send_json(200, _frame_to_dict(state.frame, initial_args))

            if path == "/api/scale":
                fits_ops.set_scale(
                    state.frame,
                    scale=body.get("scale"),
                    limit_mode=body.get("limit_mode"),
                    vmin=body.get("vmin"),
                    vmax=body.get("vmax"),
                )
                return self._send_json(200, _frame_to_dict(state.frame, initial_args))

            if path == "/api/cmap":
                cmap = body.get("cmap")
                if cmap and cmap in fits_ops.CMAPS:
                    state.frame.cmap = cmap
                if "invert" in body:
                    state.frame.invert = bool(body["invert"])
                return self._send_json(200, _frame_to_dict(state.frame, initial_args))

            if path == "/api/view":
                f = state.frame
                if "zoom" in body:
                    try:
                        f.zoom = max(0.01, float(body["zoom"]))
                    except (TypeError, ValueError):
                        pass
                if "pan_x" in body:
                    try:
                        f.pan_x = float(body["pan_x"])
                    except (TypeError, ValueError):
                        pass
                if "pan_y" in body:
                    try:
                        f.pan_y = float(body["pan_y"])
                    except (TypeError, ValueError):
                        pass
                if "rotate" in body:
                    try:
                        f.rotate = float(body["rotate"]) % 360.0
                    except (TypeError, ValueError):
                        pass
                return self._send_json(200, _frame_to_dict(state.frame, initial_args))

            if path == "/api/regions":
                action = body.get("action", "set")
                regs = state.frame.regions
                if action == "add":
                    r = body.get("region")
                    if isinstance(r, dict):
                        regs.append(r)
                elif action == "set":
                    regs_new = body.get("regions")
                    if isinstance(regs_new, list):
                        state.frame.regions = regs_new
                elif action == "clear":
                    state.frame.regions = []
                elif action == "delete":
                    idx = body.get("index")
                    if isinstance(idx, int) and 0 <= idx < len(regs):
                        regs.pop(idx)
                return self._send_json(200, {"regions": state.frame.regions})

            return self._send_json(404, {"error": "not found"})

        # ----- static files -----
        def _send_static(self, rel: str):
            # resist traversal
            rel = rel.lstrip("/").replace("\\", "/")
            if ".." in rel.split("/"):
                return self._send_json(403, {"error": "forbidden"})
            full = os.path.normpath(os.path.join(STATIC_DIR, rel))
            if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
                return self._send_json(404, {"error": "not found"})
            ctype, _ = mimetypes.guess_type(full)
            ctype = ctype or "application/octet-stream"
            with open(full, "rb") as fh:
                body = fh.read()
            return self._send_bytes(200, ctype, body, cache="no-cache")

    return Handler


def _frame_to_dict(f: FrameState, initial_args: dict) -> dict:
    return {
        "path": f.path,
        "filename": os.path.basename(f.path) if f.path else None,
        "width": f.width,
        "height": f.height,
        "scale": f.scale,
        "limit_mode": f.limit_mode,
        "vmin": f.vmin,
        "vmax": f.vmax,
        "cmap": f.cmap,
        "invert": f.invert,
        "zoom": f.zoom,
        "pan_x": f.pan_x,
        "pan_y": f.pan_y,
        "rotate": f.rotate,
        "has_wcs": f.wcs is not None,
        "regions": f.regions,
        "scales": fits_ops.SCALE_FUNCS,
        "limit_modes": fits_ops.SCALE_LIMIT_MODES,
        "cmaps": fits_ops.CMAPS,
        "initial": initial_args,
    }


def run_server(bind: str, port: int, initial_path: str | None,
               initial_args: dict) -> None:
    state = AppState()
    if initial_path:
        state.load(initial_path)
        # apply initial scale/cmap
        f = state.frame
        if initial_args.get("scale"):
            fits_ops.set_scale(f, scale=initial_args["scale"])
        if initial_args.get("zscale"):
            fits_ops.set_scale(f, limit_mode="zscale")
        elif initial_args.get("minmax"):
            fits_ops.set_scale(f, limit_mode="minmax")
        if initial_args.get("cmap"):
            if initial_args["cmap"] in fits_ops.CMAPS:
                f.cmap = initial_args["cmap"]
        if initial_args.get("invert"):
            f.invert = True

    Handler = make_handler(state, initial_args)
    server = ThreadingHTTPServer((bind, port), Handler)
    url = f"http://{bind}:{port}"
    print(f"\n  DS9 HTTP: \033[1;4m{url}\033[0m\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()
