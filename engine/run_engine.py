"""PyInstaller entrypoint.

The packaged executable must import ``app`` as a package (``app.main`` uses
relative imports), so the build script uses this launcher instead of the
``app/main.py`` file as the frozen entrypoint.
"""

from app.main import main

if __name__ == "__main__":
    raise SystemExit(main())
