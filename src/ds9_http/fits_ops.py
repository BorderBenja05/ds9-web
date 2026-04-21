"""FITS image operations: load, scale, colormap, render."""

from __future__ import annotations

import io
import math
import threading
from dataclasses import dataclass, field
from typing import Optional

import numpy as np


SCALE_FUNCS = [
    "linear", "log", "power", "sqrt", "squared",
    "asinh", "sinh", "histequ",
]

SCALE_LIMIT_MODES = [
    "minmax", "zscale",
    "99.5", "99", "98", "97", "95", "90",
    "user",
]

CMAPS = [
    "grey", "red", "green", "blue",
    "a", "b", "bb", "he",
    "heat", "cool", "rainbow", "sls",
    "hsv", "viridis", "plasma", "magma", "cividis",
]


@dataclass
class FrameState:
    path: Optional[str] = None
    data: Optional[np.ndarray] = None  # 2-D float32
    header: dict = field(default_factory=dict)
    wcs: Optional[object] = None
    scale: str = "linear"
    limit_mode: str = "minmax"
    vmin: float = 0.0
    vmax: float = 1.0
    cmap: str = "grey"
    invert: bool = False
    zoom: float = 1.0
    # Pan is the image-space point that is centered on the canvas.
    pan_x: Optional[float] = None
    pan_y: Optional[float] = None
    rotate: float = 0.0
    regions: list = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def loaded(self) -> bool:
        return self.data is not None

    @property
    def width(self) -> int:
        return 0 if self.data is None else int(self.data.shape[1])

    @property
    def height(self) -> int:
        return 0 if self.data is None else int(self.data.shape[0])


# ----- loading ------------------------------------------------------------

def load_fits(path: str) -> tuple[np.ndarray, dict, Optional[object]]:
    """Load a FITS file's first image HDU. Returns (data, header, WCS-or-None)."""
    from astropy.io import fits
    try:
        from astropy.wcs import WCS
    except Exception:  # pragma: no cover
        WCS = None  # type: ignore

    with fits.open(path, memmap=False) as hdul:
        hdu = None
        for h in hdul:
            if getattr(h, "data", None) is not None and h.data.ndim >= 2:
                hdu = h
                break
        if hdu is None:
            raise ValueError(f"No image data in {path}")

        data = np.asarray(hdu.data)
        # Flatten higher-dim cubes to first plane.
        while data.ndim > 2:
            data = data[0]
        data = data.astype(np.float32, copy=False)

        header = {k: _json_safe(v) for k, v in dict(hdu.header).items()}
        wcs = None
        if WCS is not None:
            try:
                wcs = WCS(hdu.header).celestial
                if not wcs.has_celestial:
                    wcs = None
            except Exception:
                wcs = None

        return data, header, wcs


def _json_safe(v):
    try:
        if isinstance(v, (bool, int, float, str)):
            return v
        if v is None:
            return None
        return str(v)
    except Exception:
        return str(v)


# ----- scale limits -------------------------------------------------------

def compute_limits(data: np.ndarray, mode: str) -> tuple[float, float]:
    flat = data[np.isfinite(data)]
    if flat.size == 0:
        return 0.0, 1.0
    if mode == "minmax":
        return float(flat.min()), float(flat.max())
    if mode == "zscale":
        return _zscale(flat)
    try:
        pct = float(mode)
    except ValueError:
        return float(flat.min()), float(flat.max())
    # symmetric percentile around median
    lo_p = (100.0 - pct) / 2.0
    hi_p = 100.0 - lo_p
    lo, hi = np.percentile(flat, [lo_p, hi_p])
    return float(lo), float(hi)


def _zscale(values: np.ndarray, n_samples: int = 1000, contrast: float = 0.25):
    """IRAF-style zscale."""
    v = values.ravel()
    if v.size > n_samples:
        idx = np.linspace(0, v.size - 1, n_samples).astype(int)
        v = v[idx]
    v = np.sort(v)
    n = v.size
    if n < 5:
        return float(v.min()), float(v.max())

    x = np.arange(n, dtype=np.float64)
    median = float(np.median(v))
    # linear fit
    slope, intercept = np.polyfit(x, v, 1)
    if contrast > 0:
        slope = slope / contrast
    center = (n - 1) / 2.0
    z1 = max(float(v.min()), median + slope * (0 - center))
    z2 = min(float(v.max()), median + slope * ((n - 1) - center))
    if z1 >= z2:
        return float(v.min()), float(v.max())
    return z1, z2


# ----- scale functions ----------------------------------------------------

def apply_scale(data: np.ndarray, scale: str, vmin: float, vmax: float) -> np.ndarray:
    """Return a [0,1] float32 array, NaNs -> 0."""
    if vmax <= vmin:
        vmax = vmin + 1e-6
    x = (data - vmin) / (vmax - vmin)
    x = np.clip(x, 0.0, 1.0)

    if scale == "linear":
        y = x
    elif scale == "log":
        # DS9 uses a = 1000 by default
        a = 1000.0
        y = np.log10(a * x + 1.0) / np.log10(a + 1.0)
    elif scale == "power":
        a = 1000.0
        y = (np.power(a, x) - 1.0) / (a - 1.0)
    elif scale == "sqrt":
        y = np.sqrt(x)
    elif scale == "squared":
        y = x * x
    elif scale == "asinh":
        a = 10.0
        y = np.arcsinh(a * x) / np.arcsinh(a)
    elif scale == "sinh":
        a = 3.0
        y = np.sinh(a * x) / np.sinh(a)
    elif scale == "histequ":
        y = _histequ(x)
    else:
        y = x

    y = np.nan_to_num(y, nan=0.0, posinf=1.0, neginf=0.0)
    return y.astype(np.float32, copy=False)


def _histequ(x: np.ndarray, bins: int = 1024) -> np.ndarray:
    flat = x.ravel()
    hist, edges = np.histogram(flat, bins=bins, range=(0.0, 1.0))
    cdf = hist.cumsum().astype(np.float64)
    if cdf[-1] == 0:
        return x
    cdf /= cdf[-1]
    idx = np.clip((flat * bins).astype(int), 0, bins - 1)
    return cdf[idx].reshape(x.shape).astype(np.float32)


# ----- colormaps ----------------------------------------------------------

_CMAP_CACHE: dict[str, np.ndarray] = {}


def _build_lut(name: str) -> np.ndarray:
    """Return (256, 3) uint8 LUT."""
    x = np.linspace(0.0, 1.0, 256, dtype=np.float32)
    if name == "grey":
        r = g = b = x
    elif name == "red":
        r, g, b = x, np.zeros_like(x), np.zeros_like(x)
    elif name == "green":
        r, g, b = np.zeros_like(x), x, np.zeros_like(x)
    elif name == "blue":
        r, g, b = np.zeros_like(x), np.zeros_like(x), x
    elif name == "heat":
        r = np.clip(x / 0.34, 0, 1)
        g = np.clip((x - 0.34) / 0.31, 0, 1)
        b = np.clip((x - 0.65) / 0.35, 0, 1)
    elif name == "cool":
        r = x
        g = 1.0 - x
        b = np.ones_like(x)
    elif name == "rainbow":
        # hue sweep from violet -> red
        h = (1.0 - x) * 0.75
        r, g, b = _hsv_to_rgb(h, np.ones_like(x), np.ones_like(x))
    elif name == "hsv":
        h = x
        r, g, b = _hsv_to_rgb(h, np.ones_like(x), np.ones_like(x))
    elif name == "bb":  # black body
        r = np.clip(x * 1.5, 0, 1)
        g = np.clip((x - 0.35) * 1.7, 0, 1)
        b = np.clip((x - 0.7) * 3.3, 0, 1)
    elif name == "he":  # H-alpha-ish: warm red-purple ramp
        r = np.clip(x * 1.4, 0, 1)
        g = np.clip((x - 0.4) * 1.2, 0, 1)
        b = np.clip((x - 0.2) * 1.4, 0, 1) * 0.6
    elif name == "a":
        # ds9 "A": red-yellow-green-cyan-blue sawtooths
        r = np.clip(np.abs(np.sin(x * np.pi * 2.0)), 0, 1)
        g = np.clip(np.abs(np.sin(x * np.pi * 2.0 + np.pi / 2)), 0, 1)
        b = np.clip(np.abs(np.sin(x * np.pi * 2.0 + np.pi)), 0, 1)
    elif name == "b":
        # ds9 "B": blue-cyan-green-yellow-red ramp
        r = np.clip((x - 0.25) * 4, 0, 1)
        g = np.clip(np.sin(x * np.pi), 0, 1)
        b = np.clip((0.75 - x) * 4, 0, 1)
    elif name == "sls":
        # SLS-like: dark->blue->cyan->green->yellow->red->white
        stops = np.array([
            [0.0, 0.0, 0.0, 0.0],
            [0.15, 0.0, 0.0, 0.5],
            [0.3, 0.0, 0.5, 1.0],
            [0.45, 0.0, 1.0, 0.5],
            [0.6, 1.0, 1.0, 0.0],
            [0.8, 1.0, 0.3, 0.0],
            [1.0, 1.0, 1.0, 1.0],
        ])
        r = np.interp(x, stops[:, 0], stops[:, 1])
        g = np.interp(x, stops[:, 0], stops[:, 2])
        b = np.interp(x, stops[:, 0], stops[:, 3])
    else:
        # matplotlib fallbacks (viridis, plasma, magma, cividis, ...)
        try:
            import matplotlib.cm as cm
            lut = cm.get_cmap(name)(x)[:, :3]
            r, g, b = lut[:, 0], lut[:, 1], lut[:, 2]
        except Exception:
            r = g = b = x
    rgb = np.stack([r, g, b], axis=1)
    rgb = (np.clip(rgb, 0, 1) * 255.0).astype(np.uint8)
    return rgb


def _hsv_to_rgb(h, s, v):
    i = np.floor(h * 6.0).astype(int) % 6
    f = h * 6.0 - np.floor(h * 6.0)
    p = v * (1.0 - s)
    q = v * (1.0 - f * s)
    t = v * (1.0 - (1.0 - f) * s)
    r = np.choose(i, [v, q, p, p, t, v])
    g = np.choose(i, [t, v, v, q, p, p])
    b = np.choose(i, [p, p, t, v, v, q])
    return r, g, b


def get_lut(name: str, invert: bool) -> np.ndarray:
    key = f"{name}:{invert}"
    lut = _CMAP_CACHE.get(key)
    if lut is None:
        base = _build_lut(name)
        if invert:
            base = base[::-1]
        lut = base
        _CMAP_CACHE[key] = lut
    return lut


def colorize(scaled: np.ndarray, cmap: str, invert: bool) -> np.ndarray:
    lut = get_lut(cmap, invert)
    idx = np.clip((scaled * 255.0).astype(np.int32), 0, 255)
    return lut[idx]


# ----- PNG encoding ------------------------------------------------------

def to_png(rgb: np.ndarray) -> bytes:
    from PIL import Image
    img = Image.fromarray(rgb, mode="RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG", compress_level=1)
    return buf.getvalue()


# ----- full render -------------------------------------------------------

def render_full(frame: FrameState) -> bytes:
    """Render full FITS image (no zoom/pan) as PNG bytes.

    The browser handles zoom/pan/rotate by transforming the PNG canvas;
    the server only recomputes when scale / cmap / data changes.
    """
    if frame.data is None:
        return b""
    scaled = apply_scale(frame.data, frame.scale, frame.vmin, frame.vmax)
    # flip Y so row 0 is at the bottom (FITS convention), matching DS9.
    scaled = scaled[::-1, :]
    rgb = colorize(scaled, frame.cmap, frame.invert)
    return to_png(rgb)


def pixel_value(frame: FrameState, ix: int, iy: int) -> Optional[float]:
    if frame.data is None:
        return None
    h, w = frame.data.shape
    if not (0 <= ix < w and 0 <= iy < h):
        return None
    v = frame.data[iy, ix]
    if not np.isfinite(v):
        return None
    return float(v)


def wcs_of(frame: FrameState, ix: float, iy: float):
    if frame.wcs is None:
        return None
    try:
        ra, dec = frame.wcs.wcs_pix2world([[ix, iy]], 0)[0]
        if not (np.isfinite(ra) and np.isfinite(dec)):
            return None
        return float(ra), float(dec)
    except Exception:
        return None


def stats(frame: FrameState) -> dict:
    if frame.data is None:
        return {}
    flat = frame.data[np.isfinite(frame.data)]
    if flat.size == 0:
        return {}
    return {
        "min": float(flat.min()),
        "max": float(flat.max()),
        "mean": float(flat.mean()),
        "median": float(np.median(flat)),
        "std": float(flat.std()),
        "npix": int(flat.size),
    }


def histogram(frame: FrameState, bins: int = 256) -> dict:
    if frame.data is None:
        return {"bins": [], "counts": []}
    flat = frame.data[np.isfinite(frame.data)]
    if flat.size == 0:
        return {"bins": [], "counts": []}
    counts, edges = np.histogram(flat, bins=bins)
    return {"bins": edges.tolist(), "counts": counts.tolist()}


def set_scale(frame: FrameState, scale: Optional[str] = None,
              limit_mode: Optional[str] = None,
              vmin: Optional[float] = None,
              vmax: Optional[float] = None) -> None:
    if scale is not None and scale in SCALE_FUNCS:
        frame.scale = scale
    if limit_mode is not None and limit_mode in SCALE_LIMIT_MODES:
        frame.limit_mode = limit_mode
        if limit_mode != "user" and frame.data is not None:
            frame.vmin, frame.vmax = compute_limits(frame.data, limit_mode)
    if vmin is not None:
        frame.vmin = float(vmin)
        frame.limit_mode = "user"
    if vmax is not None:
        frame.vmax = float(vmax)
        frame.limit_mode = "user"
