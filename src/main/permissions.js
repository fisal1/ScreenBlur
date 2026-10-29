const { dialog, shell, systemPreferences } = require('electron');

// macOS only: screen capture needs the Screen Recording permission. The first capture attempt
// makes macOS ask the user; access only takes effect after the app restarts.
const SCREEN_RECORDING_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

function hasScreenRecordingPermission() {
  return systemPreferences.getMediaAccessStatus('screen') === 'granted';
}

async function explainScreenRecordingPermission() {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: 'ScreenBlur needs permission to see your screen',
    detail:
      'Open System Settings > Privacy & Security > Screen Recording, turn on ScreenBlur, ' +
      'then quit and reopen ScreenBlur. Your screen is only analyzed on this Mac; nothing is sent anywhere.',
    buttons: ['Open System Settings', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) await shell.openExternal(SCREEN_RECORDING_SETTINGS_URL);
}

module.exports = { hasScreenRecordingPermission, explainScreenRecordingPermission };
