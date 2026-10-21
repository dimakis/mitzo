'use strict';

const path = require('node:path');
const filename = path.join(__dirname, 'build', 'Release', 'mitzo_sqlite_file_owner.node');
let native;
function binding() {
  return (native ??= require(filename));
}

exports.openLease = (filename) => binding().openLease(filename);
exports.lockLease = (handle, mode) => binding().lockLease(handle, mode);
exports.closeLease = (handle) => binding().closeLease(handle);
exports.leaseIdentity = (handle) => binding().leaseIdentity(handle);
exports.installCurrentFileProbe = (database) => {
  database.loadExtension(filename, 'sqlite3_mitzofileowner_init');
};
Object.freeze(module.exports);
