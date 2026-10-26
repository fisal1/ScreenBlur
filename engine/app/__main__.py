"""Allow ``python -m app`` from the engine directory."""

from .main import main

if __name__ == "__main__":
    raise SystemExit(main())
