// The app's durable notification service owns all delivery when installed.
// Standalone harness consumers retain their existing legacy delivery path.
const owners = new Set<symbol>();
export function registerPermissionNotificationOwner(): () => void {
  const owner = Symbol('permission-notifications');
  owners.add(owner);
  return () => {
    owners.delete(owner);
  };
}
export function hasPermissionNotificationOwner(): boolean {
  return owners.size > 0;
}
