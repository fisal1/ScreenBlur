/**
 * True if `win` exists and hasn't been destroyed. Electron destroys windows on quit and on
 * relaunch, and touching a destroyed window throws "Object has been destroyed".
 */
function isAlive(win) {
  return Boolean(win) && !win.isDestroyed();
}

module.exports = { isAlive };
