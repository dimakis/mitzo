/** Initial ordinary-to-fresh-native installation sequencing. The actual source
 * adapter supplies its own physical observations/guard. A completed parent
 * installation is not native MAC, capacity, enrollment or child custody. */
export async function installContainedNativeRegistration(effects) {
  // Deliberately before any guard or ordinary control. A missing model/native
  // implementation cannot stop the currently owned ordinary stage.
  await effects.preflight();
  await effects.acquireOriginalGuard();
  let shutdownAttempted = false,
    parentReleased = false;
  try {
    await effects.verifyOriginalOrdinary();
    shutdownAttempted = true;
    await effects.stopOriginalOrdinary();
    await effects.verifyOriginalStopped();
    await effects.preserveOrdinaryInputs();
    await effects.installStoppedNativeRegistration();
    await effects.verifyStoppedNativeRegistration();
    await effects.recordCompletedInstallation();
    await effects.releaseOwnInstallationGuard();
    parentReleased = true;
    await effects.startOriginalNativeLauncherOnce();
    await effects.observeOriginalNativeLauncher();
  } catch (error) {
    await effects.retainInstallationEvidence({ shutdownAttempted, parentReleased });
    throw error;
  }
}
