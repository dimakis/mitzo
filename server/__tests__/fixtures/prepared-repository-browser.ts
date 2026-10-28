/** Inert browser connection shared by server-only and rendered offline journeys. */
export const preparedRepositoryBrowser = {
  id: '',
  listener: (_event: Record<string, unknown>) => {},
};
export class PreparedRepositorySseConnection {
  onMessage(listener: typeof preparedRepositoryBrowser.listener) {
    preparedRepositoryBrowser.listener = listener;
  }
  connect() {}
  getConnectionId() {
    return preparedRepositoryBrowser.id;
  }
  isConnected() {
    return !!preparedRepositoryBrowser.id;
  }
  send() {
    return true;
  }
  getLastSeq() {
    return 0;
  }
  trackSeq() {}
  commitTranscriptCursor() {}
  getTrackedSessions() {
    return [];
  }
  clearSession() {}
  clearPendingSends() {}
  advanceSendScope() {}
  blockAuthentication() {}
  invalidateAuthentication() {}
  restoreAuthentication() {}
  checkAndReconnect() {}
  sendSuspend() {}
}
