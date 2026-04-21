# remote-ds9
Finally, a version of ds9 that doesn't feel like a vice-grip tooth extraction when working on remote systems!!

Two flavors are shipped from this repo:

1. **`ds9-web`** — launches the real [SAOImageDS9](https://sites.google.com/cfa.harvard.edu/saoimageds9) and forwards its X11 window to the browser via [Xpra](https://xpra.org/). Requires `ds9` and `xpra` on the host.
2. **`ds9-http`** — a pure-HTTP, browser-native re-implementation of DS9's UI. No X11, no Xpra, no `ds9` binary required. Port-forward friendly — everything moves over plain HTTP.

## `ds9-web` (Xpra-backed)

### Requirements

- **ds9** must be on your `PATH`
- **xpra** with HTML5 client support

### Installation

```bash
cd ds9-web
pip install .
```

### Usage

```bash
# Open a FITS file in the browser (default http://localhost:10000)
ds9-web -zscale /path/to/image.fits

# Custom port
ds9-web --port 8080 -zscale /path/to/image.fits

# All standard ds9 arguments work
ds9-web -scale log -cmap heat /path/to/image.fits

# Bind to all interfaces (e.g. for remote access)
ds9-web --bind 0.0.0.0 --port 8080 /path/to/image.fits
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | 10000 | TCP port for the web client |
| `--display` | 100 | X display number for Xpra |
| `--bind` | 127.0.0.1 | Address to bind to |
| `--no-stop` | off | Don't stop an existing Xpra session first |

All other arguments are forwarded directly to ds9.

## `ds9-http` (pure browser, no X11)

A ground-up DS9 clone. The server loads a FITS file with `astropy`, renders the
pixels to PNG with the current scale + colormap, and serves a JSON REST API.
The browser reproduces the DS9 UI — menu bar, info panel, two-row button bar,
panner/magnifier/colorbar strip, main canvas — over plain HTTP. Works
transparently through `ssh -L`, `kubectl port-forward`, Cloudflare tunnels, etc.

### Installation

```bash
cd ds9-web
pip install '.[http]'
```

This pulls in `astropy`, `numpy`, `Pillow`, and `matplotlib`.

### Usage

```bash
# Open a FITS file (default http://127.0.0.1:10000)
ds9-http -zscale /path/to/image.fits

# Bind to all interfaces for port-forwarding
ds9-http --bind 0.0.0.0 --port 8080 /path/to/image.fits

# DS9-style flags seed the initial view
ds9-http -scale log -cmap heat -invert /path/to/image.fits
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | 10000 | TCP port for the web client |
| `--bind` | 127.0.0.1 | Address to bind to |
| `-scale` | linear | Initial scale function |
| `-zscale` / `-minmax` | off | Initial scale-limit mode |
| `-cmap` | grey | Initial colormap |
| `-invert` | off | Invert the colormap |

### Features

- **File**: open, header viewer, save-as-PNG, close
- **Edit**: region / crosshair / pan / zoom modes
- **Zoom**: in/out, fit, 1/2/4/8/16/1/2/1/4, rotate, align
- **Scale**: linear, log, power, sqrt, squared, asinh, sinh, histequ + minmax, zscale, 99.5/99/98/97/95/90%
- **Color**: grey/red/green/blue/a/b/bb/he/heat/cool/rainbow/sls/hsv/viridis/plasma/magma, invert
- **Region**: circle/box/ellipse/point/polygon, list, delete all
- **WCS**: FK5/ICRS/Galactic readout, sexagesimal or degrees
- **Analysis**: statistics, histogram
- **Panner** and **magnifier** panels, live pixel-value readout, WCS coord readout

### REST API

All endpoints return JSON unless noted:

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/state` | full frame state (file, view, scale, cmap, regions, ...) |
| GET  | `/api/image` | current rendered PNG (scale + cmap baked in) |
| GET  | `/api/pixel?x=..&y=..` | pixel value + WCS at image coords |
| GET  | `/api/header` | FITS header as JSON |
| GET  | `/api/stats` | min/max/mean/median/std |
| GET  | `/api/histogram?bins=256` | histogram bins + counts |
| GET  / POST | `/api/regions` | region list / `{action: add|set|clear|delete}` |
| POST | `/api/load`  | `{path: "/path/to.fits"}` |
| POST | `/api/scale` | `{scale, limit_mode, vmin, vmax}` |
| POST | `/api/cmap`  | `{cmap, invert}` |
| POST | `/api/view`  | `{zoom, pan_x, pan_y, rotate}` |
