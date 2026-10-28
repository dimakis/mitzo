/** Inert transport for actual-store and mounted-composer metadata regressions. */
export const metadataConnection = {
  listener: (_event: Record<string, unknown>) => {},
  id: 'metadata-connection',
};
export class MetadataTestConnection {
  onMessage(listener: typeof metadataConnection.listener) {
    metadataConnection.listener = listener;
  }
  connect() {}
  disconnect() {}
  getConnectionId() {
    return metadataConnection.id;
  }
  isConnected() {
    return true;
  }
  send() {
    return true;
  }
  getLastSeq() {
    return 0;
  }
  trackSeq() {}
  commitTranscriptCursor() {}
  acknowledgeReconnectSnapshot() {}
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
