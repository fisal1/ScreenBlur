# ScreenBlur developer tasks

PYTHON ?= python3
ENGINE_DIR := engine
DESKTOP_DIR := desktop

.PHONY: help setup engine-setup desktop-setup engine dev desktop test smoke lint build clean

help:
	@echo "make setup        Install engine + desktop dependencies"
	@echo "make engine       Run the FastAPI sidecar on port 8000"
	@echo "make desktop      Run the Electron app in dev mode"
	@echo "make test         Run engine and desktop test suites"
	@echo "make smoke        End-to-end engine protocol smoke test"
	@echo "make build        Build sidecar binary and desktop bundles"
	@echo "make clean        Remove generated build artifacts"

setup: engine-setup desktop-setup

engine-setup:
	cd $(ENGINE_DIR) && $(PYTHON) -m venv .venv && .venv/bin/pip install -U pip && .venv/bin/pip install -r requirements-dev.txt

desktop-setup:
	cd $(DESKTOP_DIR) && npm install

engine:
	cd $(ENGINE_DIR) && .venv/bin/python -m app.main --port 8000

desktop:
	cd $(DESKTOP_DIR) && npm run dev

test:
	cd $(ENGINE_DIR) && .venv/bin/pytest -q
	cd $(DESKTOP_DIR) && npm test

smoke:
	node scripts/smoke-engine.mjs

build:
	cd $(ENGINE_DIR) && ./scripts/build-engine.sh
	cd $(DESKTOP_DIR) && npm run package

clean:
	rm -rf $(ENGINE_DIR)/build $(ENGINE_DIR)/dist $(DESKTOP_DIR)/dist $(DESKTOP_DIR)/dist-electron $(DESKTOP_DIR)/release
