/**
 * Transparent overlay renderer. Hidden by default; the main process sends the
 * desired visibility, score, mode and a file:// URL for an optional GIF/image.
 * No remote content is loaded.
 */

import type { OverlayState } from '../shared/types';
import { regionForBoxes } from '../shared/overlayRegion';

const overlay = document.getElementById('overlay');
const region = document.getElementById('region');
const blurLayer = document.getElementById('blur-layer');
const gifLayer = document.getElementById('gif-layer');
const gifImage = document.getElementById('gif-image') as HTMLImageElement | null;
const gifPlaceholder = document.getElementById('gif-placeholder');
const badgeScore = document.getElementById('badge-score');
const badgeTitle = document.getElementById('badge-title');

let currentGifUrl = '';

function setHidden(element: HTMLElement | null, hidden: boolean): void {
  if (!element) return;
  element.hidden = hidden;
}

function showPlaceholder(): void {
  setHidden(gifImage, true);
  setHidden(gifPlaceholder, false);
}

function applyGif(url: string): void {
  const image = gifImage;
  if (!image) {
    showPlaceholder();
    return;
  }

  if (!url) {
    currentGifUrl = '';
    image.removeAttribute('src');
    showPlaceholder();
    return;
  }

  if (url !== currentGifUrl) {
    currentGifUrl = url;
    image.onload = (): void => {
      setHidden(image, false);
      setHidden(gifPlaceholder, true);
    };
    image.onerror = (): void => {
      showPlaceholder();
    };
    image.src = url;
    return;
  }

  if (image.complete && image.naturalWidth > 0) {
    setHidden(image, false);
    setHidden(gifPlaceholder, true);
  } else {
    showPlaceholder();
  }
}

function applyState(state: OverlayState): void {
  if (!overlay) return;

  overlay.classList.toggle('visible', state.visible);
  overlay.setAttribute('aria-hidden', state.visible ? 'false' : 'true');

  if (region) {
    const detected = regionForBoxes(state.boxes);
    if (detected) {
      region.classList.add('partial');
      region.style.left = `${detected.x * 100}%`;
      region.style.top = `${detected.y * 100}%`;
      region.style.width = `${detected.w * 100}%`;
      region.style.height = `${detected.h * 100}%`;
    } else {
      region.classList.remove('partial');
      region.style.left = '0';
      region.style.top = '0';
      region.style.width = '100%';
      region.style.height = '100%';
    }
  }

  const mode = state.mode === 'gif' ? 'gif' : 'blur';
  setHidden(blurLayer, mode !== 'blur');
  setHidden(gifLayer, mode !== 'gif');

  if (mode === 'gif') {
    applyGif(state.gifUrl);
    if (badgeTitle) badgeTitle.textContent = 'Content hidden';
  } else if (badgeTitle) {
    badgeTitle.textContent = 'Content hidden';
  }

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
