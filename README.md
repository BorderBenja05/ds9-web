# remote-ds9
Finally, a version of ds9 that doesn't feel like a vice-grip tooth extraction when working on remote systems!!

Launch [SAOImageDS9](https://sites.google.com/cfa.harvard.edu/saoimageds9) in the browser via [Xpra](https://xpra.org/).

## Requirements

- **ds9** must be on your `PATH`
- **xpra** with HTML5 client support

## Installation

```bash
cd ds9-web
pip install .
```

## Usage

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
