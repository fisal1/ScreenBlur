/**
 * Transparent overlay renderer. Hidden by default; the main process sends the
 * desired visibility, score, mode and a file:// URL for an optional GIF/image.
 * No remote content is loaded.
 */

import type { OverlayState } from '../shared/types';
import { regionsForBoxes } from '../shared/overlayRegion';

const overlay = document.getElementById('overlay');
const regionsHost = document.getElementById('regions');
const regionTemplate = document.getElementById('region-template') as HTMLTemplateElement | null;
const badgeScore = document.getElementById('badge-score');
const badgeTitle = document.getElementById('badge-title');

interface RegionView {
  element: HTMLElement;
  blurLayer: HTMLElement | null;
  gifLayer: HTMLElement | null;
  gifImage: HTMLImageElement | null;
  gifPlaceholder: HTMLElement | null;
  gifUrl: string;
}

const regionViews: RegionView[] = [];

function setHidden(element: HTMLElement | null, hidden: boolean): void {
  if (!element) return;
  element.hidden = hidden;
}

function showPlaceholder(view: RegionView): void {
  setHidden(view.gifImage, true);
  setHidden(view.gifPlaceholder, false);
}

function applyGif(view: RegionView, url: string): void {
  const image = view.gifImage;
  if (!image) {
    showPlaceholder(view);
    return;
  }

  if (!url) {
    view.gifUrl = '';
    image.removeAttribute('src');
    showPlaceholder(view);
    return;
  }

  if (url !== view.gifUrl) {
    view.gifUrl = url;
    image.onload = (): void => {
      if (view.gifUrl !== url) return;
      setHidden(image, false);
      setHidden(view.gifPlaceholder, true);
    };
    image.onerror = (): void => {
      if (view.gifUrl !== url) return;
      showPlaceholder(view);
    };
    image.src = url;
    return;
  }

  if (image.complete && image.naturalWidth > 0) {
    setHidden(image, false);
    setHidden(view.gifPlaceholder, true);
  } else {
    showPlaceholder(view);
  }
}

function createRegionView(): RegionView | null {
  if (!regionsHost || !regionTemplate) return null;
  const fragment = regionTemplate.content.cloneNode(true) as DocumentFragment;
  const element = fragment.querySelector('.region') as HTMLElement | null;
  if (!element) return null;
  regionsHost.appendChild(fragment);
  return {
    element,
    blurLayer: element.querySelector('.blur-layer'),
    gifLayer: element.querySelector('.gif-layer'),
    gifImage: element.querySelector('.gif-image'),
    gifPlaceholder: element.querySelector('.gif-placeholder'),
    gifUrl: '',
  };
}

function ensureRegionViews(count: number): void {
  while (regionViews.length < count) {
    const view = createRegionView();
    if (!view) return;
    regionViews.push(view);
  }
}

function applyState(state: OverlayState): void {
  if (!overlay) return;

  overlay.classList.toggle('visible', state.visible);
  overlay.setAttribute('aria-hidden', state.visible ? 'false' : 'true');

  const detected = regionsForBoxes(state.boxes);
  const layout = detected.length
    ? detected.map((region) => ({ ...region, partial: true }))
    : [{ x: 0, y: 0, w: 1, h: 1, partial: false }];
  ensureRegionViews(layout.length);

  const mode = state.mode === 'gif' ? 'gif' : 'blur';
  regionViews.forEach((view, index) => {
    const region = layout[index];
    if (!region) {
      view.element.hidden = true;
      return;
    }

    view.element.hidden = false;
    view.element.classList.toggle('partial', region.partial);
    view.element.style.left = `${region.x * 100}%`;
    view.element.style.top = `${region.y * 100}%`;
    view.element.style.width = `${region.w * 100}%`;
    view.element.style.height = `${region.h * 100}%`;

    setHidden(view.blurLayer, mode !== 'blur');
    setHidden(view.gifLayer, mode !== 'gif');
    if (mode === 'gif') {
      applyGif(view, state.gifUrl);
    } else {
      setHidden(view.gifImage, true);
      setHidden(view.gifPlaceholder, true);
    }
  });

  if (badgeTitle) badgeTitle.textContent = 'Content hidden';

  if (badgeScore) {
    const percent = Math.round(Math.max(0, Math.min(1, state.score)) * 100);
    badgeScore.textContent = state.visible ? `${percent}% confidence` : '';
  }
}

window.overlayBridge.onState(applyState);

// Keep the initial DOM state explicitly hidden, then announce readiness.
if (overlay) {
  overlay.classList.remove('visible');
  overlay.setAttribute('aria-hidden', 'true');
}
window.overlayBridge.ready();
