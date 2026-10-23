'use strict';

const path = require('node:path');
const filename = path.join(__dirname, 'build', 'Release', 'mitzo_sqlite_file_owner.node');
let native;
function binding() {
  return (native ??= require(filename));
}

exports.assertLeaseAdmission = () => binding().assertLeaseAdmission();
exports.reserveFamily = () => binding().reserveFamily();
exports.openReservedLease = (reservation, filename) =>
  binding().openReservedLease(reservation, filename);
exports.openLease = (filename) => {
  const handle = binding().reserveFamily();
  try {
    binding().openReservedLease(handle, filename);
    return handle;
  } catch (error) {
    try {
      binding().closeLease(handle);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Lease opening and cleanup failed', {
        cause: cleanupError,
      });
    }
    throw error;
  }
};
exports.retainUnqualifiedConnection = () => Object.freeze(binding().retainUnqualifiedConnection());
exports.releaseUnqualifiedConnection = (handle) => binding().releaseUnqualifiedConnection(handle);
exports.lockLease = (handle, mode) => binding().lockLease(handle, mode);
exports.closeLease = (handle) => binding().closeLease(handle);
exports.leaseIdentity = (handle) => binding().leaseIdentity(handle);
exports.installCurrentFileProbe = (database) => {
  database.loadExtension(filename, 'sqlite3_mitzofileowner_init');
};
Object.freeze(module.exports);
