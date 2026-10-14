const { Writable } = require('node:stream');
module.exports = function () {
  return new Writable({
    write(_chunk, _encoding, done) {
      done(Object.assign(new Error('private fixture path'), { code: 'ENOSPC' }));
    },
  });
};
