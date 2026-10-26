'use strict';

const dismissHotkey = new URLSearchParams(window.location.search).get('dismiss');
if (dismissHotkey) {
  document.getElementById('dismiss-hotkey').textContent = dismissHotkey.replace('Control', 'Ctrl');
}
